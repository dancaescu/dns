import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";
import {
  cloudflareCreateDnsRecord,
  cloudflareDeleteDnsRecord,
  cloudflareUpdateDnsRecord,
  cloudflareCreateLoadBalancer,
  cloudflareUpdateLoadBalancer,
  cloudflareDeleteLoadBalancer,
  cloudflarePurgeCache,
  cloudflareGetPoolHealth,
  cloudflareCreateZone,
  syncZone,
} from "../cloudflare.js";

const router = Router();
router.use(authenticate);

router.get("/accounts", async (_req, res) => {
  const [rows] = await query(
    "SELECT id, cf_account_id, name, created_at, updated_at FROM cloudflare_accounts ORDER BY name ASC",
  );
  res.json(rows);
});

const createZoneSchema = z.object({
  account_id: z.number(),
  zone_name: z.string().min(1),
  jump_start: z.boolean().default(false),
  zone_type: z.enum(["full", "partial"]).default("full"),
});

router.post("/zones", async (req, res) => {
  const parsed = createZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  try {
    // Get the Cloudflare account ID
    const [accounts] = await query<{ cf_account_id: string }>(
      "SELECT cf_account_id FROM cloudflare_accounts WHERE id = ?",
      [parsed.data.account_id]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ message: "Account not found" });
    }

    const cfAccountId = accounts[0].cf_account_id;

    // Create zone in Cloudflare
    const response = await cloudflareCreateZone(
      cfAccountId,
      parsed.data.zone_name,
      parsed.data.jump_start,
      parsed.data.zone_type
    );

    if (!response.success || !response.result) {
      return res.status(500).json({
        message: "Failed to create zone in Cloudflare",
        errors: response.errors || [],
      });
    }

    const cfZone = response.result;

    // Save zone to database
    const result = await execute(
      `INSERT INTO cloudflare_zones
       (account_id, cf_zone_id, name, status, paused, zone_type, plan_name, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        parsed.data.account_id,
        cfZone.id,
        cfZone.name,
        cfZone.status,
        cfZone.paused ? 1 : 0,
        cfZone.type || null,
        cfZone.plan?.name || null,
      ]
    );

    res.status(201).json({
      success: true,
      zone_id: result.insertId,
      cf_zone_id: cfZone.id,
      name: cfZone.name,
      status: cfZone.status,
      name_servers: cfZone.name_servers,
    });
  } catch (error) {
    console.error("Create zone error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/zones/:id", async (req, res) => {
  const zoneId = Number(req.params.id);
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "Invalid zone id" });
  }
  const [rows] = await query(
    `SELECT z.*, a.name AS account_name, a.cf_account_id
     FROM cloudflare_zones z
     LEFT JOIN cloudflare_accounts a ON a.id = z.account_id
     WHERE z.id = ?`,
    [zoneId],
  );
  if (!rows.length) {
    return res.status(404).json({ message: "Zone not found" });
  }
  res.json(rows[0]);
});

router.get("/zones", async (req, res) => {
  const accountId = req.query.account_id ? Number(req.query.account_id) : null;
  const search =
    typeof req.query.search === "string" && req.query.search.trim().length > 0
      ? `%${req.query.search.trim()}%`
      : null;
  let sql =
    "SELECT z.id, z.account_id, z.cf_zone_id, z.name, z.status, z.paused, z.zone_type, z.plan_name, z.last_synced, z.favorite, a.name AS account_name " +
    "FROM cloudflare_zones z LEFT JOIN cloudflare_accounts a ON a.id = z.account_id";
  const params: unknown[] = [];
  const where: string[] = [];
  if (accountId) {
    where.push("z.account_id = ?");
    params.push(accountId);
  }
  if (search) {
    where.push("(z.name LIKE ? OR a.name LIKE ?)");
    params.push(search, search);
  }
  if (where.length) {
    sql += " WHERE " + where.join(" AND ");
  }
  sql += " ORDER BY z.favorite DESC, a.name ASC, z.name ASC";
  const [rows] = await query(sql, params);
  res.json(rows);
});

router.get("/zones/:id/records", async (req, res) => {
  const [rows] = await query(
    `SELECT id, cf_record_id, record_type, name, content, ttl, proxied, priority, modified_on, comment, tags
     FROM cloudflare_records WHERE zone_id = ? ORDER BY record_type, name`,
    [req.params.id],
  );
  res.json(rows);
});

router.get("/zones/:id/load-balancers", async (req, res) => {
  const [rows] = await query(
    `SELECT lb.id, lb.cf_lb_id, lb.name, lb.proxied, lb.enabled, lb.fallback_pool,
            lb.default_pools, lb.steering_policy, COUNT(p.id) as pool_count
     FROM cloudflare_load_balancers lb
     LEFT JOIN cloudflare_lb_pools p ON p.lb_id = lb.id
     WHERE lb.zone_id = ?
     GROUP BY lb.id
     ORDER BY lb.name`,
    [req.params.id],
  );
  res.json(rows);
});

router.post("/zones/:id/sync", async (req, res) => {
  const zoneId = Number(req.params.id);
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "Invalid zone id" });
  }
  const mode = req.body?.mode || "pull-clean";
  if (!["pull-clean", "pull-keep", "pull-push"].includes(mode)) {
    return res.status(400).json({ message: "Invalid sync mode" });
  }
  try {
    const summary = await syncZone(zoneId, mode);
    res.json({ success: true, summary });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Sync failed" });
  }
});

// Purge cache for a zone
router.post("/zones/:id/purge-cache", async (req: any, res) => {
  const zoneId = Number(req.params.id);
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "Invalid zone id" });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get zone name for logging
    const [zones] = await query<{ name: string }>(
      "SELECT name FROM cloudflare_zones WHERE id = ?",
      [zoneId]
    );

    if (zones.length === 0) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const zoneName = zones[0].name;

    // Purge everything in the zone using Cloudflare API helper
    const response = await cloudflarePurgeCache(zoneId);

    if (response.success) {
      await logAction(
        req.user.id,
        "cloudflare_cache_purge",
        `Purged all cache for zone ${zoneName}`,
        ipAddress,
        userAgent,
        "cloudflare_zone",
        zoneId
      );

      res.json({ success: true, message: "Cache purged successfully" });
    } else {
      res.status(500).json({
        message: "Failed to purge cache",
        errors: response.errors || []
      });
    }
  } catch (error: any) {
    console.error("Purge cache error:", error);
    res.status(500).json({
      message: error.message || "Failed to purge cache"
    });
  }
});

// Copy Cloudflare zone to MyDNS (SOA/RR)
router.post("/zones/:id/copy-to-mydns", async (req: any, res) => {
  const zoneId = Number(req.params.id);
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "Invalid zone id" });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get the Cloudflare zone details
    const [zoneRows] = await query<{
      id: number;
      name: string;
      cf_zone_id: string;
    }>(
      "SELECT id, name, cf_zone_id FROM cloudflare_zones WHERE id = ?",
      [zoneId]
    );

    if (zoneRows.length === 0) {
      return res.status(404).json({ message: "Cloudflare zone not found" });
    }

    const cfZone = zoneRows[0];
    const zoneName = cfZone.name.endsWith('.') ? cfZone.name : `${cfZone.name}.`;

    // Check if SOA already exists for this origin
    const [existingSoa] = await query(
      "SELECT id, deleted_at FROM soa WHERE origin = ?",
      [zoneName]
    );

    if (existingSoa.length > 0 && !existingSoa[0].deleted_at) {
      return res.status(409).json({
        message: `SOA record for origin "${zoneName}" already exists in MyDNS`,
        existingId: existingSoa[0].id
      });
    }

    // Get all DNS records from Cloudflare zone
    const [cfRecords] = await query<{
      id: number;
      record_type: string;
      name: string;
      content: string;
      ttl: number | null;
      priority: number | null;
    }>(
      "SELECT id, record_type, name, content, ttl, priority FROM cloudflare_records WHERE zone_id = ?",
      [zoneId]
    );

    // Create SOA record
    let soaId: number;
    if (existingSoa.length > 0 && existingSoa[0].deleted_at) {
      // Restore soft-deleted SOA
      await execute(
        `UPDATE soa SET deleted_at = NULL, ns = ?, mbox = ?, serial = 1, refresh = 28800, retry = 7200,
         expire = 604800, minimum = 86400, ttl = 86400, active = 'Y' WHERE id = ?`,
        [`ns1.${zoneName}`, `hostmaster.${zoneName}`, existingSoa[0].id]
      );
      soaId = existingSoa[0].id;
    } else {
      // Create new SOA record
      const soaResult = await execute(
        `INSERT INTO soa
          (sys_userid, sys_groupid, user_id, sys_perm_user, sys_perm_group, sys_perm_other,
           origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, xfer, lastmodified)
         VALUES (0, 0, 0, 'riud', 'ri', 'r', ?, ?, ?, 1, 28800, 7200, 604800, 86400, 86400, 'Y', '', '')`,
        [zoneName, `ns1.${zoneName}`, `hostmaster.${zoneName}`]
      );
      soaId = soaResult.insertId;
    }

    // Create RR records from Cloudflare records
    const createdRecords: any[] = [];
    const failedRecords: any[] = [];

    for (const record of cfRecords) {
      try {
        // Skip SOA and NS records (SOA is created above, NS can be problematic)
        if (record.record_type === 'SOA') continue;

        // Clean up the record name
        let rrName = record.name;
        // Remove zone suffix if present
        if (rrName.endsWith(`.${cfZone.name}`)) {
          rrName = rrName.slice(0, -(cfZone.name.length + 1));
        } else if (rrName === cfZone.name) {
          rrName = '';
        }
        // Add trailing dot if not present and not empty
        if (rrName && !rrName.endsWith('.')) {
          rrName = `${rrName}.`;
        }

        await execute(
          `INSERT INTO rr
            (sys_userid, sys_groupid, user_id, sys_perm_user, sys_perm_group, sys_perm_other,
             zone, name, type, data, aux, ttl, active, lastmodified)
           VALUES (0, 0, 0, 'riud', 'ri', 'r', ?, ?, ?, ?, ?, ?, 'Y', '')`,
          [
            soaId,
            rrName,
            record.record_type,
            record.content,
            record.priority || 0,
            record.ttl || 3600
          ]
        );

        createdRecords.push({
          type: record.record_type,
          name: rrName,
          content: record.content
        });
      } catch (error: any) {
        console.error(`Failed to create RR record:`, error.message);
        failedRecords.push({
          type: record.record_type,
          name: record.name,
          error: error.message
        });
      }
    }

    await logAction(
      req.user.id,
      "cloudflare_zone_import",
      `Imported Cloudflare zone ${cfZone.name} to MyDNS. Created ${createdRecords.length} RR records, ${failedRecords.length} failed.`,
      ipAddress,
      userAgent,
      "cloudflare_zone",
      zoneId
    );

    res.status(201).json({
      success: true,
      soa_id: soaId,
      zone_name: zoneName,
      records_created: createdRecords.length,
      records_failed: failedRecords.length,
      created_records: createdRecords,
      failed_records: failedRecords
    });
  } catch (error: any) {
    console.error("Copy to MyDNS error:", error);
    res.status(500).json({
      message: error.message || "Internal server error"
    });
  }
});

const recordSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
  ttl: z.number().int().nonnegative().optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().nullable().optional(),
  comment: z.string().max(500).optional(),
  tags: z.string().max(500).optional(),
});
type RecordInput = z.infer<typeof recordSchema>;

function normalizeRecordPayload(
  updates: Partial<RecordInput>,
  current?: {
    type?: string | null;
    name?: string | null;
    content?: string | null;
    ttl?: number | null;
    proxied?: number | null;
    priority?: number | null;
    comment?: string | null;
    tags?: string | null;
  },
): RecordInput {
  const payload: RecordInput = {
    type: updates.type ?? current?.type ?? "",
    name: updates.name ?? current?.name ?? "",
    content: updates.content ?? current?.content ?? "",
    ttl: updates.ttl ?? current?.ttl ?? undefined,
    proxied:
      typeof updates.proxied === "boolean"
        ? updates.proxied
        : current?.proxied === null || current?.proxied === undefined
        ? undefined
        : Boolean(current?.proxied),
    priority: updates.priority ?? (current?.priority ?? null),
    comment: updates.comment ?? current?.comment ?? undefined,
    tags: updates.tags ?? current?.tags ?? undefined,
  };
  if (payload.ttl !== undefined && payload.ttl !== null) {
    payload.ttl = Math.max(0, Math.trunc(payload.ttl));
  }
  if (typeof payload.proxied === "boolean") {
    if (payload.proxied) {
      if (!payload.ttl || payload.ttl < 1) {
        payload.ttl = 1;
      }
    } else if (payload.ttl === undefined || payload.ttl <= 1) {
      payload.ttl = 300;
    }
  }
  if (payload.ttl === undefined) {
    payload.ttl = payload.proxied ? 1 : 300;
  }
  return payload;
}

router.post("/zones/:id/records", async (req: any, res) => {
  const zoneId = Number(req.params.id);
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "Invalid zone id" });
  }
  const syncRemote = req.body?.syncRemote !== false;
  const parsed = recordSchema.safeParse(req.body?.record ?? req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const record = normalizeRecordPayload(parsed.data);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get zone name for logging
    const [zoneRows] = await query<{ name: string }>(
      "SELECT name FROM cloudflare_zones WHERE id = ?",
      [zoneId]
    );
    const zoneName = zoneRows.length > 0 ? zoneRows[0].name : `Zone ${zoneId}`;

    if (syncRemote) {
      await cloudflareCreateDnsRecord(zoneId, {
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
        priority: record.priority,
        comment: record.comment,
        tags: record.tags ? record.tags.split(",").map(t => t.trim()).filter(t => t) : undefined,
      });
      await syncZone(zoneId);
    } else {
      await execute(
        `INSERT INTO cloudflare_records
          (zone_id, cf_record_id, record_type, name, content, ttl, proxied, priority, data, modified_on, comment, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [
          zoneId,
          `offline-${Date.now()}`,
          record.type,
          record.name,
          record.content,
          record.ttl ?? null,
          typeof record.proxied === "boolean" ? (record.proxied ? 1 : 0) : null,
          record.priority ?? null,
          JSON.stringify(record),
          record.comment ?? null,
          record.tags ?? null,
        ],
      );
    }

    await logAction(
      req.user.id,
      "cloudflare_record_create",
      `Created DNS record ${record.type} ${record.name} in zone ${zoneName}`,
      ipAddress,
      userAgent,
      "cloudflare_record",
      zoneId
    );

    res.status(201).json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to create record" });
  }
});

