import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";
import { generateAndImportKey, isDnssecKeygenAvailable } from "../dnssec-keygen.js";

const router = Router();

router.use(authenticate);

/**
 * Get DNSSEC status for all zones
 */
router.get("/zones", async (req, res) => {
  try {
    const [rows] = await query(`
      SELECT
        s.id,
        s.origin,
        dc.dnssec_enabled,
        dc.nsec_mode,
        dc.preferred_algorithm,
        dc.auto_sign,
        dc.signature_validity,
        dc.signature_refresh,
        (SELECT COUNT(*) FROM dnssec_keys WHERE zone_id = s.id AND active = TRUE) as active_keys,
        (SELECT COUNT(*) FROM dnssec_signatures WHERE zone_id = s.id) as signature_count
      FROM soa s
      LEFT JOIN dnssec_config dc ON s.id = dc.zone_id
      WHERE s.deleted_at IS NULL
      ORDER BY s.origin ASC
    `);
    res.json(rows);
  } catch (error: any) {
    console.error("Failed to fetch DNSSEC zones:", error);
    res.status(500).json({ message: "Failed to fetch DNSSEC zones" });
  }
});

/**
 * Get DNSSEC keys for a specific zone
 */
router.get("/keys/:zoneId", async (req, res) => {
  try {
    const [rows] = await query(`
      SELECT
        id,
        zone_id,
        algorithm,
        key_tag,
        is_ksk,
        public_key,
        private_key,
        active,
        created_at,
        activated_at,
        expires_at
      FROM dnssec_keys
      WHERE zone_id = ?
      ORDER BY is_ksk DESC, created_at DESC
    `, [req.params.zoneId]);

    // Don't send private keys to the client
    const sanitized = rows.map((row: any) => ({
      ...row,
      private_key: row.private_key ? "[PROTECTED]" : null,
    }));

    res.json(sanitized);
  } catch (error: any) {
    console.error("Failed to fetch DNSSEC keys:", error);
    res.status(500).json({ message: "Failed to fetch DNSSEC keys" });
  }
});

/**
 * Get DS records for parent zone delegation
 */
router.get("/ds-records/:zoneId", async (req, res) => {
  try {
    const [rows] = await query(`
      SELECT
        k.key_tag,
        k.algorithm,
        k.public_key,
        s.origin
      FROM dnssec_keys k
      JOIN soa s ON k.zone_id = s.id
      WHERE k.zone_id = ? AND k.is_ksk = TRUE AND k.active = TRUE
    `, [req.params.zoneId]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "No active KSK found for this zone" });
    }

    // Generate DS records (simplified - would need proper digest calculation)
    const dsRecords = rows.map((row: any) => ({
      key_tag: row.key_tag,
      algorithm: row.algorithm,
      digest_type: 2, // SHA-256
      digest: "[Generated via openssl - see documentation]",
      origin: row.origin,
    }));

    res.json(dsRecords);
  } catch (error: any) {
    console.error("Failed to fetch DS records:", error);
    res.status(500).json({ message: "Failed to fetch DS records" });
  }
});

/**
 * Get signing queue status
 */
router.get("/queue", async (req, res) => {
  try {
    const [rows] = await query(`
      SELECT
        q.id,
        q.zone_id,
        s.origin,
        q.status,
        q.reason,
        q.priority,
        q.created_at,
        q.started_at,
        q.completed_at,
        q.error_message
      FROM dnssec_signing_queue q
      JOIN soa s ON q.zone_id = s.id
      ORDER BY q.priority DESC, q.created_at ASC
      LIMIT 100
    `);
    res.json(rows);
  } catch (error: any) {
    console.error("Failed to fetch signing queue:", error);
    res.status(500).json({ message: "Failed to fetch signing queue" });
  }
});

/**
 * Get DNSSEC logs
 */
router.get("/logs/:zoneId", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  try {
    const [rows] = await query(`
      SELECT
        id,
        zone_id,
        operation,
        message,
        success,
        timestamp
      FROM dnssec_log
      WHERE zone_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `, [req.params.zoneId, limit]);

    res.json(rows);
  } catch (error: any) {
    console.error("Failed to fetch DNSSEC logs:", error);
    res.status(500).json({ message: "Failed to fetch DNSSEC logs" });
  }
});

