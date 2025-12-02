import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";

const router = Router();
router.use(authenticate);

/**
 * GET /api/zone-acls
 * List all ACLs (zone-specific and global) for the authenticated user
 */
router.get("/", async (req, res) => {
  const userId = (req as any).user?.userId;
  const accountId = (req as any).user?.accountId;

  if (!userId || !accountId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const [zoneAcls] = await query(
      `SELECT
        z.id, z.soa_id, s.origin AS zone_name, z.user_id, z.account_id,
        z.rule_name, z.rule_type, z.ip_address, z.cidr_mask,
        z.applies_to_query, z.applies_to_axfr, z.applies_to_notify,
        z.applies_to_update, z.applies_to_doh, z.priority, z.enabled,
        z.description, z.created_at, z.updated_at
      FROM dnsmanager_zone_acls z
      JOIN soa s ON z.soa_id = s.id
      WHERE z.user_id = ? OR z.account_id = ?
      ORDER BY z.priority ASC, z.created_at DESC`,
      [userId, accountId]
    );

    const [globalAcls] = await query(
      `SELECT
        id, user_id, account_id, rule_name, rule_type, ip_address, cidr_mask,
        applies_to_query, applies_to_axfr, applies_to_notify,
        applies_to_update, applies_to_doh, priority, enabled,
        description, created_at, updated_at
      FROM dnsmanager_global_acls
      WHERE (user_id = ? OR user_id IS NULL) AND account_id = ?
      ORDER BY priority ASC, created_at DESC`,
      [userId, accountId]
    );

    res.json({
      zoneAcls,
      globalAcls,
    });
  } catch (error: any) {
    console.error("Error fetching ACLs:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/zone-acls/zone/:soaId
 * Get all ACLs for a specific zone
 */
router.get("/zone/:soaId", async (req, res) => {
  const userId = (req as any).user?.userId;
  const accountId = (req as any).user?.accountId;
  const soaId = parseInt(req.params.soaId);

  if (!userId || !accountId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const [acls] = await query(
      `SELECT
        z.id, z.soa_id, s.origin AS zone_name, z.user_id, z.account_id,
        z.rule_name, z.rule_type, z.ip_address, z.cidr_mask,
        z.applies_to_query, z.applies_to_axfr, z.applies_to_notify,
        z.applies_to_update, z.applies_to_doh, z.priority, z.enabled,
        z.description, z.created_at, z.updated_at
      FROM dnsmanager_zone_acls z
      JOIN soa s ON z.soa_id = s.id
      WHERE z.soa_id = ? AND (z.user_id = ? OR z.account_id = ?)
      ORDER BY z.priority ASC`,
      [soaId, userId, accountId]
    );

    res.json(acls);
  } catch (error: any) {
    console.error("Error fetching zone ACLs:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/zone-acls/zone
 * Create a new zone-specific ACL
 */
const createZoneAclSchema = z.object({
  soa_id: z.number(),
  account_id: z.number(),
  rule_name: z.string().min(1).max(255),
  rule_type: z.enum(["allow", "deny"]),
  ip_address: z.string().ip(),
  cidr_mask: z.number().min(0).max(128).optional(),
  applies_to_query: z.boolean().default(true),
  applies_to_axfr: z.boolean().default(false),
  applies_to_notify: z.boolean().default(false),
  applies_to_update: z.boolean().default(false),
  applies_to_doh: z.boolean().default(true),
  priority: z.number().default(100),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});

router.post("/zone", async (req, res) => {
  const userId = (req as any).user?.userId;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const parsed = createZoneAclSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  try {
    // Verify user has access to this zone
    const [zones] = await query(
      "SELECT id FROM soa WHERE id = ?",
      [parsed.data.soa_id]
    );

    if (zones.length === 0) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const [result] = await execute(
      `INSERT INTO dnsmanager_zone_acls (
        soa_id, user_id, account_id, rule_name, rule_type,
        ip_address, cidr_mask, applies_to_query, applies_to_axfr,
        applies_to_notify, applies_to_update, applies_to_doh,
        priority, enabled, description, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.data.soa_id,
        userId,
        parsed.data.account_id,
        parsed.data.rule_name,
        parsed.data.rule_type,
        parsed.data.ip_address,
        parsed.data.cidr_mask || null,
        parsed.data.applies_to_query,
        parsed.data.applies_to_axfr,
        parsed.data.applies_to_notify,
        parsed.data.applies_to_update,
        parsed.data.applies_to_doh,
        parsed.data.priority,
        parsed.data.enabled,
        parsed.data.description || null,
        userId,
      ]
    );

    await logAction({
      userId,
      accountId: parsed.data.account_id,
      action: "zone_acl_created",
      target: `soa:${parsed.data.soa_id}`,
      description: `Created zone ACL: ${parsed.data.rule_name} (${parsed.data.rule_type})`,
    });

    res.status(201).json({
      message: "Zone ACL created successfully",
      id: (result as any).insertId,
    });
  } catch (error: any) {
    console.error("Error creating zone ACL:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/zone-acls/global
 * Create a new global ACL
 */
const createGlobalAclSchema = z.object({
  account_id: z.number(),
  rule_name: z.string().min(1).max(255),
  rule_type: z.enum(["allow", "deny"]),
  ip_address: z.string().ip(),
  cidr_mask: z.number().min(0).max(128).optional(),
  applies_to_query: z.boolean().default(true),
  applies_to_axfr: z.boolean().default(false),
  applies_to_notify: z.boolean().default(false),
  applies_to_update: z.boolean().default(false),
  applies_to_doh: z.boolean().default(true),
  priority: z.number().default(100),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  applies_to_all_users: z.boolean().default(false),
});

router.post("/global", async (req, res) => {
  const userId = (req as any).user?.userId;
  const userRole = (req as any).user?.role;

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const parsed = createGlobalAclSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  // Only account admins can create account-wide ACLs
  if (parsed.data.applies_to_all_users && userRole !== "account_admin" && userRole !== "superadmin") {
    return res.status(403).json({ message: "Only account admins can create account-wide ACLs" });
  }

  try {
    const [result] = await execute(
      `INSERT INTO dnsmanager_global_acls (
        user_id, account_id, rule_name, rule_type,
        ip_address, cidr_mask, applies_to_query, applies_to_axfr,
        applies_to_notify, applies_to_update, applies_to_doh,
        priority, enabled, description, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.data.applies_to_all_users ? null : userId,
        parsed.data.account_id,
        parsed.data.rule_name,
        parsed.data.rule_type,
        parsed.data.ip_address,
        parsed.data.cidr_mask || null,
        parsed.data.applies_to_query,
        parsed.data.applies_to_axfr,
        parsed.data.applies_to_notify,
        parsed.data.applies_to_update,
        parsed.data.applies_to_doh,
        parsed.data.priority,
        parsed.data.enabled,
        parsed.data.description || null,
        userId,
      ]
    );

    await logAction({
      userId,
      accountId: parsed.data.account_id,
      action: "global_acl_created",
      target: `account:${parsed.data.account_id}`,
      description: `Created global ACL: ${parsed.data.rule_name} (${parsed.data.rule_type})`,
    });

    res.status(201).json({
      message: "Global ACL created successfully",
      id: (result as any).insertId,
    });
  } catch (error: any) {
    console.error("Error creating global ACL:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * PUT /api/zone-acls/zone/:id
 * Update a zone-specific ACL
 */
const updateAclSchema = z.object({
  rule_name: z.string().min(1).max(255).optional(),
  rule_type: z.enum(["allow", "deny"]).optional(),
  ip_address: z.string().ip().optional(),
  cidr_mask: z.number().min(0).max(128).optional(),
  applies_to_query: z.boolean().optional(),
  applies_to_axfr: z.boolean().optional(),
  applies_to_notify: z.boolean().optional(),
  applies_to_update: z.boolean().optional(),
  applies_to_doh: z.boolean().optional(),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});

router.put("/zone/:id", async (req, res) => {
  const userId = (req as any).user?.userId;
  const aclId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const parsed = updateAclSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  try {
    // Verify ownership
    const [existing] = await query(
      "SELECT id, user_id FROM dnsmanager_zone_acls WHERE id = ?",
      [aclId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "ACL not found" });
    }

    if ((existing[0] as any).user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];

    Object.entries(parsed.data).forEach(([key, value]) => {
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (updates.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    values.push(aclId);

    await execute(
      `UPDATE dnsmanager_zone_acls SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await logAction({
      userId,
      accountId: (req as any).user?.accountId,
      action: "zone_acl_updated",
      target: `acl:${aclId}`,
      description: `Updated zone ACL`,
    });

    res.json({ message: "ACL updated successfully" });
  } catch (error: any) {
    console.error("Error updating zone ACL:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * PUT /api/zone-acls/global/:id
 * Update a global ACL
 */
router.put("/global/:id", async (req, res) => {
  const userId = (req as any).user?.userId;
  const aclId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const parsed = updateAclSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  try {
    // Verify ownership
    const [existing] = await query(
      "SELECT id, user_id, created_by FROM dnsmanager_global_acls WHERE id = ?",
      [aclId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "ACL not found" });
    }

    const existingAcl = existing[0] as any;

    // Check if user can modify this ACL
    if (existingAcl.user_id && existingAcl.user_id !== userId && existingAcl.created_by !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];

    Object.entries(parsed.data).forEach(([key, value]) => {
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (updates.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    values.push(aclId);

    await execute(
      `UPDATE dnsmanager_global_acls SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await logAction({
      userId,
      accountId: (req as any).user?.accountId,
      action: "global_acl_updated",
      target: `acl:${aclId}`,
      description: `Updated global ACL`,
    });

    res.json({ message: "ACL updated successfully" });
  } catch (error: any) {
    console.error("Error updating global ACL:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/zone-acls/zone/:id
 * Delete a zone-specific ACL
 */
router.delete("/zone/:id", async (req, res) => {
  const userId = (req as any).user?.userId;
  const aclId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    // Verify ownership
    const [existing] = await query(
      "SELECT id, user_id, rule_name FROM dnsmanager_zone_acls WHERE id = ?",
      [aclId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "ACL not found" });
    }

    if ((existing[0] as any).user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await execute("DELETE FROM dnsmanager_zone_acls WHERE id = ?", [aclId]);

    await logAction({
      userId,
      accountId: (req as any).user?.accountId,
      action: "zone_acl_deleted",
      target: `acl:${aclId}`,
      description: `Deleted zone ACL: ${(existing[0] as any).rule_name}`,
    });

    res.json({ message: "ACL deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting zone ACL:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/zone-acls/global/:id
 * Delete a global ACL
 */
router.delete("/global/:id", async (req, res) => {
  const userId = (req as any).user?.userId;
  const aclId = parseInt(req.params.id);

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    // Verify ownership
    const [existing] = await query(
      "SELECT id, user_id, created_by, rule_name FROM dnsmanager_global_acls WHERE id = ?",
      [aclId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "ACL not found" });
    }

    const existingAcl = existing[0] as any;

    if (existingAcl.user_id && existingAcl.user_id !== userId && existingAcl.created_by !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await execute("DELETE FROM dnsmanager_global_acls WHERE id = ?", [aclId]);

    await logAction({
      userId,
      accountId: (req as any).user?.accountId,
      action: "global_acl_deleted",
      target: `acl:${aclId}`,
      description: `Deleted global ACL: ${existingAcl.rule_name}`,
    });

    res.json({ message: "ACL deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting global ACL:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/zone-acls/stats
 * Get ACL statistics
 */
router.get("/stats", async (req, res) => {
  const userId = (req as any).user?.userId;
  const accountId = (req as any).user?.accountId;

  if (!userId || !accountId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const [stats] = await query(
      `SELECT
        s.acl_id, z.rule_name, z.rule_type,
        COUNT(*) AS total_hits,
        SUM(CASE WHEN s.action_taken = 'allowed' THEN 1 ELSE 0 END) AS allowed_count,
        SUM(CASE WHEN s.action_taken = 'denied' THEN 1 ELSE 0 END) AS denied_count,
        MAX(s.timestamp) AS last_hit
      FROM dnsmanager_zone_acl_stats s
      JOIN dnsmanager_zone_acls z ON s.acl_id = z.id
      WHERE z.user_id = ? OR z.account_id = ?
      GROUP BY s.acl_id, z.rule_name, z.rule_type
      ORDER BY total_hits DESC
      LIMIT 100`,
      [userId, accountId]
    );

    res.json(stats);
  } catch (error: any) {
    console.error("Error fetching ACL stats:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
