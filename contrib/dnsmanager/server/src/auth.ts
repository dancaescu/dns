import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { jwtSecret } from "./config.js";
import { query, execute } from "./db.js";

const SALT_ROUNDS = 10;

export interface User {
  id: number;
  username: string;
  email: string;
  full_name: string | null;
  role: "superadmin" | "account_admin" | "user";
  active: number;
  require_2fa: number;
  twofa_method: "email" | "sms" | "none";
  twofa_contact: string | null;
}

export interface SessionData {
  userId: number;
  username: string;
  role: string;
  sessionToken: string;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a JWT token
 */
export function generateToken(payload: SessionData): string {
  return jwt.sign(payload, jwtSecret, { expiresIn: "7d" });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): SessionData | null {
  try {
    return jwt.verify(token, jwtSecret) as SessionData;
  } catch (error) {
    return null;
  }
}

/**
 * Generate a random 6-digit 2FA code
 */
export function generate2FACode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Store 2FA code for user (expires in 10 minutes)
 */
export async function store2FACode(userId: number, code: string): Promise<void> {
  const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await execute(
    `UPDATE dnsmanager_users SET twofa_secret = ?, twofa_secret_expiry = ? WHERE id = ?`,
    [code, expiry, userId]
  );
}

/**
 * Verify 2FA code for user
 */
export async function verify2FACode(userId: number, code: string): Promise<boolean> {
  const [rows] = await query<{ twofa_secret: string; twofa_secret_expiry: Date }>(
    `SELECT twofa_secret, twofa_secret_expiry FROM dnsmanager_users WHERE id = ?`,
    [userId]
  );

  if (rows.length === 0) return false;

  const user = rows[0];
  if (!user.twofa_secret || !user.twofa_secret_expiry) return false;

  // Check if expired
  if (new Date() > new Date(user.twofa_secret_expiry)) return false;

  // Verify code
  return user.twofa_secret === code;
}

/**
 * Clear 2FA code after successful verification
 */
export async function clear2FACode(userId: number): Promise<void> {
  await execute(
    `UPDATE dnsmanager_users SET twofa_secret = NULL, twofa_secret_expiry = NULL WHERE id = ?`,
    [userId]
  );
}

/**
 * Create a login session
 */
export async function createSession(
  userId: number,
  ipAddress: string,
  userAgent: string
): Promise<string> {
  const sessionToken = crypto.randomBytes(48).toString("hex");

  await execute(
    `INSERT INTO dnsmanager_logins (user_id, session_token, ip_address, user_agent, is_active)
     VALUES (?, ?, ?, ?, 1)`,
    [userId, sessionToken, ipAddress, userAgent]
  );

  // Update last login
  await execute(`UPDATE dnsmanager_users SET last_login = NOW() WHERE id = ?`, [userId]);

  return sessionToken;
}

/**
 * Get session by token
 */
export async function getSession(sessionToken: string): Promise<SessionData | null> {
  const [rows] = await query<{
    user_id: number;
    username: string;
    role: string;
    is_active: number;
    last_activity: Date;
  }>(
    `SELECT l.user_id, u.username, u.role, l.is_active, l.last_activity
     FROM dnsmanager_logins l
     JOIN dnsmanager_users u ON u.id = l.user_id
     WHERE l.session_token = ? AND l.is_active = 1`,
    [sessionToken]
  );

  if (rows.length === 0) return null;

  const session = rows[0];

  // Check if session is still active (within 24 hours of last activity)
  const lastActivity = new Date(session.last_activity);
  const now = new Date();
  const hoursSinceActivity = (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60);

  if (hoursSinceActivity > 24) {
    // Expire the session
    await execute(`UPDATE dnsmanager_logins SET is_active = 0, logout_at = NOW() WHERE session_token = ?`, [
      sessionToken,
    ]);
    return null;
  }

  // Update last activity
  await execute(`UPDATE dnsmanager_logins SET last_activity = NOW() WHERE session_token = ?`, [sessionToken]);

  return {
    userId: session.user_id,
    username: session.username,
    role: session.role,
    sessionToken,
  };
}

/**
 * Update current page for session
 */
export async function updateSessionPage(sessionToken: string, page: string): Promise<void> {
  await execute(`UPDATE dnsmanager_logins SET current_page = ?, last_activity = NOW() WHERE session_token = ?`, [
    page,
    sessionToken,
  ]);
}

/**
 * End a session (logout)
 */
export async function endSession(sessionToken: string): Promise<void> {
  await execute(
    `UPDATE dnsmanager_logins SET is_active = 0, logout_at = NOW() WHERE session_token = ?`,
    [sessionToken]
  );
}

/**
 * Get active sessions (for superadmin dashboard)
 */
export async function getActiveSessions() {
  const [rows] = await query(
    `SELECT l.id, l.user_id, u.username, u.email, u.role, l.ip_address,
            l.current_page, l.last_activity, l.login_at
     FROM dnsmanager_logins l
     JOIN dnsmanager_users u ON u.id = l.user_id
     WHERE l.is_active = 1
     ORDER BY l.last_activity DESC`
  );
  return rows;
}

/**
 * Log an action to audit trail
 */
export async function logAction(
  userId: number | null,
  actionType: string,
  description: string,
  ipAddress: string,
  userAgent: string,
  resourceType?: string,
  resourceId?: number,
  metadata?: any
): Promise<void> {
  await execute(
    `INSERT INTO dnsmanager_logs
     (user_id, action_type, resource_type, resource_id, description, metadata, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      actionType,
      resourceType || null,
      resourceId || null,
      description,
      metadata ? JSON.stringify(metadata) : null,
      ipAddress,
      userAgent,
    ]
  );
}

/**
 * Get logs (for superadmin dashboard)
 */
export async function getLogs(limit = 100, offset = 0, userId?: number, actionType?: string) {
  let sql = `
    SELECT l.id, l.user_id, u.username, l.action_type, l.resource_type, l.resource_id,
           l.description, l.metadata, l.ip_address, l.created_at
    FROM dnsmanager_logs l
    LEFT JOIN dnsmanager_users u ON u.id = l.user_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (userId) {
    sql += ` AND l.user_id = ?`;
    params.push(userId);
  }

  if (actionType) {
    sql += ` AND l.action_type = ?`;
    params.push(actionType);
  }

  sql += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const [rows] = await query(sql, params);
  return rows;
}

/**
 * Check if user has permission
 */
export async function hasPermission(
  userId: number,
  role: string,
  permissionType: string,
  action: "view" | "add" | "edit" | "delete",
  resourceId?: number
): Promise<boolean> {
  // Superadmin has all permissions
  if (role === "superadmin") return true;

  // Check specific permission
  const actionColumn = `can_${action}`;
  let sql = `
    SELECT ${actionColumn}
    FROM dnsmanager_user_permissions
    WHERE user_id = ? AND permission_type = ?
  `;
  const params: any[] = [userId, permissionType];

  if (resourceId) {
    sql += ` AND (resource_id = ? OR resource_id IS NULL)`;
    params.push(resourceId);
  } else {
    sql += ` AND resource_id IS NULL`;
  }

  sql += ` ORDER BY resource_id DESC LIMIT 1`; // Specific resource takes precedence

  const [rows] = await query<any>(sql, params);

  if (rows.length === 0) return false;

  return Boolean(rows[0][actionColumn]);
}

/**
 * Get user accounts (Cloudflare accounts they have access to)
 */
export async function getUserAccounts(userId: number, role: string) {
  // Superadmin sees all accounts
  if (role === "superadmin") {
    const [rows] = await query(`SELECT * FROM cloudflare_accounts ORDER BY name`);
    return rows;
  }

  // Regular users see only their assigned accounts
  const [rows] = await query(
    `SELECT ca.*
     FROM cloudflare_accounts ca
     JOIN dnsmanager_user_accounts ua ON ua.account_id = ca.id
     WHERE ua.user_id = ?
     ORDER BY ca.name`,
    [userId]
  );
  return rows;
}

/**
 * Check if user is account admin for a specific account
 */
export async function isAccountAdmin(userId: number, accountId: number): Promise<boolean> {
  const [rows] = await query<{ is_account_admin: number }>(
    `SELECT is_account_admin FROM dnsmanager_user_accounts
     WHERE user_id = ? AND account_id = ?`,
    [userId, accountId]
  );

  return rows.length > 0 && rows[0].is_account_admin === 1;
}
