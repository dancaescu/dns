import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";
import { cloudflareCreateZone } from "../cloudflare.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const router = Router();

/**
 * Trigger DNS NOTIFY for a zone using mydnsnotify utility
 */
async function triggerNotify(origin: string): Promise<void> {
  try {
    const { stdout, stderr } = await execAsync(`mydnsnotify ${origin}`, { timeout: 10000 });
    console.log(`NOTIFY triggered for ${origin}: ${stdout.trim()}`);
  } catch (error: any) {
    // Log but don't fail the operation
    console.warn(`Failed to trigger NOTIFY for ${origin}:`, error.message);
  }
}

const upsertSchema = z.object({
  origin: z.string().min(1),
  ns: z.string().min(1),
  mbox: z.string().min(1),
  serial: z.number().int().nonnegative().default(1),
  refresh: z.number().int().nonnegative().default(28800),
  retry: z.number().int().nonnegative().default(7200),
  expire: z.number().int().nonnegative().default(604800),
  minimum: z.number().int().nonnegative().default(86400),
  ttl: z.number().int().nonnegative().default(86400),
  active: z.enum(["Y", "N"]).default("Y"),
  xfer: z.string().optional(),
  also_notify: z.string().optional(),
});

router.use(authenticate);

router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const search = typeof req.query.search === "string" ? `%${req.query.search}%` : null;
  let sql = "SELECT id, origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, xfer, also_notify FROM soa WHERE deleted_at IS NULL";
  const params: unknown[] = [];
  if (search) {
    sql += " AND origin LIKE ?";
    params.push(search);
  }
  sql += " ORDER BY origin ASC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const [rows] = await query(sql, params);
  res.json(rows);
});

router.post("/", async (req: any, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const data = parsed.data;
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  // Check if there's an existing SOA record with this origin
  const [existing] = await query(
    `SELECT id, deleted_at FROM soa WHERE origin = ?`,
    [data.origin]
  );

  if (existing.length > 0) {
    const record = existing[0];
    if (record.deleted_at) {
      // Restore the soft-deleted record
      await execute(
        `UPDATE soa SET deleted_at = NULL, ns = ?, mbox = ?, serial = ?, refresh = ?, retry = ?,
         expire = ?, minimum = ?, ttl = ?, active = ?, xfer = ?, also_notify = ? WHERE id = ?`,
        [data.ns, data.mbox, data.serial, data.refresh, data.retry, data.expire,
         data.minimum, data.ttl, data.active, data.xfer || "", data.also_notify || "", record.id]
      );

      await logAction(
        req.user.id,
        "soa_restore",
        `Restored SOA record for ${data.origin}`,
        ipAddress,
        userAgent,
        "soa",
        record.id
      );

      // Trigger NOTIFY to slaves
      await triggerNotify(data.origin);

      return res.status(200).json({ id: record.id, restored: true });
    } else {
      // Record already exists and is active
      return res.status(409).json({
        message: `SOA record for origin "${data.origin}" already exists`,
        existingId: record.id
      });
    }
  }

  // Create new record
  try {
    const result = await execute(
      `INSERT INTO soa
        (sys_userid, sys_groupid, user_id, sys_perm_user, sys_perm_group, sys_perm_other,
         origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, xfer, also_notify, lastmodified)
       VALUES (0, 0, 0, 'riud', 'ri', 'r', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
      `,
      [
        data.origin,
        data.ns,
        data.mbox,
        data.serial,
        data.refresh,
        data.retry,
        data.expire,
        data.minimum,
        data.ttl,
        data.active,
        data.xfer || "",
        data.also_notify || "",
      ],
    );

    await logAction(
      req.user.id,
      "soa_create",
      `Created SOA record for ${data.origin}`,
      ipAddress,
      userAgent,
      "soa",
      result.insertId
    );

    // Trigger NOTIFY to slaves
    await triggerNotify(data.origin);

    res.status(201).json({ id: result.insertId });
  } catch (error: any) {
    console.error("Failed to create SOA record:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: `SOA record for origin "${data.origin}" already exists` });
    }
    return res.status(500).json({ message: "Failed to create SOA record" });
  }
});

