import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";
import crypto from "crypto";

const router = Router();
router.use(authenticate);

// Encryption key for API keys (should be in environment variable)
const ENCRYPTION_KEY = process.env.CF_ENCRYPTION_KEY || "CHANGE_THIS_TO_SECURE_KEY_32_CHARS_LONG!!!";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";

/**
 * Encrypt a Cloudflare API key before storing in database
 */
function encryptApiKey(apiKey: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, Buffer.from(ENCRYPTION_KEY.slice(0, 32)), iv);

  let encrypted = cipher.update(apiKey, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt a Cloudflare API key from database
 */
function decryptApiKey(encryptedData: string): string {
  const [ivHex, authTagHex, encrypted] = encryptedData.split(":");

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, Buffer.from(ENCRYPTION_KEY.slice(0, 32)), iv);

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * GET /api/user-cloudflare/credentials
 * List all Cloudflare credentials for the authenticated user
 */
router.get("/credentials", async (req, res) => {
  const userId = (req as any).user?.userId;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const [rows] = await query(
      `SELECT
        id, user_id, account_id, cf_email, cf_account_id, cf_domain,
        cf_api_url, enabled, auto_sync, sync_frequency,
        last_sync_at, last_sync_status, last_sync_error,
        created_at, updated_at
      FROM dnsmanager_cloudflare_credentials
      WHERE user_id = ?
      ORDER BY created_at DESC`,
      [userId]
    );

    // Don't return the actual API key
    res.json(rows);
  } catch (error: any) {
    console.error("Error fetching CF credentials:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/user-cloudflare/credentials
 * Add new Cloudflare credentials for the authenticated user
 */
const createCredentialSchema = z.object({
  account_id: z.number(),
  cf_email: z.string().email(),
  cf_api_key: z.string().min(32),
  cf_account_id: z.string().min(32),
  cf_domain: z.string().optional(),
  cf_api_url: z.string().url().default("https://api.cloudflare.com/client/v4"),
  enabled: z.boolean().default(true),
  auto_sync: z.boolean().default(true),
  sync_frequency: z.number().default(300),
});

router.post("/credentials", async (req, res) => {
  const userId = (req as any).user?.userId;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const parsed = createCredentialSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  try {
    // Encrypt the API key before storing
    const encryptedApiKey = encryptApiKey(parsed.data.cf_api_key);

    const [result] = await execute(
      `INSERT INTO dnsmanager_cloudflare_credentials (
        user_id, account_id, cf_email, cf_api_key, cf_account_id,
        cf_domain, cf_api_url, enabled, auto_sync, sync_frequency,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        parsed.data.account_id,
        parsed.data.cf_email,
        encryptedApiKey,
        parsed.data.cf_account_id,
        parsed.data.cf_domain || null,
        parsed.data.cf_api_url,
        parsed.data.enabled,
        parsed.data.auto_sync,
        parsed.data.sync_frequency,
        userId,
      ]
    );

    await logAction({
      userId,
      accountId: parsed.data.account_id,
      action: "cloudflare_credential_created",
      target: `cf_account:${parsed.data.cf_account_id}`,
      description: `Added Cloudflare credentials for ${parsed.data.cf_email}`,
    });

    res.status(201).json({
      message: "Cloudflare credentials added successfully",
      id: (result as any).insertId,
    });
  } catch (error: any) {
    console.error("Error creating CF credentials:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Credentials for this CF account already exist" });
    }

    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * PUT /api/user-cloudflare/credentials/:id
 * Update Cloudflare credentials
 */
const updateCredentialSchema = z.object({
  cf_email: z.string().email().optional(),
  cf_api_key: z.string().min(32).optional(),
  cf_domain: z.string().optional(),
  enabled: z.boolean().optional(),
  auto_sync: z.boolean().optional(),
  sync_frequency: z.number().optional(),
});

router.put("/credentials/:id", async (req, res) => {
  const userId = (req as any).user?.userId;
  const credentialId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const parsed = updateCredentialSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  try {
    // Verify ownership
    const [existing] = await query(
      "SELECT id, user_id, cf_account_id FROM dnsmanager_cloudflare_credentials WHERE id = ?",
      [credentialId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Credential not found" });
    }

    if ((existing[0] as any).user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];

    if (parsed.data.cf_email) {
      updates.push("cf_email = ?");
      values.push(parsed.data.cf_email);
    }

    if (parsed.data.cf_api_key) {
      updates.push("cf_api_key = ?");
      values.push(encryptApiKey(parsed.data.cf_api_key));
    }

    if (parsed.data.cf_domain !== undefined) {
      updates.push("cf_domain = ?");
      values.push(parsed.data.cf_domain || null);
    }

    if (parsed.data.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(parsed.data.enabled);
    }

    if (parsed.data.auto_sync !== undefined) {
      updates.push("auto_sync = ?");
      values.push(parsed.data.auto_sync);
    }

    if (parsed.data.sync_frequency !== undefined) {
      updates.push("sync_frequency = ?");
      values.push(parsed.data.sync_frequency);
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    values.push(credentialId);

    await execute(
      `UPDATE dnsmanager_cloudflare_credentials SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await logAction({
      userId,
      accountId: (req as any).user?.accountId,
      action: "cloudflare_credential_updated",
      target: `credential:${credentialId}`,
      description: `Updated Cloudflare credentials`,
    });

    res.json({ message: "Credentials updated successfully" });
  } catch (error: any) {
    console.error("Error updating CF credentials:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/user-cloudflare/credentials/:id
 * Delete Cloudflare credentials
 */
router.delete("/credentials/:id", async (req, res) => {
  const userId = (req as any).user?.userId;
  const credentialId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    // Verify ownership
    const [existing] = await query(
      "SELECT id, user_id, cf_account_id FROM dnsmanager_cloudflare_credentials WHERE id = ?",
      [credentialId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Credential not found" });
    }

    if ((existing[0] as any).user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await execute(
      "DELETE FROM dnsmanager_cloudflare_credentials WHERE id = ?",
      [credentialId]
    );

    await logAction({
      userId,
      accountId: (req as any).user?.accountId,
      action: "cloudflare_credential_deleted",
      target: `credential:${credentialId}`,
      description: `Deleted Cloudflare credentials for ${(existing[0] as any).cf_account_id}`,
    });

    res.json({ message: "Credentials deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting CF credentials:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/user-cloudflare/credentials/:id/test
 * Test Cloudflare credentials by making an API call
 */
router.post("/credentials/:id/test", async (req, res) => {
  const userId = (req as any).user?.userId;
  const credentialId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    // Get credentials
    const [creds] = await query(
      `SELECT cf_email, cf_api_key, cf_api_url, cf_account_id, user_id
       FROM dnsmanager_cloudflare_credentials WHERE id = ?`,
      [credentialId]
    );

    if (creds.length === 0) {
      return res.status(404).json({ message: "Credential not found" });
    }

    if ((creds[0] as any).user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const credential = creds[0] as any;
    const apiKey = decryptApiKey(credential.cf_api_key);

    // Test API call to Cloudflare
    const fetch = (await import("node-fetch")).default;
    const response = await fetch(`${credential.cf_api_url}/user/tokens/verify`, {
      headers: {
        "X-Auth-Email": credential.cf_email,
        "X-Auth-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if ((data as any).success) {
      // Update last sync status
      await execute(
        `UPDATE dnsmanager_cloudflare_credentials
         SET last_sync_status = 'success', last_sync_at = NOW()
         WHERE id = ?`,
        [credentialId]
      );

      res.json({
        success: true,
        message: "Cloudflare credentials are valid",
        data: (data as any).result,
      });
    } else {
      await execute(
        `UPDATE dnsmanager_cloudflare_credentials
         SET last_sync_status = 'failed', last_sync_error = ?
         WHERE id = ?`,
        [JSON.stringify((data as any).errors), credentialId]
      );

      res.status(400).json({
        success: false,
        message: "Cloudflare credentials are invalid",
        errors: (data as any).errors,
      });
    }
  } catch (error: any) {
    console.error("Error testing CF credentials:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

/**
 * POST /api/user-cloudflare/credentials/:id/sync
 * Manually trigger sync for specific credentials
 */
router.post("/credentials/:id/sync", async (req, res) => {
  const userId = (req as any).user?.userId;
  const credentialId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    // Verify ownership
    const [creds] = await query(
      "SELECT id, user_id, cf_account_id, enabled FROM dnsmanager_cloudflare_credentials WHERE id = ?",
      [credentialId]
    );

    if (creds.length === 0) {
      return res.status(404).json({ message: "Credential not found" });
    }

    if ((creds[0] as any).user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!(creds[0] as any).enabled) {
      return res.status(400).json({ message: "Credential is disabled" });
    }

    // Trigger sync (this would call the Python script or internal sync logic)
    // For now, just update the timestamp
    await execute(
      `UPDATE dnsmanager_cloudflare_credentials
       SET last_sync_at = NOW(), last_sync_status = 'pending'
       WHERE id = ?`,
      [credentialId]
    );

    await logAction({
      userId,
      accountId: (req as any).user?.accountId,
      action: "cloudflare_sync_triggered",
      target: `credential:${credentialId}`,
      description: `Manually triggered Cloudflare sync`,
    });

    res.json({ message: "Sync triggered successfully" });
  } catch (error: any) {
    console.error("Error triggering CF sync:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
