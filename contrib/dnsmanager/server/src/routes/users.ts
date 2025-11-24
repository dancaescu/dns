import { Router } from "express";
import { z } from "zod";
import { query, execute } from "../db.js";
import {
  hashPassword,
  getSession,
  hasPermission,
  isAccountAdmin,
  getUserAccounts,
  getActiveSessions,
  getLogs,
  logAction,
} from "../auth.js";

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

// Middleware to require superadmin role
function requireSuperadmin(req: any, res: any, next: any) {
  if (req.session.role !== "superadmin") {
    return res.status(403).json({ message: "Superadmin access required" });
  }
  next();
}

router.use(requireAuth);

const createUserSchema = z.object({
  username: z.string().min(3).max(100),
  email: z.string().email().max(255),
  password: z.string().min(6),
  full_name: z.string().max(255).optional(),
  role: z.enum(["superadmin", "account_admin", "user"]),
  active: z.boolean().default(true),
  require_2fa: z.boolean().default(false),
  twofa_method: z.enum(["email", "sms", "none"]).default("none"),
  twofa_contact: z.string().max(255).optional(),
  managed_by: z.number().int().positive().nullable().optional(),
});

const updateUserSchema = z.object({
  email: z.string().email().max(255).optional(),
  full_name: z.string().max(255).optional(),
  role: z.enum(["superadmin", "account_admin", "user"]).optional(),
  active: z.boolean().optional(),
  require_2fa: z.boolean().optional(),
  twofa_method: z.enum(["email", "sms", "none"]).optional(),
  twofa_contact: z.string().max(255).optional(),
  managed_by: z.number().int().positive().nullable().optional(),
});

const resetPasswordSchema = z.object({
  new_password: z.string().min(6),
});

const assignAccountSchema = z.object({
  account_id: z.number(),
  is_account_admin: z.boolean().default(false),
});

const grantPermissionSchema = z.object({
  permission_type: z.enum(["zone", "soa", "rr", "cloudflare", "user_management", "load_balancer"]),
  resource_id: z.number().nullable().optional(),
  can_view: z.boolean().default(true),
  can_add: z.boolean().default(false),
  can_edit: z.boolean().default(false),
  can_delete: z.boolean().default(false),
});

/**
 * GET /api/users
 * List all users (superadmin only)
 */