router.put("/records/:recordId", async (req: any, res) => {
  const recordId = Number(req.params.recordId);
  if (!Number.isInteger(recordId)) {
    return res.status(400).json({ message: "Invalid record id" });
  }
  const syncRemote = req.body?.syncRemote !== false;
  const parsed = recordSchema.partial().safeParse(req.body?.record ?? req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const updates = parsed.data;
  if (!Object.keys(updates).length) {
    return res.status(400).json({ message: "No changes supplied" });
  }
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  const [records] = await query<{
    id: number;
    zone_id: number;
    cf_record_id: string | null;
    record_type: string;
    name: string;
    content: string;
    ttl: number | null;
    proxied: number | null;
    priority: number | null;
    comment: string | null;
    tags: string | null;
  }>(
    "SELECT id, zone_id, cf_record_id, record_type, name, content, ttl, proxied, priority, comment, tags FROM cloudflare_records WHERE id = ?",
    [recordId],
  );
  if (!records.length) {
    return res.status(404).json({ message: "Record not found" });
  }
  const record = records[0];
  try {
    // Get zone name for logging
    const [zoneRows] = await query<{ name: string }>(
      "SELECT name FROM cloudflare_zones WHERE id = ?",
      [record.zone_id]
    );
    const zoneName = zoneRows.length > 0 ? zoneRows[0].name : `Zone ${record.zone_id}`;

    const payload = normalizeRecordPayload(updates, {
      type: record.record_type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      proxied: record.proxied,
      priority: record.priority,
      comment: record.comment,
      tags: record.tags,
    });
    if (syncRemote && record.cf_record_id && !record.cf_record_id.startsWith("offline-")) {
      await cloudflareUpdateDnsRecord(record.zone_id, record.cf_record_id, {
        type: payload.type,
        name: payload.name,
        content: payload.content,
        ttl: payload.ttl,
        proxied: payload.proxied,
        priority: payload.priority,
        comment: payload.comment,
        tags: payload.tags ? payload.tags.split(",").map(t => t.trim()).filter(t => t) : undefined,
      });
      await syncZone(record.zone_id);
    } else {
      await execute(
        `UPDATE cloudflare_records
            SET record_type = ?, name = ?, content = ?, ttl = ?, proxied = ?, priority = ?, comment = ?, tags = ?, updated_at = NOW()
          WHERE id = ?`,
        [
          payload.type,
          payload.name,
          payload.content,
          payload.ttl ?? null,
          typeof payload.proxied === "boolean" ? (payload.proxied ? 1 : 0) : null,
          payload.priority ?? null,
          payload.comment ?? null,
          payload.tags ?? null,
          recordId,
        ],
      );
    }

    await logAction(
      req.user.id,
      "cloudflare_record_update",
      `Updated DNS record ${payload.type} ${payload.name} in zone ${zoneName}`,
      ipAddress,
      userAgent,
      "cloudflare_record",
      recordId
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to update record" });
  }
});

router.delete("/records/:recordId", async (req: any, res) => {
  const recordId = Number(req.params.recordId);
  if (!Number.isInteger(recordId)) {
    return res.status(400).json({ message: "Invalid record id" });
  }
  const syncRemote = req.body?.syncRemote !== false;
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  const [records] = await query<{
    id: number;
    zone_id: number;
    cf_record_id: string | null;
    record_type: string;
    name: string;
  }>(
    "SELECT id, zone_id, cf_record_id, record_type, name FROM cloudflare_records WHERE id = ?",
    [recordId],
  );
  if (!records.length) {
    return res.status(404).json({ message: "Record not found" });
  }
  const record = records[0];
  try {
    // Get zone name for logging
    const [zoneRows] = await query<{ name: string }>(
      "SELECT name FROM cloudflare_zones WHERE id = ?",
      [record.zone_id]
    );
    const zoneName = zoneRows.length > 0 ? zoneRows[0].name : `Zone ${record.zone_id}`;

    if (syncRemote && record.cf_record_id && !record.cf_record_id.startsWith("offline-")) {
      // Delete from Cloudflare first
      await cloudflareDeleteDnsRecord(record.zone_id, record.cf_record_id);
    }
    // Always delete from local DB regardless of sync mode
    // This prevents race conditions with Cloudflare API propagation
    await execute("DELETE FROM cloudflare_records WHERE id = ?", [recordId]);

    await logAction(
      req.user.id,
      "cloudflare_record_delete",
      `Deleted DNS record ${record.record_type} ${record.name} from zone ${zoneName}`,
      ipAddress,
      userAgent,
      "cloudflare_record",
      recordId
    );

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to delete record" });
  }
});

router.post("/zones/:id/favorite", async (req, res) => {
  const favorite = req.body?.favorite;
  if (typeof favorite !== "boolean") {
    return res.status(400).json({ message: "favorite boolean required" });
  }
  const result = await execute("UPDATE cloudflare_zones SET favorite = ?, updated_at = NOW() WHERE id = ?", [
    favorite ? 1 : 0,
    req.params.id,
  ]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ message: "Zone not found" });
  }
  res.json({ success: true });
});