/**
 * Enable DNSSEC for a zone
 */
const enableSchema = z.object({
  algorithm: z.number().int().min(8).max(16),
  nsec_mode: z.enum(["NSEC", "NSEC3"]),
  signature_validity: z.number().int().min(86400).default(2592000), // 30 days default
  signature_refresh: z.number().int().min(3600).default(604800), // 7 days default
  auto_sign: z.boolean().default(true),
});

router.post("/zones/:zoneId/enable", async (req: any, res) => {
  const parsed = enableSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }

  const data = parsed.data;
  const zoneId = Number(req.params.zoneId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Check if zone exists
    const [zoneRows] = await query("SELECT origin FROM soa WHERE id = ? AND deleted_at IS NULL", [zoneId]);
    if (zoneRows.length === 0) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const origin = zoneRows[0].origin;

    // Check if already enabled
    const [existingConfig] = await query("SELECT zone_id FROM dnssec_config WHERE zone_id = ?", [zoneId]);
    if (existingConfig.length > 0) {
      return res.status(409).json({ message: "DNSSEC already enabled for this zone" });
    }

    // Call stored procedure to enable DNSSEC
    await execute("CALL enable_zone_dnssec(?, ?, ?)", [
      zoneId,
      data.algorithm,
      data.nsec_mode,
    ]);

    // Update signature validity and refresh if different from defaults
    if (data.signature_validity !== 2592000 || data.signature_refresh !== 604800 || !data.auto_sign) {
      await execute(`
        UPDATE dnssec_config
        SET signature_validity = ?, signature_refresh = ?, auto_sign = ?
        WHERE zone_id = ?
      `, [data.signature_validity, data.signature_refresh, data.auto_sign, zoneId]);
    }

    await logAction(
      req.user.id,
      "dnssec_enable",
      `Enabled DNSSEC for zone ${origin} (algorithm ${data.algorithm}, ${data.nsec_mode})`,
      ipAddress,
      userAgent,
      "dnssec_config",
      zoneId
    );

    res.status(200).json({ success: true, message: "DNSSEC enabled successfully" });
  } catch (error: any) {
    console.error("Failed to enable DNSSEC:", error);
    res.status(500).json({ message: "Failed to enable DNSSEC", error: error.message });
  }
});

/**
 * Disable DNSSEC for a zone
 */
router.post("/zones/:zoneId/disable", async (req: any, res) => {
  const zoneId = Number(req.params.zoneId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get zone name
    const [zoneRows] = await query("SELECT origin FROM soa WHERE id = ? AND deleted_at IS NULL", [zoneId]);
    if (zoneRows.length === 0) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const origin = zoneRows[0].origin;

    // Call stored procedure to disable DNSSEC
    await execute("CALL disable_zone_dnssec(?)", [zoneId]);

    await logAction(
      req.user.id,
      "dnssec_disable",
      `Disabled DNSSEC for zone ${origin}`,
      ipAddress,
      userAgent,
      "dnssec_config",
      zoneId
    );

    res.status(200).json({ success: true, message: "DNSSEC disabled successfully" });
  } catch (error: any) {
    console.error("Failed to disable DNSSEC:", error);
    res.status(500).json({ message: "Failed to disable DNSSEC", error: error.message });
  }
});

/**
 * Generate new DNSSEC key (Note: This would require integration with dnssec library)
 */
const generateKeySchema = z.object({
  algorithm: z.number().int().min(8).max(16),
  key_size: z.number().int().min(256).max(4096).optional(),
  is_ksk: z.boolean(),
});

