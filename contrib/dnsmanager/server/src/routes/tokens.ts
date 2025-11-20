import { Router } from "express";
import { z } from "zod";
import { query, execute } from "../db.js";
import { getSession, logAction } from "../auth.js";
import { generateToken, hashToken } from "../tokenAuth.js";

const router = Router();

// Middleware to check authentication
async function requireAuth(req: any, res: any, next: any) {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const session = await getSession(sessionToken);
  if (!session) {
    return res.status(401).json({ message: "Invalid or expired session" });
  }

  req.session = session;
  next();
}

router.use(requireAuth);

const createTokenSchema = z.object({
  token_name: z.string().min(1).max(255),
  scopes: z.array(z.string()),
  expires_in_days: z.number().min(1).max(365).optional(),
});

/**
 * GET /api/tokens
 * List user's API tokens
 */
router.get("/", async (req: any, res) => {
  try {
    const [rows] = await query(
      `SELECT id, token_name, token_prefix, scopes, last_used, last_used_ip,
              expires_at, active, created_at
       FROM dnsadmin_tokens
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.session.userId]
    );

    res.json({ tokens: rows });
  } catch (error) {
    console.error("List tokens error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/tokens
 * Create new API token
 */
router.post("/", async (req: any, res) => {
  const parsed = createTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Generate token
    const { token, prefix } = generateToken();
    const tokenHash = await hashToken(token);

    // Calculate expiry
    let expiresAt = null;
    if (parsed.data.expires_in_days) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + parsed.data.expires_in_days);
      expiresAt = expiry;
    }

    // Validate scopes
    const allowedScopes = [
      "*",
      "zones:read",
      "zones:write",
      "records:read",
      "records:write",
      "soa:read",
      "soa:write",
      "rr:read",
      "rr:write",
      "cloudflare:read",
      "cloudflare:write",
    ];

    const invalidScopes = parsed.data.scopes.filter((s) => !allowedScopes.includes(s));
    if (invalidScopes.length > 0) {
      return res.status(400).json({
        message: "Invalid scopes",
        invalid_scopes: invalidScopes,
        allowed_scopes: allowedScopes,
      });
    }

    // Insert token
    const result = await execute(
      `INSERT INTO dnsadmin_tokens (user_id, token_name, token_hash, token_prefix, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.session.userId,
        parsed.data.token_name,
        tokenHash,
        prefix,
        JSON.stringify(parsed.data.scopes),
        expiresAt,
      ]
    );

    await logAction(
      req.session.userId,
      "other",
      `Created API token: ${parsed.data.token_name}`,
      ipAddress,
      userAgent
    );

    // Return the token ONLY THIS ONE TIME
    res.status(201).json({
      success: true,
      token_id: result.insertId,
      token: token, // This is the only time the user will see this!
      token_name: parsed.data.token_name,
      scopes: parsed.data.scopes,
      expires_at: expiresAt,
      message: "Save this token securely - you will not be able to see it again!",
    });
  } catch (error) {
    console.error("Create token error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/tokens/:id
 * Revoke/delete API token
 */
router.delete("/:id", async (req: any, res) => {
  const tokenId = Number(req.params.id);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Verify ownership
    const [rows] = await query<{ token_name: string }>(
      `SELECT token_name FROM dnsadmin_tokens WHERE id = ? AND user_id = ?`,
      [tokenId, req.session.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Token not found" });
    }

    const tokenName = rows[0].token_name;

    // Delete token
    await execute(`DELETE FROM dnsadmin_tokens WHERE id = ?`, [tokenId]);

    await logAction(
      req.session.userId,
      "other",
      `Revoked API token: ${tokenName}`,
      ipAddress,
      userAgent
    );

    res.status(204).send();
  } catch (error) {
    console.error("Delete token error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/tokens/:id/usage
 * Get token usage logs
 */
router.get("/:id/usage", async (req: any, res) => {
  const tokenId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 100, 1000);

  try {
    // Verify ownership
    const [tokens] = await query(
      `SELECT id FROM dnsadmin_tokens WHERE id = ? AND user_id = ?`,
      [tokenId, req.session.userId]
    );

    if (tokens.length === 0) {
      return res.status(404).json({ message: "Token not found" });
    }

    // Get usage logs
    const [logs] = await query(
      `SELECT id, endpoint, method, ip_address, response_status, created_at
       FROM dnsadmin_token_usage
       WHERE token_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [tokenId, limit]
    );

    res.json({ usage: logs });
  } catch (error) {
    console.error("Get token usage error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