router.get("/", requireSuperadmin, async (req: any, res) => {
  try {
    const [rows] = await query(
      `SELECT u.id, u.username, u.email, u.full_name, u.role, u.active, u.require_2fa, u.twofa_method,
              u.twofa_contact, u.last_login, u.created_at, u.managed_by,
              m.username as managed_by_username
       FROM dnsmanager_users u
       LEFT JOIN dnsmanager_users m ON u.managed_by = m.id
       ORDER BY u.username`
    );
    res.json({ users: rows });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/users/accounts
 * List all accounts (superadmin and account admins)
 */
router.get("/accounts", requireAuth, async (req: any, res) => {
  try {
    const [rows] = await query(
      `SELECT id, name, cf_account_id
       FROM cloudflare_accounts
       WHERE deleted_at IS NULL
       ORDER BY name`
    );
    res.json({ accounts: rows });
  } catch (error) {
    console.error("List accounts error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/users/:id
 * Get user details
 */
router.get("/:id", async (req: any, res) => {
  const userId = Number(req.params.id);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Only superadmin or the user themselves can view details
    if (req.session.role !== "superadmin" && req.session.userId !== userId) {
      return res.status(403).json({ message: "Access denied" });
    }

    const [rows] = await query(
      `SELECT id, username, email, full_name, role, active, require_2fa, twofa_method,
              twofa_contact, last_login, created_at, updated_at
       FROM dnsmanager_users
       WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    // Get user's account assignments
    const [accounts] = await query(
      `SELECT ua.id, ua.account_id, ua.is_account_admin, ca.name as account_name
       FROM dnsmanager_user_accounts ua
       JOIN cloudflare_accounts ca ON ca.id = ua.account_id
       WHERE ua.user_id = ?`,
      [userId]
    );

    // Get user's permissions
    const [permissions] = await query(
      `SELECT id, permission_type, resource_id, can_view, can_add, can_edit, can_delete
       FROM dnsmanager_user_permissions
       WHERE user_id = ?`,
      [userId]
    );

    res.json({
      user,
      accounts,
      permissions,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/users
 * Create new user (superadmin or account_admin can create users)
 */
router.post("/", async (req: any, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Only superadmin can create superadmin or account_admin users
    if (parsed.data.role !== "user" && req.session.role !== "superadmin") {
      return res.status(403).json({ message: "Only superadmin can create admin users" });
    }

    // Check if username or email already exists
    const [existing] = await query(
      `SELECT id FROM dnsmanager_users WHERE username = ? OR email = ?`,
      [parsed.data.username, parsed.data.email]
    );

    if ((existing as any[]).length > 0) {
      return res.status(409).json({ message: "Username or email already exists" });
    }

    // Hash password
    const passwordHash = await hashPassword(parsed.data.password);

    // Create user
    const result = await execute(
      `INSERT INTO dnsmanager_users
       (username, email, password_hash, full_name, role, active, require_2fa, twofa_method, twofa_contact, managed_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.data.username,
        parsed.data.email,
        passwordHash,
        parsed.data.full_name || null,
        parsed.data.role,
        parsed.data.active ? 1 : 0,
        parsed.data.require_2fa ? 1 : 0,
        parsed.data.twofa_method || 'none',
        parsed.data.twofa_contact || null,
        parsed.data.managed_by || null,
        req.session.userId,
      ]
    );

    await logAction(
      req.session.userId,
      "user_create",
      `Created user ${parsed.data.username} with role ${parsed.data.role}`,
      ipAddress,
      userAgent,
      "user",
      result.insertId
    );

    res.status(201).json({
      success: true,
      userId: result.insertId,
    });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * PUT /api/users/:id
 * Update user
 */
router.put("/:id", async (req: any, res) => {
  const userId = Number(req.params.id);
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Only superadmin can update other users
    if (req.session.role !== "superadmin" && req.session.userId !== userId) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Only superadmin can change role
    if (parsed.data.role && req.session.role !== "superadmin") {
      return res.status(403).json({ message: "Only superadmin can change user roles" });
    }

    const updates = parsed.data;
    const fields = Object.keys(updates).filter((k) => updates[k as keyof typeof updates] !== undefined);

    if (fields.length === 0) {
      return res.status(400).json({ message: "No changes supplied" });
    }

    const setClause = fields.map((key) => `${key} = ?`).join(", ");
    const values: any[] = fields.map((key) => {
      const value = updates[key as keyof typeof updates];
      if (key === "active" || key === "require_2fa") return value ? 1 : 0;
      return value;
    });
    values.push(userId);

    await execute(`UPDATE dnsmanager_users SET ${setClause} WHERE id = ?`, values);

    // If user is being deactivated, terminate all their sessions
    if (updates.active === false) {
      await execute(`DELETE FROM dnsmanager_sessions WHERE user_id = ?`, [userId]);
      await logAction(
        req.session.userId,
        "user_update",
        `Terminated all sessions for deactivated user ${userId}`,
        ipAddress,
        userAgent,
        "user",
        userId
      );
    }

    await logAction(
      req.session.userId,
      "user_update",
      `Updated user ${userId}`,
      ipAddress,
      userAgent,
      "user",
      userId
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/users/:id
 * Delete user (superadmin only)
 */
router.delete("/:id", requireSuperadmin, async (req: any, res) => {
  const userId = Number(req.params.id);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Cannot delete yourself
    if (req.session.userId === userId) {
      return res.status(400).json({ message: "Cannot delete your own account" });
    }

    // Get username for logging
    const [rows] = await query<{ username: string }>(
      `SELECT username FROM dnsmanager_users WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const username = rows[0].username;

    await execute(`DELETE FROM dnsmanager_users WHERE id = ?`, [userId]);

    await logAction(
      req.session.userId,
      "user_delete",
      `Deleted user ${username}`,
      ipAddress,
      userAgent,
      "user",
      userId
    );

    res.status(204).send();
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/users/:id/reset-password
 * Reset user password (superadmin or account_admin can reset passwords)
 */
router.post("/:id/reset-password", async (req: any, res) => {
  const userId = Number(req.params.id);
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Only superadmin or account_admin can reset passwords
    if (req.session.role !== "superadmin" && req.session.role !== "account_admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    // Get username for logging
    const [rows] = await query<{ username: string }>(
      `SELECT username FROM dnsmanager_users WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const username = rows[0].username;

    // Hash new password
    const passwordHash = await hashPassword(parsed.data.new_password);

    // Update password
    await execute(
      `UPDATE dnsmanager_users SET password_hash = ? WHERE id = ?`,
      [passwordHash, userId]
    );

    // Terminate all sessions for security
    await execute(`DELETE FROM dnsmanager_sessions WHERE user_id = ?`, [userId]);

    await logAction(
      req.session.userId,
      "user_update",
      `Reset password for user ${username} (ID: ${userId})`,
      ipAddress,
      userAgent,
      "user",
      userId
    );

    res.json({ success: true, message: "Password reset successfully. User sessions have been terminated." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/users/account-admins
 * Get list of account admins (for assignment dropdown)
 */
router.get("/account-admins", requireAuth, async (req: any, res) => {
  try {
    // Superadmin can see all account_admins and superadmins
    const [rows] = await query(
      `SELECT id, username, email, full_name, role
       FROM dnsmanager_users
       WHERE (role = 'account_admin' OR role = 'superadmin') AND active = 1
       ORDER BY username`
    );
    res.json({ admins: rows });
  } catch (error) {
    console.error("List account admins error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/users/sessions/:sessionId
 * Terminate a specific session (superadmin only)
 */
router.delete("/sessions/:sessionId", requireSuperadmin, async (req: any, res) => {
  const sessionId = Number(req.params.sessionId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get session info before deleting
    const [rows] = await query<{ user_id: number; username: string }>(
      `SELECT s.user_id, u.username
       FROM dnsmanager_sessions s
       JOIN dnsmanager_users u ON s.user_id = u.id
       WHERE s.id = ?`,
      [sessionId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Session not found" });
    }

    const { user_id, username } = rows[0];

    // Delete the session
    await execute(`DELETE FROM dnsmanager_sessions WHERE id = ?`, [sessionId]);

    await logAction(
      req.session.userId,
      "user_update",
      `Terminated session ${sessionId} for user ${username} (ID: ${user_id})`,
      ipAddress,
      userAgent,
      "user",
      user_id
    );

    res.status(204).send();
  } catch (error) {
    console.error("Terminate session error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/users/:id/accounts
 * Assign user to a Cloudflare account
 */
router.post("/:id/accounts", async (req: any, res) => {
  const userId = Number(req.params.id);
  const parsed = assignAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Only superadmin or account admin can assign users to accounts
    if (req.session.role !== "superadmin") {
      const isAdmin = await isAccountAdmin(req.session.userId, parsed.data.account_id);
      if (!isAdmin) {
        return res.status(403).json({ message: "Only account admins can assign users" });
      }
    }

    // Check if already assigned
    const [existing] = await query(
      `SELECT id FROM dnsmanager_user_accounts WHERE user_id = ? AND account_id = ?`,
      [userId, parsed.data.account_id]
    );

    if ((existing as any[]).length > 0) {
      return res.status(409).json({ message: "User already assigned to this account" });
    }

    await execute(
      `INSERT INTO dnsmanager_user_accounts (user_id, account_id, is_account_admin, created_by)
       VALUES (?, ?, ?, ?)`,
      [userId, parsed.data.account_id, parsed.data.is_account_admin ? 1 : 0, req.session.userId]
    );

    await logAction(
      req.session.userId,
      "user_update",
      `Assigned user ${userId} to account ${parsed.data.account_id}`,
      ipAddress,
      userAgent,
      "user",
      userId
    );

    res.status(201).json({ success: true });
  } catch (error) {
    console.error("Assign account error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/users/:id/accounts/:accountAssignmentId
 * Remove user from account
 */
router.delete("/:id/accounts/:accountAssignmentId", async (req: any, res) => {
  const userId = Number(req.params.id);
  const assignmentId = Number(req.params.accountAssignmentId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Get account_id for permission check
    const [rows] = await query<{ account_id: number }>(
      `SELECT account_id FROM dnsmanager_user_accounts WHERE id = ?`,
      [assignmentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    const accountId = rows[0].account_id;

    // Only superadmin or account admin can remove users
    if (req.session.role !== "superadmin") {
      const isAdmin = await isAccountAdmin(req.session.userId, accountId);
      if (!isAdmin) {
        return res.status(403).json({ message: "Only account admins can remove users" });
      }
    }

    await execute(`DELETE FROM dnsmanager_user_accounts WHERE id = ?`, [assignmentId]);

    await logAction(
      req.session.userId,
      "user_update",
      `Removed user ${userId} from account ${accountId}`,
      ipAddress,
      userAgent,
      "user",
      userId
    );

    res.status(204).send();
  } catch (error) {
    console.error("Remove account error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/users/:id/permissions
 * Grant permission to user
 */
router.post("/:id/permissions", async (req: any, res) => {
  const userId = Number(req.params.id);
  const parsed = grantPermissionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Only superadmin or account admin can grant permissions
    if (req.session.role !== "superadmin" && req.session.role !== "account_admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    await execute(
      `INSERT INTO dnsmanager_user_permissions
       (user_id, permission_type, resource_id, can_view, can_add, can_edit, can_delete, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        parsed.data.permission_type,
        parsed.data.resource_id || null,
        parsed.data.can_view ? 1 : 0,
        parsed.data.can_add ? 1 : 0,
        parsed.data.can_edit ? 1 : 0,
        parsed.data.can_delete ? 1 : 0,
        req.session.userId,
      ]
    );

    await logAction(
      req.session.userId,
      "permission_grant",
      `Granted ${parsed.data.permission_type} permission to user ${userId}`,
      ipAddress,
      userAgent,
      "user",
      userId
    );

    res.status(201).json({ success: true });
  } catch (error) {
    console.error("Grant permission error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * DELETE /api/users/:id/permissions/:permissionId
 * Revoke permission
 */
router.delete("/:id/permissions/:permissionId", async (req: any, res) => {
  const userId = Number(req.params.id);
  const permissionId = Number(req.params.permissionId);
  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Only superadmin or account admin can revoke permissions
    if (req.session.role !== "superadmin" && req.session.role !== "account_admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    await execute(`DELETE FROM dnsmanager_user_permissions WHERE id = ? AND user_id = ?`, [permissionId, userId]);

    await logAction(
      req.session.userId,
      "permission_revoke",
      `Revoked permission ${permissionId} from user ${userId}`,
      ipAddress,
      userAgent,
      "user",
      userId
    );

    res.status(204).send();
  } catch (error) {
    console.error("Revoke permission error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/users/sessions/active
 * Get active sessions (superadmin only)
 */
router.get("/sessions/active", requireSuperadmin, async (req: any, res) => {
  try {
    const sessions = await getActiveSessions();
    res.json({ sessions });
  } catch (error) {
    console.error("Get active sessions error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/users/logs
 * Get audit logs (superadmin only)
 */
router.get("/logs", requireSuperadmin, async (req: any, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Number(req.query.offset) || 0;
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const actionType = req.query.actionType ? String(req.query.actionType) : undefined;

    const logs = await getLogs(limit, offset, userId, actionType);
    res.json({ logs });
  } catch (error) {
    console.error("Get logs error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