router.delete("/zones/:id", async (req: any, res) => {
  const zoneId = Number(req.params.id);
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "Invalid zone id" });
  }
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get zone details for logging
    const [zones] = await query<{ id: number; cf_zone_id: string | null; name: string }>(
      "SELECT id, cf_zone_id, name FROM cloudflare_zones WHERE id = ?",
      [zoneId]
    );
    if (!zones.length) {
      return res.status(404).json({ message: "Zone not found" });
    }
    const zone = zones[0];

    // Delete all records, load balancers, pools, and origins associated with this zone
    await execute("DELETE FROM cloudflare_lb_pool_origins WHERE pool_id IN (SELECT id FROM cloudflare_lb_pools WHERE zone_id = ?)", [zoneId]);
    await execute("DELETE FROM cloudflare_lb_pools WHERE zone_id = ?", [zoneId]);
    await execute("DELETE FROM cloudflare_load_balancers WHERE zone_id = ?", [zoneId]);
    await execute("DELETE FROM cloudflare_records WHERE zone_id = ?", [zoneId]);
    await execute("DELETE FROM cloudflare_zones WHERE id = ?", [zoneId]);

    await logAction(
      req.user.id,
      "cloudflare_zone_delete",
      `Deleted Cloudflare zone ${zone.name} (ID: ${zoneId})`,
      ipAddress,
      userAgent,
      "cloudflare_zone",
      zoneId
    );

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to delete zone" });
  }
});