router.post("/keys/:zoneId/generate", async (req: any, res) => {
  const parsed = generateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }

  const data = parsed.data;
  const zoneId = Number(req.params.zoneId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Check if dnssec-keygen is available
    const hasKeygen = await isDnssecKeygenAvailable();
    if (!hasKeygen) {
      return res.status(503).json({
        message: "dnssec-keygen command not found",
        instructions: [
          "Install BIND tools to enable key generation:",
          "  Debian/Ubuntu: apt-get install bind9-utils",
          "  RHEL/CentOS: yum install bind-utils",
          "",
          "Or use manual key generation:",
          `  cd /etc/mydns/keys`,
          `  dnssec-keygen -a ECDSAP256SHA256 ${data.is_ksk ? '-f KSK ' : ''}-n ZONE zone.example.com.`,
        ],
      });
    }

    // Get zone name
    const [zoneRows] = await query("SELECT origin FROM soa WHERE id = ? AND deleted_at IS NULL", [zoneId]);
    if (zoneRows.length === 0) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const origin = zoneRows[0].origin;

    // Check if DNSSEC is enabled
    const [configRows] = await query("SELECT dnssec_enabled FROM dnssec_config WHERE zone_id = ?", [zoneId]);
    if (configRows.length === 0 || !configRows[0].dnssec_enabled) {
      return res.status(400).json({ message: "DNSSEC must be enabled before generating keys" });
    }

    // Generate and import key
    const result = await generateAndImportKey(
      { execute, query },
      zoneId,
      origin,
      data.algorithm,
      data.key_size || null,
      data.is_ksk,
      process.env.DNSSEC_KEYS_DIR || "/etc/mydns/keys"
    );

    await logAction(
      req.user.id,
      "dnssec_key_generate",
      `Generated ${data.is_ksk ? 'KSK' : 'ZSK'} key ${result.keyTag} for zone ${origin} (algorithm ${data.algorithm})`,
      ipAddress,
      userAgent,
      "dnssec_keys",
      result.keyId
    );

    res.status(201).json({
      success: true,
      message: "Key generated successfully",
      key_id: result.keyId,
      key_tag: result.keyTag,
    });
  } catch (error: any) {
    console.error("Failed to generate key:", error);
    res.status(500).json({ message: "Failed to generate key", error: error.message });
  }
});

/**
 * Queue zone for signing
 */
router.post("/zones/:zoneId/sign", async (req: any, res) => {
  const zoneId = Number(req.params.zoneId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get zone name
    const [zoneRows] = await query("SELECT origin FROM soa WHERE id = ? AND deleted_at IS NULL", [zoneId]);
    if (zoneRows.length === 0) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const origin = zoneRows[0].origin;

    // Call stored procedure to queue signing
    await execute("CALL queue_zone_signing(?, ?)", [zoneId, "manual"]);

    await logAction(
      req.user.id,
      "dnssec_sign_queue",
      `Queued zone ${origin} for DNSSEC signing`,
      ipAddress,
      userAgent,
      "dnssec_signing_queue",
      zoneId
    );

    res.status(200).json({ success: true, message: "Zone queued for signing" });
  } catch (error: any) {
    console.error("Failed to queue signing:", error);
    res.status(500).json({ message: "Failed to queue signing", error: error.message });
  }
});

/**
 * Delete/deactivate a key
 */
router.delete("/keys/:keyId", async (req: any, res) => {
  const keyId = Number(req.params.keyId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get key details
    const [keyRows] = await query(`
      SELECT k.zone_id, k.key_tag, k.is_ksk, s.origin
      FROM dnssec_keys k
      JOIN soa s ON k.zone_id = s.id
      WHERE k.id = ?
    `, [keyId]);

    if (keyRows.length === 0) {
      return res.status(404).json({ message: "Key not found" });
    }

    const key = keyRows[0];

    // Deactivate the key
    await execute("UPDATE dnssec_keys SET active = FALSE WHERE id = ?", [keyId]);

    await logAction(
      req.user.id,
      "dnssec_key_delete",
      `Deactivated ${key.is_ksk ? 'KSK' : 'ZSK'} key ${key.key_tag} for zone ${key.origin}`,
      ipAddress,
      userAgent,
      "dnssec_keys",
      keyId
    );

    res.status(200).json({ success: true, message: "Key deactivated" });
  } catch (error: any) {
    console.error("Failed to deactivate key:", error);
    res.status(500).json({ message: "Failed to deactivate key", error: error.message });
  }
});

export default router;
