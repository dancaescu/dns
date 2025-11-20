import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { query, execute } from "../db.js";
import { getSession, logAction } from "../auth.js";

const router = Router();

// Simple encryption for sensitive settings (base64 + XOR with key)
// Note: For production, consider using a proper encryption library
const ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || "change-this-key-in-production";

function encryptValue(value: string): string {
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32)), Buffer.alloc(16, 0));
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

function decryptValue(encrypted: string): string {
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32)), Buffer.alloc(16, 0));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    return "";
  }
}

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

// Middleware to require superadmin role
function requireSuperadmin(req: any, res: any, next: any) {
  if (req.session.role !== "superadmin") {
    return res.status(403).json({ message: "Superadmin access required" });
  }
  next();
}

router.use(requireAuth);
router.use(requireSuperadmin);

const updateSettingSchema = z.object({
  setting_value: z.string(),
});

/**
 * GET /api/settings
 * Get all settings (superadmin only)
 */
router.get("/", async (req: any, res) => {
  try {
    const [rows] = await query<{
      id: number;
      setting_key: string;
      setting_value: string;
      is_encrypted: number;
      description: string | null;
      updated_at: Date;
    }>(
      `SELECT id, setting_key, setting_value, is_encrypted, description, updated_at
       FROM dnsmanager_settings
       ORDER BY setting_key`
    );

    // Decrypt encrypted values
    const settings = rows.map((row) => ({
      ...row,
      setting_value: row.is_encrypted ? decryptValue(row.setting_value) : row.setting_value,
    }));

    res.json({ settings });
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/settings/:key
 * Get specific setting by key
 */
router.get("/:key", async (req: any, res) => {
  try {
    const [rows] = await query<{
      id: number;
      setting_key: string;
      setting_value: string;
      is_encrypted: number;
      description: string | null;
      updated_at: Date;
    }>(
      `SELECT id, setting_key, setting_value, is_encrypted, description, updated_at
       FROM dnsmanager_settings
       WHERE setting_key = ?`,
      [req.params.key]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Setting not found" });
    }

    const setting = rows[0];
    if (setting.is_encrypted) {
      setting.setting_value = decryptValue(setting.setting_value);
    }

    res.json({ setting });
  } catch (error) {
    console.error("Get setting error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * PUT /api/settings/:key
 * Update setting value
 */
router.put("/:key", async (req: any, res) => {
  const parsed = updateSettingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Check if setting exists and if it's encrypted
    const [rows] = await query<{ is_encrypted: number }>(
      `SELECT is_encrypted FROM dnsmanager_settings WHERE setting_key = ?`,
      [req.params.key]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Setting not found" });
    }

    const isEncrypted = rows[0].is_encrypted;
    const valueToStore = isEncrypted ? encryptValue(parsed.data.setting_value) : parsed.data.setting_value;

    await execute(
      `UPDATE dnsmanager_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?`,
      [valueToStore, req.session.userId, req.params.key]
    );

    await logAction(
      req.session.userId,
      "settings_update",
      `Updated setting ${req.params.key}`,
      ipAddress,
      userAgent
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Update setting error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/settings
 * Create new setting
 */
router.post("/", async (req: any, res) => {
  const schema = z.object({
    setting_key: z.string().min(1).max(100),
    setting_value: z.string(),
    is_encrypted: z.boolean().default(false),
    description: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Check if setting already exists
    const [existing] = await query(
      `SELECT id FROM dnsmanager_settings WHERE setting_key = ?`,
      [parsed.data.setting_key]
    );

    if ((existing as any[]).length > 0) {
      return res.status(409).json({ message: "Setting already exists" });
    }

    const valueToStore = parsed.data.is_encrypted
      ? encryptValue(parsed.data.setting_value)
      : parsed.data.setting_value;

    await execute(
      `INSERT INTO dnsmanager_settings (setting_key, setting_value, is_encrypted, description, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        parsed.data.setting_key,
        valueToStore,
        parsed.data.is_encrypted ? 1 : 0,
        parsed.data.description || null,
        req.session.userId,
      ]
    );

    await logAction(
      req.session.userId,
      "settings_update",
      `Created setting ${parsed.data.setting_key}`,
      ipAddress,
      userAgent
    );

    res.status(201).json({ success: true });
  } catch (error) {
    console.error("Create setting error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/settings/:key
 * Delete setting
 */
router.delete("/:key", async (req: any, res) => {
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    await execute(`DELETE FROM dnsmanager_settings WHERE setting_key = ?`, [req.params.key]);

    await logAction(
      req.session.userId,
      "settings_update",
      `Deleted setting ${req.params.key}`,
      ipAddress,
      userAgent
    );

    res.status(204).send();
  } catch (error) {
    console.error("Delete setting error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