// Load Balancer routes
router.post("/zones/:id/load-balancers", async (req, res) => {
  const zoneId = Number(req.params.id);
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "Invalid zone id" });
  }
  const syncRemote = req.body?.syncRemote !== false;
  const payload = req.body?.loadBalancer ?? req.body;

  try {
    if (syncRemote) {
      const cfResponse = await cloudflareCreateLoadBalancer(zoneId, payload);
      await syncZone(zoneId);
      res.status(201).json({ success: true, data: cfResponse });
    } else {
      // Store locally without calling Cloudflare
      await execute(
        `INSERT INTO cloudflare_load_balancers
          (zone_id, cf_lb_id, name, proxied, enabled, fallback_pool, default_pools, steering_policy, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          zoneId,
          `offline-${Date.now()}`,
          payload.name,
          typeof payload.proxied === "boolean" ? (payload.proxied ? 1 : 0) : null,
          typeof payload.enabled === "boolean" ? (payload.enabled ? 1 : 0) : null,
          payload.fallback_pool ?? null,
          payload.default_pools ? JSON.stringify(payload.default_pools) : null,
          payload.steering_policy ?? null,
          JSON.stringify(payload),
        ],
      );
      res.status(201).json({ success: true });
    }
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to create load balancer" });
  }
});

router.put("/load-balancers/:lbId", async (req, res) => {
  const lbId = Number(req.params.lbId);
  if (!Number.isInteger(lbId)) {
    return res.status(400).json({ message: "Invalid load balancer id" });
  }
  const syncRemote = req.body?.syncRemote !== false;
  const payload = req.body?.loadBalancer ?? req.body;

  const [lbs] = await query<{
    id: number;
    zone_id: number;
    cf_lb_id: string | null;
  }>(
    "SELECT id, zone_id, cf_lb_id FROM cloudflare_load_balancers WHERE id = ?",
    [lbId],
  );

  if (!lbs.length) {
    return res.status(404).json({ message: "Load balancer not found" });
  }

  const lb = lbs[0];

  try {
    if (syncRemote && lb.cf_lb_id && !lb.cf_lb_id.startsWith("offline-")) {
      await cloudflareUpdateLoadBalancer(lb.zone_id, lb.cf_lb_id, payload);
      await syncZone(lb.zone_id);
    } else {
      await execute(
        `UPDATE cloudflare_load_balancers
         SET name = ?, proxied = ?, enabled = ?, fallback_pool = ?, default_pools = ?, steering_policy = ?, data = ?
         WHERE id = ?`,
        [
          payload.name,
          typeof payload.proxied === "boolean" ? (payload.proxied ? 1 : 0) : null,
          typeof payload.enabled === "boolean" ? (payload.enabled ? 1 : 0) : null,
          payload.fallback_pool ?? null,
          payload.default_pools ? JSON.stringify(payload.default_pools) : null,
          payload.steering_policy ?? null,
          JSON.stringify(payload),
          lbId,
        ],
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to update load balancer" });
  }
});

router.delete("/load-balancers/:lbId", async (req, res) => {
  const lbId = Number(req.params.lbId);
  if (!Number.isInteger(lbId)) {
    return res.status(400).json({ message: "Invalid load balancer id" });
  }
  const syncRemote = req.body?.syncRemote !== false;

  const [lbs] = await query<{ id: number; zone_id: number; cf_lb_id: string | null }>(
    "SELECT id, zone_id, cf_lb_id FROM cloudflare_load_balancers WHERE id = ?",
    [lbId],
  );

  if (!lbs.length) {
    return res.status(404).json({ message: "Load balancer not found" });
  }

  const lb = lbs[0];

  try {
    if (syncRemote && lb.cf_lb_id && !lb.cf_lb_id.startsWith("offline-")) {
      await cloudflareDeleteLoadBalancer(lb.zone_id, lb.cf_lb_id);
    }
    await execute("DELETE FROM cloudflare_load_balancers WHERE id = ?", [lbId]);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to delete load balancer" });
  }
});

// Pool routes
router.get("/load-balancers/:lbId/pools", async (req, res) => {
  const lbId = Number(req.params.lbId);
  if (!Number.isInteger(lbId)) {
    return res.status(400).json({ message: "Invalid load balancer id" });
  }

  const [pools] = await query(
    `SELECT p.*,
     (SELECT COUNT(*) FROM cloudflare_lb_pool_origins WHERE pool_id = p.id) as origin_count
     FROM cloudflare_lb_pools p WHERE p.lb_id = ? ORDER BY p.id ASC`,
    [lbId]
  );
  res.json(pools);
});

router.get("/pools/:poolId", async (req, res) => {
  const poolId = Number(req.params.poolId);
  if (!Number.isInteger(poolId)) {
    return res.status(400).json({ message: "Invalid pool id" });
  }

  const [pools] = await query(
    "SELECT * FROM cloudflare_lb_pools WHERE id = ?",
    [poolId]
  );

  if (!pools.length) {
    return res.status(404).json({ message: "Pool not found" });
  }

  const [origins] = await query(
    "SELECT * FROM cloudflare_lb_pool_origins WHERE pool_id = ? ORDER BY id ASC",
    [poolId]
  );

  res.json({ ...pools[0], origins });
});

router.post("/load-balancers/:lbId/pools", async (req, res) => {
  const lbId = Number(req.params.lbId);
  if (!Number.isInteger(lbId)) {
    return res.status(400).json({ message: "Invalid load balancer id" });
  }

  const poolData = req.body;

  try {
    const result = await execute(
      `INSERT INTO cloudflare_lb_pools
       (lb_id, cf_pool_id, name, description, enabled, minimum_origins, monitor,
        notification_email, notification_enabled, notification_health_status,
        health_check_regions, origin_steering_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lbId,
        poolData.cf_pool_id || `offline-${Date.now()}`,
        poolData.name,
        poolData.description || null,
        poolData.enabled ? 1 : 0,
        poolData.minimum_origins || 1,
        poolData.monitor || 'http',
        poolData.notification_email || null,
        poolData.notification_enabled ? 1 : 0,
        poolData.notification_health_status || 'either',
        Array.isArray(poolData.health_check_regions) ? poolData.health_check_regions.join(',') : null,
        poolData.origin_steering_policy || 'random',
      ]
    );

    const poolId = result.insertId;

    // Insert origins if provided
    if (poolData.origins && Array.isArray(poolData.origins)) {
      for (const origin of poolData.origins) {
        await execute(
          `INSERT INTO cloudflare_lb_pool_origins
           (pool_id, name, address, enabled, weight, port, header_host)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            poolId,
            origin.name,
            origin.address,
            origin.enabled ? 1 : 0,
            origin.weight || 1,
            origin.port || null,
            origin.header_host || null,
          ]
        );
      }
    }

    const [newPool] = await query(
      "SELECT * FROM cloudflare_lb_pools WHERE id = ?",
      [poolId]
    );

    res.json(newPool[0]);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to create pool" });
  }
});

router.put("/pools/:poolId", async (req, res) => {
  const poolId = Number(req.params.poolId);
  if (!Number.isInteger(poolId)) {
    return res.status(400).json({ message: "Invalid pool id" });
  }

  const poolData = req.body;

  try {
    await execute(
      `UPDATE cloudflare_lb_pools SET
       name = ?, description = ?, enabled = ?, minimum_origins = ?,
       monitor = ?, notification_email = ?, notification_enabled = ?,
       notification_health_status = ?, health_check_regions = ?,
       origin_steering_policy = ?
       WHERE id = ?`,
      [
        poolData.name,
        poolData.description || null,
        poolData.enabled ? 1 : 0,
        poolData.minimum_origins || 1,
        poolData.monitor || 'http',
        poolData.notification_email || null,
        poolData.notification_enabled ? 1 : 0,
        poolData.notification_health_status || 'either',
        Array.isArray(poolData.health_check_regions) ? poolData.health_check_regions.join(',') : null,
        poolData.origin_steering_policy || 'random',
        poolId,
      ]
    );

    // Update origins if provided
    if (poolData.origins && Array.isArray(poolData.origins)) {
      // Delete existing origins
      await execute("DELETE FROM cloudflare_lb_pool_origins WHERE pool_id = ?", [poolId]);

      // Insert new origins
      for (const origin of poolData.origins) {
        await execute(
          `INSERT INTO cloudflare_lb_pool_origins
           (pool_id, name, address, enabled, weight, port, header_host)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            poolId,
            origin.name,
            origin.address,
            origin.enabled ? 1 : 0,
            origin.weight || 1,
            origin.port || null,
            origin.header_host || null,
          ]
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to update pool" });
  }
});

router.delete("/pools/:poolId", async (req, res) => {
  const poolId = Number(req.params.poolId);
  if (!Number.isInteger(poolId)) {
    return res.status(400).json({ message: "Invalid pool id" });
  }

  try {
    await execute("DELETE FROM cloudflare_lb_pools WHERE id = ?", [poolId]);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to delete pool" });
  }
});

// Origin routes
router.get("/pools/:poolId/origins", async (req, res) => {
  const poolId = Number(req.params.poolId);
  if (!Number.isInteger(poolId)) {
    return res.status(400).json({ message: "Invalid pool id" });
  }

  const [origins] = await query(
    "SELECT * FROM cloudflare_lb_pool_origins WHERE pool_id = ? ORDER BY id ASC",
    [poolId]
  );
  res.json(origins);
});

router.post("/pools/:poolId/origins", async (req, res) => {
  const poolId = Number(req.params.poolId);
  if (!Number.isInteger(poolId)) {
    return res.status(400).json({ message: "Invalid pool id" });
  }

  const originData = req.body;

  try {
    const result = await execute(
      `INSERT INTO cloudflare_lb_pool_origins
       (pool_id, name, address, enabled, weight, port, header_host)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        poolId,
        originData.name,
        originData.address,
        originData.enabled ? 1 : 0,
        originData.weight || 1,
        originData.port || null,
        originData.header_host || null,
      ]
    );

    const [newOrigin] = await query(
      "SELECT * FROM cloudflare_lb_pool_origins WHERE id = ?",
      [result.insertId]
    );

    res.json(newOrigin[0]);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to create origin" });
  }
});

router.put("/origins/:originId", async (req, res) => {
  const originId = Number(req.params.originId);
  if (!Number.isInteger(originId)) {
    return res.status(400).json({ message: "Invalid origin id" });
  }

  const originData = req.body;

  try {
    await execute(
      `UPDATE cloudflare_lb_pool_origins SET
       name = ?, address = ?, enabled = ?, weight = ?, port = ?, header_host = ?
       WHERE id = ?`,
      [
        originData.name,
        originData.address,
        originData.enabled ? 1 : 0,
        originData.weight || 1,
        originData.port || null,
        originData.header_host || null,
        originId,
      ]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to update origin" });
  }
});

router.delete("/origins/:originId", async (req, res) => {
  const originId = Number(req.params.originId);
  if (!Number.isInteger(originId)) {
    return res.status(400).json({ message: "Invalid origin id" });
  }

  try {
    await execute("DELETE FROM cloudflare_lb_pool_origins WHERE id = ?", [originId]);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to delete origin" });
  }
});

// Health monitoring routes
router.get("/pools/:poolId/health", async (req, res) => {
  const poolId = Number(req.params.poolId);
  if (!Number.isInteger(poolId)) {
    return res.status(400).json({ message: "Invalid pool id" });
  }

  try {
    // Get pool with cf_pool_id and account info
    const [pools] = await query<{ cf_pool_id: string; cf_account_id: string }>(
      `SELECT p.cf_pool_id, a.cf_account_id
       FROM cloudflare_lb_pools p
       JOIN cloudflare_load_balancers lb ON lb.id = p.lb_id
       JOIN cloudflare_zones z ON z.id = lb.zone_id
       JOIN cloudflare_accounts a ON a.id = z.account_id
       WHERE p.id = ?`,
      [poolId]
    );

    if (!pools.length) {
      return res.status(404).json({ message: "Pool not found" });
    }

    const pool = pools[0];

    // Check if this is an offline pool
    if (!pool.cf_pool_id || pool.cf_pool_id.startsWith("offline-")) {
      return res.json({
        success: true,
        result: {
          pool_id: pool.cf_pool_id,
          healthy: null,
          origins: [],
        }
      });
    }

    // Fetch health from Cloudflare
    const healthData = await cloudflareGetPoolHealth(pool.cf_account_id, pool.cf_pool_id);
    const cfHealth = healthData.result;

    // Parse pop_health to extract overall health and origin details
    let overallHealthy = null;
    let origins: any[] = [];

    if (cfHealth?.pop_health) {
      const regions = Object.values(cfHealth.pop_health) as any[];
      if (regions.length > 0) {
        const firstRegion = regions[0];
        overallHealthy = firstRegion.healthy ?? null;

        if (Array.isArray(firstRegion.origins)) {
          origins = firstRegion.origins.map((originObj: any) => {
            const originName = Object.keys(originObj)[0];
            const originData = originObj[originName];
            return {
              name: originName,
              healthy: originData.healthy ?? null,
              rtt: originData.rtt,
              failure_reason: originData.failure_reason,
            };
          });
        }
      }
    }

    res.json({
      success: true,
      result: {
        pool_id: pool.cf_pool_id,
        healthy: overallHealthy,
        origins: origins,
      }
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to fetch pool health" });
  }
});

router.get("/load-balancers/:lbId/pools/health", async (req, res) => {
  const lbId = Number(req.params.lbId);
  if (!Number.isInteger(lbId)) {
    return res.status(400).json({ message: "Invalid load balancer id" });
  }

  try {
    // Get all pools for this load balancer with account info
    const [pools] = await query<{ id: number; cf_pool_id: string; name: string; cf_account_id: string }>(
      `SELECT p.id, p.cf_pool_id, p.name, a.cf_account_id
       FROM cloudflare_lb_pools p
       JOIN cloudflare_load_balancers lb ON lb.id = p.lb_id
       JOIN cloudflare_zones z ON z.id = lb.zone_id
       JOIN cloudflare_accounts a ON a.id = z.account_id
       WHERE p.lb_id = ?`,
      [lbId]
    );

    const healthResults = await Promise.all(
      pools.map(async (pool) => {
        try {
          // Skip offline pools
          if (!pool.cf_pool_id || pool.cf_pool_id.startsWith("offline-")) {
            return {
              pool_id: pool.id,
              cf_pool_id: pool.cf_pool_id,
              name: pool.name,
              healthy: null,
              origins: [],
            };
          }

          const healthData = await cloudflareGetPoolHealth(pool.cf_account_id, pool.cf_pool_id);
          const cfHealth = healthData.result;

          // Parse pop_health to extract overall health and origin details
          let overallHealthy = null;
          let origins: any[] = [];

          if (cfHealth?.pop_health) {
            // Get health from first region (usually all regions have same health)
            const regions = Object.values(cfHealth.pop_health) as any[];
            if (regions.length > 0) {
              const firstRegion = regions[0];
              overallHealthy = firstRegion.healthy ?? null;

              // Extract origin health - each origin is an object with origin name as key
              if (Array.isArray(firstRegion.origins)) {
                origins = firstRegion.origins.map((originObj: any) => {
                  const originName = Object.keys(originObj)[0];
                  const originData = originObj[originName];
                  return {
                    name: originName,
                    healthy: originData.healthy ?? null,
                    rtt: originData.rtt,
                    failure_reason: originData.failure_reason,
                  };
                });
              }
            }
          }

          return {
            pool_id: pool.id,
            cf_pool_id: pool.cf_pool_id,
            name: pool.name,
            healthy: overallHealthy,
            origins: origins,
          };
        } catch (error) {
          return {
            pool_id: pool.id,
            cf_pool_id: pool.cf_pool_id,
            name: pool.name,
            healthy: null,
            origins: [],
            error: error instanceof Error ? error.message : "Failed to fetch health",
          };
        }
      })
    );

    res.json({ success: true, result: healthResults });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Failed to fetch pools health" });
  }
});

export default router;
