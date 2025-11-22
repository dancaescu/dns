import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";

const router = Router();

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
});

router.use(authenticate);

router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const search = typeof req.query.search === "string" ? `%${req.query.search}%` : null;
  let sql = "SELECT id, origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active FROM soa WHERE deleted_at IS NULL";
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
         expire = ?, minimum = ?, ttl = ?, active = ?, xfer = ? WHERE id = ?`,
        [data.ns, data.mbox, data.serial, data.refresh, data.retry, data.expire,
         data.minimum, data.ttl, data.active, data.xfer || "", record.id]
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
         origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, xfer, lastmodified)
       VALUES (0, 0, 0, 'riud', 'ri', 'r', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
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

  res.status(204).send();
});

export default router;
