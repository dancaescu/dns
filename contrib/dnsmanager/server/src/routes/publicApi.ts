import { Router } from "express";
import { z } from "zod";
import { query, execute } from "../db.js";
import { authenticateToken, hasScope, logTokenUsage } from "../tokenAuth.js";
import { cloudflareCreateZone } from "../cloudflare.js";

const router = Router();

// Middleware to authenticate API token
async function requireToken(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.replace("Bearer ", "");
  const auth = await authenticateToken(token);

  if (!auth) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.tokenAuth = auth;
  next();
}

// Middleware to check scope
function requireScope(scope: string) {
  return (req: any, res: any, next: any) => {
    if (!hasScope(req.tokenAuth.scopes, scope)) {
      return res.status(403).json({ error: `Insufficient permissions. Required scope: ${scope}` });
    }
    next();
  };
}

// Log API usage after response
router.use((req: any, res, next) => {
  const originalSend = res.send;
  res.send = function (data: any) {
    if (req.tokenAuth) {
      const ipAddress = req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      logTokenUsage(
        req.tokenAuth.tokenId,
        req.originalUrl,
        req.method,
        ipAddress,
        userAgent,
        res.statusCode
      ).catch((err) => console.error("Failed to log token usage:", err));
    }
    return originalSend.call(this, data);
  };
  next();
});

router.use(requireToken);

// ============================================
// CLOUDFLARE ZONES API
// ============================================

const createZoneSchema = z.object({
  account_id: z.number(),
  zone_name: z.string().min(1),
  jump_start: z.boolean().default(false),
  zone_type: z.enum(["full", "partial"]).default("full"),
});

/**
 * POST /api/v1/zones
 * Create a new Cloudflare zone
 */