router.put("/:id", async (req: any, res) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const updates = parsed.data;
  const fields = Object.keys(updates);
  if (!fields.length) {
    return res.status(400).json({ message: "No changes supplied" });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  // Get the origin before update for logging
  const [rows] = await query<{ origin: string }>("SELECT origin FROM soa WHERE id = ?", [req.params.id]);
  const origin = rows.length > 0 ? rows[0].origin : `ID ${req.params.id}`;

  const setClause = fields.map((key) => `${key} = ?`).join(", ");
  const values = fields.map((key) => (updates as any)[key]);
  values.push(req.params.id);
  await execute(`UPDATE soa SET ${setClause} WHERE id = ?`, values);

  await logAction(
    req.user.id,
    "soa_update",
    `Updated SOA record for ${origin}: ${fields.join(", ")}`,
    ipAddress,
    userAgent,
    "soa",
    Number(req.params.id)
  );

  // Trigger NOTIFY to slaves
  await triggerNotify(origin);

  res.json({ success: true });
});

router.delete("/:id", async (req: any, res) => {
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  // Get the origin before soft delete for logging
  const [rows] = await query<{ origin: string }>("SELECT origin FROM soa WHERE id = ?", [req.params.id]);
  const origin = rows.length > 0 ? rows[0].origin : `ID ${req.params.id}`;

  // Count associated RR records
  const [rrRows] = await query<{ count: number }>(
    "SELECT COUNT(*) as count FROM rr WHERE zone = ? AND deleted_at IS NULL",
    [req.params.id]
  );
  const rrCount = rrRows[0]?.count || 0;

  // Soft delete the SOA record
  await execute("UPDATE soa SET deleted_at = NOW() WHERE id = ?", [req.params.id]);

  // Soft delete all associated RR records
  await execute("UPDATE rr SET deleted_at = NOW() WHERE zone = ? AND deleted_at IS NULL", [req.params.id]);

  await logAction(
    req.user.id,
    "soa_delete",
    `Deleted SOA record for ${origin}${rrCount > 0 ? ` and ${rrCount} associated RR record(s)` : ""}`,
    ipAddress,
    userAgent,
    "soa",
    Number(req.params.id)
  );

  // Trigger NOTIFY to slaves (best effort - zone is being deleted)
  await triggerNotify(origin);

  res.status(204).send();
});

// Copy SOA zone to Cloudflare
const copyToCloudflareSchema = z.object({
  cf_account_id: z.number().int().positive(),
});

