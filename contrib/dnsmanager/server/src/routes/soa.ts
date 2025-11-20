import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";

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
  let sql = "SELECT id, origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active FROM soa";
  const params: unknown[] = [];
  if (search) {
    sql += " WHERE origin LIKE ?";
    params.push(search);
  }
  sql += " ORDER BY origin ASC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const [rows] = await query(sql, params);
  res.json(rows);
});

router.post("/", async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const data = parsed.data;
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
  res.status(201).json({ id: result.insertId });
});

router.put("/:id", async (req, res) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const updates = parsed.data;
  const fields = Object.keys(updates);
  if (!fields.length) {
    return res.status(400).json({ message: "No changes supplied" });
  }
  const setClause = fields.map((key) => `${key} = ?`).join(", ");
  const values = fields.map((key) => (updates as any)[key]);
  values.push(req.params.id);
  await execute(`UPDATE soa SET ${setClause} WHERE id = ?`, values);
  res.json({ success: true });
});

router.delete("/:id", async (req, res) => {
  await execute("DELETE FROM soa WHERE id = ?", [req.params.id]);
  res.status(204).send();
});

export default router;
