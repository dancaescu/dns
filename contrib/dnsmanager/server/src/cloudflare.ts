import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { execute, query, withTransaction } from "./db.js";

interface CloudflareConfig {
  baseUrl: string;
  email?: string;
  apiKey?: string;
  apiToken?: string;
}

interface ZoneRow {
  id: number;
  cf_zone_id: string;
  cf_account_id: string;
}

const CONFIG_PATH = process.env.CLOUDFLARE_CONFIG || "/etc/mydns/cloudflare.ini";
let cachedConfig: CloudflareConfig | null = null;

function parseIni(filePath: string): Record<string, string> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cloudflare config not found at ${resolved}`);
  }
  const content = fs.readFileSync(resolved, "utf-8");
  const data: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const line = trimmed.split("#", 1)[0];
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"+|"+$/g, "");
    data[key] = value;
  }
  return data;
}

function loadConfig(): CloudflareConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  const entries = parseIni(CONFIG_PATH);
  const apiBase = entries["api"] ? entries["api"].replace(/\/+$/, "") : "https://api.cloudflare.com/client/v4";
  const apiToken = entries["api_token"];
  const email = entries["email"];
  const apiKey = entries["api_key"];
  if (!apiToken && (!email || !apiKey)) {
    throw new Error("Incomplete Cloudflare credentials");
  }
  cachedConfig = {
    baseUrl: apiBase,
    email,
    apiKey,
    apiToken,
  };
  return cachedConfig;
}

function sanitizePayload(payload: Record<string, any> | undefined) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

async function cfRequest(method: string, endpoint: string, body?: any, params?: Record<string, string | number>) {
  const config = loadConfig();
  const base = config.baseUrl.replace(/\/?$/, "/");
  const url = new URL(endpoint.replace(/^\/+/, ""), base);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "mydns-ng/1.2 (+https://github.com/dancaescu/mydns-oj)",
  };
  if (config.apiToken) {
    headers["Authorization"] = `Bearer ${config.apiToken}`;
  } else if (config.email && config.apiKey) {
    headers["X-Auth-Email"] = config.email;
    headers["X-Auth-Key"] = config.apiKey;
  }
  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(sanitizePayload(body) ?? {}) : undefined,
  });
  const text = await response.text();
  if (!text.trim()) {
    if (response.ok) {
      return { success: true, result: null };
    }
    throw new Error(`Cloudflare HTTP ${response.status} with empty response body`);
  }
  let decoded: any;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cloudflare invalid response (status ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || decoded?.success === false) {
    const message = decoded?.errors ? JSON.stringify(decoded.errors) : text;
    throw new Error(`Cloudflare API error ${response.status}: ${message}`);
  }
  return decoded;
}

async function paginatedGet(path: string, perPage = 100) {
  const results: any[] = [];
  let page = 1;
  while (true) {
    const decoded = await cfRequest("GET", path, undefined, { per_page: perPage, page });
    const batch = decoded?.result ?? [];
    results.push(...batch);
    const info = decoded?.result_info;
    if (!info || !info.total_pages || page >= info.total_pages) {
      break;
    }
    page += 1;
  }
  return results;
}

async function fetchZoneRow(localZoneId: number): Promise<ZoneRow> {
  const [rows] = await query<ZoneRow>(
    `SELECT z.id, z.cf_zone_id, a.cf_account_id
     FROM cloudflare_zones z
     LEFT JOIN cloudflare_accounts a ON a.id = z.account_id
     WHERE z.id = ?`,
    [localZoneId],
  );
  if (!rows.length) {
    throw new Error("Zone not found");
  }
  if (!rows[0].cf_zone_id) {
    throw new Error("Zone missing Cloudflare zone id");
  }
  return rows[0];
}

export type SyncMode = "pull-clean" | "pull-keep" | "pull-push";

export async function syncZone(localZoneId: number, mode: SyncMode = "pull-clean") {
  const zone = await fetchZoneRow(localZoneId);
  const records = await paginatedGet(`/zones/${zone.cf_zone_id}/dns_records`, 100);
  const lbs = await paginatedGet(`/zones/${zone.cf_zone_id}/load_balancers`, 50);

  let pushedRecords = 0;

  await withTransaction(async (conn) => {
    // Build a map of Cloudflare record IDs for quick lookup
    const cfRecordIds = new Set(records.map((r: any) => r.id));

    if (mode === "pull-push") {
      // Find local records not in Cloudflare and push them
      const [localRecords] = await conn.query<any>(
        `SELECT id, cf_record_id, record_type, name, content, ttl, proxied, priority, comment, tags
         FROM cloudflare_records
         WHERE zone_id = ?`,
        [localZoneId],
      );

      for (const localRecord of localRecords) {
        // Skip if already in Cloudflare or is an offline record
        if (localRecord.cf_record_id && !localRecord.cf_record_id.startsWith("offline-")) {
          if (cfRecordIds.has(localRecord.cf_record_id)) {
            continue;
          }
        }

        // Push this local-only record to Cloudflare
        try {
          const cfResponse = await cloudflareCreateDnsRecord(localZoneId, {
            type: localRecord.record_type,
            name: localRecord.name,
            content: localRecord.content,
            ttl: localRecord.ttl,
            proxied: localRecord.proxied ? Boolean(localRecord.proxied) : undefined,
            priority: localRecord.priority ?? undefined,
            comment: localRecord.comment ?? undefined,
            tags: localRecord.tags ? localRecord.tags.split(",").map((t: string) => t.trim()).filter((t: string) => t) : undefined,
          });
          pushedRecords++;

          // Update the local record with the new Cloudflare ID
          if (cfResponse?.result?.id) {
            await conn.execute(
              "UPDATE cloudflare_records SET cf_record_id = ?, updated_at = NOW() WHERE id = ?",
              [cfResponse.result.id, localRecord.id],
            );
          }
        } catch (error) {
          console.error(`Failed to push record ${localRecord.name}:`, error);
        }
      }
    }

    if (mode === "pull-clean") {
      // Delete all local records and replace with Cloudflare records
      await conn.execute("DELETE FROM cloudflare_records WHERE zone_id = ?", [localZoneId]);
    } else if (mode === "pull-keep" || mode === "pull-push") {
      // Delete only records that exist in Cloudflare (we'll re-insert them)
      const cfIds = records.map((r: any) => r.id);
      if (cfIds.length > 0) {
        const placeholders = cfIds.map(() => "?").join(",");
        await conn.execute(
          `DELETE FROM cloudflare_records WHERE zone_id = ? AND cf_record_id IN (${placeholders})`,
          [localZoneId, ...cfIds],
        );
      }
    }

    // Insert/update records from Cloudflare
    for (const record of records) {
      const tags = Array.isArray(record.tags) ? record.tags.join(",") : null;
      await conn.execute(
        `INSERT INTO cloudflare_records
          (zone_id, cf_record_id, record_type, name, content, ttl, proxied, priority, data, modified_on, comment, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localZoneId,
          record.id,
          record.type,
          record.name,
          record.content,
          record.ttl,
          typeof record.proxied === "boolean" ? (record.proxied ? 1 : 0) : null,
          record.priority ?? null,
          JSON.stringify(record),
          record.modified_on ? new Date(record.modified_on) : null,
          record.comment ?? null,
          tags,
        ],
      );
    }

    // Handle load balancers (always replace)
    await conn.execute("DELETE FROM cloudflare_load_balancers WHERE zone_id = ?", [localZoneId]);

    // Get the account_id for fetching pool details
    const [zoneAccountRows] = await conn.query<{ cf_account_id: string }>(
      `SELECT a.cf_account_id
       FROM cloudflare_zones z
       JOIN cloudflare_accounts a ON a.id = z.account_id
       WHERE z.id = ?`,
      [localZoneId]
    );
    const cfAccountId = zoneAccountRows[0]?.cf_account_id;

    for (const lb of lbs) {
      const [lbResult] = await conn.execute(
        `INSERT INTO cloudflare_load_balancers
          (zone_id, cf_lb_id, name, proxied, enabled, fallback_pool, default_pools, steering_policy, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localZoneId,
          lb.id,
          lb.name,
          typeof lb.proxied === "boolean" ? (lb.proxied ? 1 : 0) : null,
          typeof lb.enabled === "boolean" ? (lb.enabled ? 1 : 0) : null,
          lb.fallback_pool ?? null,
          lb.default_pools ? JSON.stringify(lb.default_pools) : null,
          lb.steering_policy ?? null,
          JSON.stringify(lb),
        ],
      );

      const lbId = (lbResult as any).insertId;

      // Sync pools for this load balancer
      if (cfAccountId && lb.default_pools && Array.isArray(lb.default_pools)) {
        for (const cfPoolId of lb.default_pools) {
          try {
            const poolResponse = await cloudflareGetPool(cfAccountId, cfPoolId);
            const pool = poolResponse.result;

            if (!pool) continue;

            // Insert pool
            const [poolResult] = await conn.execute(
              `INSERT INTO cloudflare_lb_pools
                (lb_id, cf_pool_id, name, description, enabled, minimum_origins, monitor,
                 notification_email, notification_enabled, notification_health_status,
                 health_check_regions, latitude, longitude, load_shedding_default_percent,
                 load_shedding_default_policy, load_shedding_session_percent,
                 load_shedding_session_policy, origin_steering_policy)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                lbId,
                cfPoolId,
                pool.name ?? '',
                pool.description ?? null,
                typeof pool.enabled === "boolean" ? (pool.enabled ? 1 : 0) : 1,
                pool.minimum_origins ?? 1,
                pool.monitor ?? null,
                pool.notification_email ?? null,
                pool.notification_email ? 1 : 0,
                pool.notification_health_status || 'either',
                pool.check_regions ? JSON.stringify(pool.check_regions) : null,
                pool.latitude ?? null,
                pool.longitude ?? null,
                pool.load_shedding?.default_percent ?? 0,
                pool.load_shedding?.default_policy ?? 'random',
                pool.load_shedding?.session_percent ?? 0,
                pool.load_shedding?.session_policy ?? 'hash',
                pool.origin_steering?.policy ?? 'random',
              ],
            );

            const poolId = (poolResult as any).insertId;

            // Insert origins for this pool
            if (pool.origins && Array.isArray(pool.origins)) {
              for (const origin of pool.origins) {
                await conn.execute(
                  `INSERT INTO cloudflare_lb_pool_origins
                    (pool_id, name, address, enabled, weight, port, header_host, header_origin, virtual_network_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    poolId,
                    origin.name ?? '',
                    origin.address ?? '',
                    typeof origin.enabled === "boolean" ? (origin.enabled ? 1 : 0) : 1,
                    origin.weight ?? 1,
                    origin.port ?? null,
                    origin.header?.Host?.[0] ?? null,
                    origin.header?.Origin?.[0] ?? null,
                    origin.virtual_network_id ?? null,
                  ],
                );
              }
            }
          } catch (error) {
            console.error(`Failed to sync pool ${cfPoolId}:`, error);
            // Continue with other pools even if one fails
          }
        }
      }
    }
  });

  await execute("UPDATE cloudflare_zones SET last_synced = NOW(), updated_at = NOW() WHERE id = ?", [localZoneId]);

  return { records: records.length, load_balancers: lbs.length, pushed: pushedRecords };
}

export async function cloudflareCreateDnsRecord(localZoneId: number, payload: any) {
  const zone = await fetchZoneRow(localZoneId);
  return cfRequest("POST", `/zones/${zone.cf_zone_id}/dns_records`, payload);
}

export async function cloudflareUpdateDnsRecord(localZoneId: number, cfRecordId: string, payload: any) {
  const zone = await fetchZoneRow(localZoneId);
  return cfRequest("PUT", `/zones/${zone.cf_zone_id}/dns_records/${cfRecordId}`, payload);
}

export async function cloudflareDeleteDnsRecord(localZoneId: number, cfRecordId: string) {
  const zone = await fetchZoneRow(localZoneId);
  return cfRequest("DELETE", `/zones/${zone.cf_zone_id}/dns_records/${cfRecordId}`);
}

export async function cloudflareCreateLoadBalancer(localZoneId: number, payload: any) {
  const zone = await fetchZoneRow(localZoneId);
  return cfRequest("POST", `/zones/${zone.cf_zone_id}/load_balancers`, payload);
}

export async function cloudflareUpdateLoadBalancer(localZoneId: number, cfLbId: string, payload: any) {
  const zone = await fetchZoneRow(localZoneId);
  return cfRequest("PUT", `/zones/${zone.cf_zone_id}/load_balancers/${cfLbId}`, payload);
}

export async function cloudflareDeleteLoadBalancer(localZoneId: number, cfLbId: string) {
  const zone = await fetchZoneRow(localZoneId);
  return cfRequest("DELETE", `/zones/${zone.cf_zone_id}/load_balancers/${cfLbId}`);
}

export async function cloudflarePurgeCache(localZoneId: number) {
  const zone = await fetchZoneRow(localZoneId);
  return cfRequest("POST", `/zones/${zone.cf_zone_id}/purge_cache`, { purge_everything: true });
}

export async function cloudflareGetPoolHealth(cfAccountId: string, cfPoolId: string) {
  return cfRequest("GET", `/accounts/${cfAccountId}/load_balancers/pools/${cfPoolId}/health`);
}

export async function cloudflareListPools(cfAccountId: string) {
  return cfRequest("GET", `/accounts/${cfAccountId}/load_balancers/pools`);
}

export async function cloudflareGetPool(cfAccountId: string, cfPoolId: string) {
  return cfRequest("GET", `/accounts/${cfAccountId}/load_balancers/pools/${cfPoolId}`);
}

/**
 * Create a new zone in Cloudflare
 * @param cfAccountId - Cloudflare account ID
 * @param zoneName - Domain name for the zone
 * @param jumpStart - Whether to scan for existing DNS records
 * @param type - Zone type (full or partial)
 */
export async function cloudflareCreateZone(
  cfAccountId: string,
  zoneName: string,
  jumpStart = false,
  type: "full" | "partial" = "full"
) {
  const payload = {
    name: zoneName,
    account: { id: cfAccountId },
    jump_start: jumpStart,
    type: type,
  };
  return cfRequest("POST", "/zones", payload);
}