router.post("/:id/copy-to-cloudflare", async (req: any, res) => {
  const soaId = Number(req.params.id);
  const parsed = copyToCloudflareSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }

  const cfAccountId = parsed.data.cf_account_id;
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get the SOA zone
    const [soaRows] = await query<{ id: number; origin: string; ns: string; ttl: number }>(
      "SELECT id, origin, ns, ttl FROM soa WHERE id = ? AND deleted_at IS NULL",
      [soaId]
    );

    if (soaRows.length === 0) {
      return res.status(404).json({ message: "SOA zone not found" });
    }

    const soaZone = soaRows[0];
    let zoneName = soaZone.origin;

    // Remove trailing dot if present
    if (zoneName.endsWith('.')) {
      zoneName = zoneName.slice(0, -1);
    }

    // Get the Cloudflare account
    const [accountRows] = await query<{ id: number; cf_account_id: string; name: string }>(
      "SELECT id, cf_account_id, name FROM cloudflare_accounts WHERE id = ?",
      [cfAccountId]
    );

    if (accountRows.length === 0) {
      return res.status(404).json({ message: "Cloudflare account not found" });
    }

    const cfAccount = accountRows[0];

    // Get all RR records for this zone
    const [rrRecords] = await query<{
      id: number;
      name: string;
      type: string;
      data: string;
      aux: number;
      ttl: number;
    }>(
      "SELECT id, name, type, data, aux, ttl FROM rr WHERE zone = ? AND deleted_at IS NULL",
      [soaId]
    );

    // Create zone in Cloudflare
    const cfZoneResponse = await cloudflareCreateZone(
      cfAccount.cf_account_id,
      zoneName,
      false,
      "full"
    );

    if (!cfZoneResponse.success || !cfZoneResponse.result) {
      return res.status(500).json({
        message: "Failed to create zone in Cloudflare",
        errors: cfZoneResponse.errors || [],
      });
    }

    const cfZone = cfZoneResponse.result;

    // Save zone to database
    const zoneResult = await execute(
      `INSERT INTO cloudflare_zones
       (account_id, cf_zone_id, name, status, paused, zone_type, plan_name, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        cfAccountId,
        cfZone.id,
        cfZone.name,
        cfZone.status,
        cfZone.paused ? 1 : 0,
        cfZone.type || null,
        cfZone.plan?.name || null,
      ]
    );

    const localZoneId = zoneResult.insertId;

    // Import Cloudflare module for DNS record creation
    const { default: axios } = await import('axios');
    const cfApiToken = process.env.CLOUDFLARE_API_TOKEN;

    // Create DNS records in Cloudflare
    const createdRecords: any[] = [];
    const failedRecords: any[] = [];

    for (const record of rrRecords) {
      try {
        let recordName = record.name;

        // Remove zone suffix if present
        if (recordName.endsWith(soaZone.origin)) {
          recordName = recordName.slice(0, -soaZone.origin.length);
          if (recordName.endsWith('.')) {
            recordName = recordName.slice(0, -1);
          }
        }

        // Use @ for apex records
        if (!recordName || recordName === zoneName) {
          recordName = '@';
        }

        // Build DNS record payload
        const dnsPayload: any = {
          type: record.type,
          name: recordName,
          content: record.data,
          ttl: record.ttl || 3600,
        };

        // Add priority for MX and SRV records
        if (record.type === 'MX' || record.type === 'SRV') {
          dnsPayload.priority = record.aux || 0;
        }

        // Create DNS record via Cloudflare API
        const response = await axios.post(
          `https://api.cloudflare.com/client/v4/zones/${cfZone.id}/dns_records`,
          dnsPayload,
          {
            headers: {
              'Authorization': `Bearer ${cfApiToken}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (response.data.success && response.data.result) {
          // Save to database
          await execute(
            `INSERT INTO cloudflare_records
             (zone_id, cf_record_id, type, name, content, ttl, priority, proxied)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              localZoneId,
              response.data.result.id,
              response.data.result.type,
              response.data.result.name,
              response.data.result.content,
              response.data.result.ttl,
              response.data.result.priority || 0,
              response.data.result.proxied ? 1 : 0,
            ]
          );

          createdRecords.push({
            source_id: record.id,
            cf_record_id: response.data.result.id,
            type: record.type,
            name: recordName,
          });
        }
      } catch (error: any) {
        console.error(`Failed to create DNS record:`, error.response?.data || error.message);
        failedRecords.push({
          source_id: record.id,
          name: record.name,
          type: record.type,
          error: error.response?.data?.errors?.[0]?.message || error.message,
        });
      }
    }

    // Log the migration
    await logAction(
      req.user.id,
      "soa_migrate",
      `Copied SOA zone ${zoneName} to Cloudflare account ${cfAccount.name}. Created ${createdRecords.length} records, ${failedRecords.length} failed.`,
      ipAddress,
      userAgent,
      "soa",
      soaId
    );

    res.status(201).json({
      success: true,
      zone_id: localZoneId,
      cf_zone_id: cfZone.id,
      zone_name: cfZone.name,
      name_servers: cfZone.name_servers,
      status: cfZone.status,
      records_created: createdRecords.length,
      records_failed: failedRecords.length,
      created_records: createdRecords,
      failed_records: failedRecords,
    });
  } catch (error: any) {
    console.error("Copy to Cloudflare error:", error);
    res.status(500).json({
      message: error.message || "Internal server error",
      details: error.response?.data || null,
    });
  }
});

export default router;