router.post("/zones", requireScope("zones:write"), async (req: any, res) => {
  const parsed = createZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  try {
    // Get the Cloudflare account ID
    const [accounts] = await query<{ cf_account_id: string }>(
      "SELECT cf_account_id FROM cloudflare_accounts WHERE id = ?",
      [parsed.data.account_id]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ error: "Account not found" });
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
        error: "Failed to create zone in Cloudflare",
        details: response.errors || [],
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
      zone: {
        id: result.insertId,
        cf_zone_id: cfZone.id,
        name: cfZone.name,
        status: cfZone.status,
        name_servers: cfZone.name_servers,
      },
    });
  } catch (error: any) {
    console.error("Create zone error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * GET /api/v1/zones
 * List Cloudflare zones
 */
router.get("/zones", requireScope("zones:read"), async (req: any, res) => {
  try {
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    const search = req.query.search ? String(req.query.search) : null;

    let sql = `SELECT z.id, z.cf_zone_id, z.name, z.status, z.paused, z.zone_type,
                      z.plan_name, z.last_synced, a.name AS account_name
               FROM cloudflare_zones z
               LEFT JOIN cloudflare_accounts a ON a.id = z.account_id
               WHERE 1=1`;
    const params: any[] = [];

    if (accountId) {
      sql += " AND z.account_id = ?";
      params.push(accountId);
    }

    if (search) {
      sql += " AND z.name LIKE ?";
      params.push(`%${search}%`);
    }

    sql += " ORDER BY z.name ASC";

    const [rows] = await query(sql, params);
    res.json({ zones: rows });
  } catch (error: any) {
    console.error("List zones error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * GET /api/v1/zones/:id
 * Get zone details
 */
router.get("/zones/:id", requireScope("zones:read"), async (req: any, res) => {
  try {
    const [rows] = await query(
      `SELECT z.*, a.name AS account_name, a.cf_account_id
       FROM cloudflare_zones z
       LEFT JOIN cloudflare_accounts a ON a.id = z.account_id
       WHERE z.id = ?`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Zone not found" });
    }

    res.json({ zone: rows[0] });
  } catch (error: any) {
    console.error("Get zone error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ============================================
// CLOUDFLARE RECORDS API
// ============================================

/**
 * GET /api/v1/zones/:zoneId/records
 * List DNS records for a zone
 */
router.get("/zones/:zoneId/records", requireScope("records:read"), async (req: any, res) => {
  try {
    const [rows] = await query(
      `SELECT id, cf_record_id, record_type, name, content, ttl, proxied,
              priority, modified_on, comment
       FROM cloudflare_records
       WHERE zone_id = ?
       ORDER BY record_type, name`,
      [req.params.zoneId]
    );

    res.json({ records: rows });
  } catch (error: any) {
    console.error("List records error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ============================================
// SOA RECORDS API
// ============================================

const createSoaSchema = z.object({
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
});

/**
 * GET /api/v1/soa
 * List SOA records
 */
router.get("/soa", requireScope("soa:read"), async (req: any, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Number(req.query.offset) || 0;
    const search = req.query.search ? String(req.query.search) : null;

    let sql = `SELECT id, origin, ns, mbox, serial, refresh, retry, expire,
                      minimum, ttl, active
               FROM soa WHERE 1=1`;
    const params: any[] = [];

    if (search) {
      sql += " AND origin LIKE ?";
      params.push(`%${search}%`);
    }

    sql += " ORDER BY origin ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const [rows] = await query(sql, params);
    res.json({ soa_records: rows });
  } catch (error: any) {
    console.error("List SOA error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * POST /api/v1/soa
 * Create SOA record
 */
router.post("/soa", requireScope("soa:write"), async (req: any, res) => {
  const parsed = createSoaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  try {
    const data = parsed.data;
    const result = await execute(
      `INSERT INTO soa
        (sys_userid, sys_groupid, user_id, sys_perm_user, sys_perm_group, sys_perm_other,
         origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, xfer, lastmodified)
       VALUES (0, 0, 0, 'riud', 'ri', 'r', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
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
      ]
    );

    res.status(201).json({ success: true, id: result.insertId });
  } catch (error: any) {
    console.error("Create SOA error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * PUT /api/v1/soa/:id
 * Update SOA record
 */
router.put("/soa/:id", requireScope("soa:write"), async (req: any, res) => {
  const parsed = createSoaSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  try {
    const updates = parsed.data;
    const fields = Object.keys(updates);

    if (fields.length === 0) {
      return res.status(400).json({ error: "No changes supplied" });
    }

    const setClause = fields.map((key) => `${key} = ?`).join(", ");
    const values = fields.map((key) => (updates as any)[key]);
    values.push(req.params.id);

    await execute(`UPDATE soa SET ${setClause} WHERE id = ?`, values);

    res.json({ success: true });
  } catch (error: any) {
    console.error("Update SOA error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * DELETE /api/v1/soa/:id
 * Delete SOA record
 */
router.delete("/soa/:id", requireScope("soa:write"), async (req: any, res) => {
  try {
    await execute("DELETE FROM soa WHERE id = ?", [req.params.id]);
    res.status(204).send();
  } catch (error: any) {
    console.error("Delete SOA error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ============================================
// RR (RESOURCE RECORDS) API
// ============================================

const createRrSchema = z.object({
  zone: z.number(),
  name: z.string(),
  type: z.string(),
  data: z.string(),
  aux: z.number().default(0),
  ttl: z.number().default(86400),
});

/**
 * GET /api/v1/rr
 * List RR records
 */
router.get("/rr", requireScope("rr:read"), async (req: any, res) => {
  try {
    const zone = req.query.zone ? Number(req.query.zone) : null;
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Number(req.query.offset) || 0;

    let sql = `SELECT id, zone, name, type, data, aux, ttl FROM rr WHERE 1=1`;
    const params: any[] = [];

    if (zone) {
      sql += " AND zone = ?";
      params.push(zone);
    }

    sql += " ORDER BY type, name LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const [rows] = await query(sql, params);
    res.json({ rr_records: rows });
  } catch (error: any) {
    console.error("List RR error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * POST /api/v1/rr
 * Create RR record
 */
router.post("/rr", requireScope("rr:write"), async (req: any, res) => {
  const parsed = createRrSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  try {
    const data = parsed.data;
    const result = await execute(
      `INSERT INTO rr (zone, name, type, data, aux, ttl) VALUES (?, ?, ?, ?, ?, ?)`,
      [data.zone, data.name, data.type, data.data, data.aux, data.ttl]
    );

    res.status(201).json({ success: true, id: result.insertId });
  } catch (error: any) {
    console.error("Create RR error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * PUT /api/v1/rr/:id
 * Update RR record
 */
router.put("/rr/:id", requireScope("rr:write"), async (req: any, res) => {
  const parsed = createRrSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  try {
    const updates = parsed.data;
    const fields = Object.keys(updates);

    if (fields.length === 0) {
      return res.status(400).json({ error: "No changes supplied" });
    }

    const setClause = fields.map((key) => `${key} = ?`).join(", ");
    const values = fields.map((key) => (updates as any)[key]);
    values.push(req.params.id);

    await execute(`UPDATE rr SET ${setClause} WHERE id = ?`, values);

    res.json({ success: true });
  } catch (error: any) {
    console.error("Update RR error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

/**
 * DELETE /api/v1/rr/:id
 * Delete RR record
 */
router.delete("/rr/:id", requireScope("rr:write"), async (req: any, res) => {
  try {
    await execute("DELETE FROM rr WHERE id = ?", [req.params.id]);
    res.status(204).send();
  } catch (error: any) {
    console.error("Delete RR error:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
