import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";
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

/**
 * Get zone origin for a given zone ID
 */
async function getZoneOrigin(zoneId: number): Promise<string | null> {
  try {
    const [rows] = await query<{ origin: string }>("SELECT origin FROM soa WHERE id = ?", [zoneId]);
    return rows.length > 0 ? rows[0].origin : null;
  } catch (error) {
    console.error("Failed to get zone origin:", error);
    return null;
  }
}

const upsertSchema = z.object({
  zone: z.number().int().positive(),
  name: z.string().min(1),
  type: z.enum(["A", "AAAA", "CAA", "CERT", "CNAME", "DNAME", "DNSKEY", "DS", "HINFO", "HTTPS", "LOC", "MX", "NAPTR", "NS", "NSEC", "NSEC3", "NSEC3PARAM", "OPENPGPKEY", "PTR", "RP", "RRSIG", "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "TXT", "URI"]),
  data: z.string().min(1),
  aux: z.number().int().nonnegative().default(0),
  ttl: z.number().int().nonnegative().default(86400),
});

router.use(authenticate);

router.get("/", async (req, res) => {
  const zoneId = typeof req.query.zone === "string" ? Number(req.query.zone) : NaN;
  if (!Number.isInteger(zoneId)) {
    return res.status(400).json({ message: "zone query parameter is required" });
  }
  const [rows] = await query(
    `SELECT id, zone, name, type, data, aux, ttl
     FROM rr WHERE zone = ? AND deleted_at IS NULL ORDER BY name ASC`,
    [zoneId],
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const data = parsed.data;

  // Check if there's an existing record (active or soft-deleted)
  const [existing] = await query(
    `SELECT id, deleted_at FROM rr WHERE zone = ? AND name = ? AND type = ? AND data = ?`,
    [data.zone, data.name, data.type, data.data]
  );

  if (existing.length > 0) {
    const record = existing[0];
    if (record.deleted_at) {
      // Restore the soft-deleted record
      await execute(
        `UPDATE rr SET deleted_at = NULL, aux = ?, ttl = ? WHERE id = ?`,
        [data.aux, data.ttl, record.id]
      );

      // Trigger NOTIFY to slaves
      const origin = await getZoneOrigin(data.zone);
      if (origin) await triggerNotify(origin);

      return res.status(200).json({ id: record.id, restored: true });
    } else {
      // Record already exists and is active
      return res.status(409).json({
        message: "A record with these values already exists",
        existingId: record.id
      });
    }
  }

  // Create new record
  try {
    const result = await execute(
      `INSERT INTO rr
        (sys_userid, sys_groupid, sys_perm_user, sys_perm_group, sys_perm_other,
         zone, name, type, data, aux, ttl, user_id, version)
       VALUES (0, 0, 'riud', 'ri', 'r', ?, ?, ?, ?, ?, ?, 0, 1)`,
      [data.zone, data.name, data.type, data.data, data.aux, data.ttl],
    );

    // Trigger NOTIFY to slaves
    const origin = await getZoneOrigin(data.zone);
    if (origin) await triggerNotify(origin);

    res.status(201).json({ id: result.insertId });
  } catch (error: any) {
    console.error("Failed to create RR record:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "A record with these values already exists" });
    }
    return res.status(500).json({ message: "Failed to create record" });
  }
});

router.put("/:id", async (req, res) => {
  const parsed = upsertSchema.partial({ zone: true }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const updates = parsed.data;
  const fields = Object.keys(updates);
  if (!fields.length) {
    return res.status(400).json({ message: "No changes supplied" });
  }

  // Get zone ID for NOTIFY
  const [rrRows] = await query<{ zone: number }>("SELECT zone FROM rr WHERE id = ?", [req.params.id]);
  const zoneId = rrRows.length > 0 ? rrRows[0].zone : null;

  const setClause = fields.map((key) => `${key} = ?`).join(", ");
  const values = fields.map((key) => (updates as any)[key]);
  values.push(req.params.id);
  await execute(`UPDATE rr SET ${setClause} WHERE id = ?`, values);

  // Trigger NOTIFY to slaves
  if (zoneId) {
    const origin = await getZoneOrigin(zoneId);
    if (origin) await triggerNotify(origin);
  }

  res.json({ success: true });
});

router.delete("/:id", async (req: any, res) => {
  try {
    // Get record details before deleting for audit log
    const [records] = await query(
      `SELECT r.id, r.name, r.type, r.data, s.origin as zone_name
       FROM rr r
       JOIN soa s ON r.zone = s.id
       WHERE r.id = ?`,
      [req.params.id]
    );

    if (!records || records.length === 0) {
      return res.status(404).json({ message: "Record not found" });
    }

    const record = records[0];
    // Get real client IP from proxy headers or socket
    let ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                    || (req.headers['x-real-ip'] as string)
                    || req.socket?.remoteAddress
                    || 'unknown';
    // Strip IPv4-mapped IPv6 prefix
    if (ipAddress.startsWith('::ffff:')) {
      ipAddress = ipAddress.substring(7);
    }
    // Normalize IPv6 localhost to IPv4
    if (ipAddress === '::1') {
      ipAddress = '127.0.0.1';
    }
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Soft delete: set deleted_at timestamp instead of actually deleting
    await execute("UPDATE rr SET deleted_at = NOW() WHERE id = ?", [req.params.id]);

    // Log the deletion
    await logAction(
      req.user?.id || 0,
      'rr_delete',
      `Deleted DNS record: ${record.name} (${record.type}) = ${record.data} from zone ${record.zone_name}`,
      ipAddress,
      userAgent,
      'dns_record',
      record.id,
      {
        record_name: record.name,
        record_type: record.type,
        record_data: record.data,
        zone_name: record.zone_name
      }
    );

    // Trigger NOTIFY to slaves
    await triggerNotify(record.zone_name);

    res.status(204).send();
  } catch (error) {
    console.error("Failed to delete RR record:", error);
    res.status(500).json({ message: "Failed to delete record" });
  }
});

router.post("/:id/restore", async (req: any, res) => {
  try {
    // Get record details to verify it exists and is deleted
    const [records] = await query(
      `SELECT r.id, r.name, r.type, r.data, r.deleted_at, s.origin as zone_name
       FROM rr r
       JOIN soa s ON r.zone = s.id
       WHERE r.id = ?`,
      [req.params.id]
    );

    if (!records || records.length === 0) {
      return res.status(404).json({ message: "Record not found" });
    }

    const record = records[0];

    if (!record.deleted_at) {
      return res.status(400).json({ message: "Record is not deleted" });
    }

    // Get real client IP from proxy headers or socket
    let ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                    || (req.headers['x-real-ip'] as string)
                    || req.socket?.remoteAddress
                    || 'unknown';
    // Strip IPv4-mapped IPv6 prefix
    if (ipAddress.startsWith('::ffff:')) {
      ipAddress = ipAddress.substring(7);
    }
    // Normalize IPv6 localhost to IPv4
    if (ipAddress === '::1') {
      ipAddress = '127.0.0.1';
    }
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Restore the record by clearing deleted_at
    await execute("UPDATE rr SET deleted_at = NULL WHERE id = ?", [req.params.id]);

    // Log the restoration
    await logAction(
      req.user?.id || 0,
      'other',
      `Restored DNS record: ${record.name} (${record.type}) = ${record.data} in zone ${record.zone_name}`,
      ipAddress,
      userAgent,
      'dns_record',
      record.id,
      {
        record_name: record.name,
        record_type: record.type,
        record_data: record.data,
        zone_name: record.zone_name
      }
    );

    // Trigger NOTIFY to slaves
    await triggerNotify(record.zone_name);

    res.json({ success: true, message: "Record restored successfully" });
  } catch (error) {
    console.error("Failed to restore RR record:", error);
    res.status(500).json({ message: "Failed to restore record" });
  }
});

export default router;
