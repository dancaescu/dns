import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";

const router = Router();

const upsertSchema = z.object({
  zone: z.number().int().positive(),
  name: z.string().min(1),
  type: z.enum(["A", "AAAA", "CNAME", "HINFO", "MX", "NAPTR", "NS", "PTR", "RP", "SRV", "TXT"]),
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
     FROM rr WHERE zone = ? ORDER BY name ASC`,
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
  const result = await execute(
    `INSERT INTO rr
      (sys_userid, sys_groupid, sys_perm_user, sys_perm_group, sys_perm_other,
       zone, name, type, data, aux, ttl, user_id, version)
     VALUES (0, 0, 'riud', 'ri', 'r', ?, ?, ?, ?, ?, ?, 0, 1)`,
    [data.zone, data.name, data.type, data.data, data.aux, data.ttl],
  );
  res.status(201).json({ id: result.insertId });
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
  const setClause = fields.map((key) => `${key} = ?`).join(", ");
  const values = fields.map((key) => (updates as any)[key]);
  values.push(req.params.id);
  await execute(`UPDATE rr SET ${setClause} WHERE id = ?`, values);
  res.json({ success: true });
});

router.delete("/:id", async (req, res) => {
  await execute("DELETE FROM rr WHERE id = ?", [req.params.id]);
  res.status(204).send();
});

export default router;
