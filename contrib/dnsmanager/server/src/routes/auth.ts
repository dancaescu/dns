import { Router, Request } from "express";
import { z } from "zod";
import { query, execute } from "../db.js";
import {
  User,
  hashPassword,
  verifyPassword,
  createSession,
  endSession,
  getSession,
  generate2FACode,
  store2FACode,
  verify2FACode,
  clear2FACode,
  logAction,
} from "../auth.js";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const verify2FASchema = z.object({
  userId: z.number(),
  code: z.string().length(6),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

const update2FASchema = z.object({
  twofa_method: z.enum(["email", "sms", "none"]),
  twofa_contact: z.string().optional(),
});

/**
 * POST /api/auth/login
 * Login with username/password
 */
router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid credentials", issues: parsed.error.issues });
  }

  const { username, password } = parsed.data;
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Find user
    const [rows] = await query<User & { password_hash: string }>(
      `SELECT id, username, email, full_name, role, active, require_2fa, twofa_method, twofa_contact, password_hash
       FROM dnsadmin_users
       WHERE username = ? OR email = ?`,
      [username, username]
    );

    if (rows.length === 0) {
      await logAction(null, "login_failed", `Failed login attempt for ${username}`, ipAddress, userAgent);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = rows[0];

    // Check if user is active
    if (!user.active) {
      await logAction(user.id, "login_failed", `Login attempt for inactive user ${username}`, ipAddress, userAgent);
      return res.status(401).json({ message: "Account is inactive" });
    }

    // Verify password
    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword) {
      await logAction(user.id, "login_failed", `Failed login attempt (bad password)`, ipAddress, userAgent);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check if 2FA is required
    if (user.require_2fa || user.twofa_method !== "none") {
      // Generate and send 2FA code
      const code = generate2FACode();
      await store2FACode(user.id, code);

      // TODO: Send code via email or SMS using Multitel API
      // For now, just return that 2FA is required
      console.log(`2FA code for ${username}: ${code}`); // Debug only

      await logAction(user.id, "login", `2FA code generated for ${username}`, ipAddress, userAgent);

      return res.json({
        requires2FA: true,
        userId: user.id,
        twofa_method: user.twofa_method,
        message: `2FA code sent to your ${user.twofa_method}`,
      });
    }

    // No 2FA required, create session
    const sessionToken = await createSession(user.id, ipAddress, userAgent);

    await logAction(user.id, "login", `Successful login for ${username}`, ipAddress, userAgent);

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
      },
      sessionToken,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/auth/verify-2fa
 * Verify 2FA code
 */
router.post("/verify-2fa", async (req, res) => {
  const parsed = verify2FASchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const { userId, code } = parsed.data;
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Verify code
    const valid = await verify2FACode(userId, code);
    if (!valid) {
      await logAction(userId, "login_failed", `Invalid 2FA code`, ipAddress, userAgent);
      return res.status(401).json({ message: "Invalid or expired code" });
    }

    // Clear code
    await clear2FACode(userId);

    // Get user
    const [rows] = await query<User>(
      `SELECT id, username, email, full_name, role, active, require_2fa, twofa_method, twofa_contact
       FROM dnsadmin_users
       WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    // Create session
    const sessionToken = await createSession(user.id, ipAddress, userAgent);

    await logAction(user.id, "login", `Successful login with 2FA for ${user.username}`, ipAddress, userAgent);

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
      },
      sessionToken,
    });
  } catch (error) {
    console.error("2FA verification error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/auth/logout
 * Logout and end session
 */
router.post("/logout", async (req, res) => {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    return res.status(401).json({ message: "No session token" });
  }

  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    const session = await getSession(sessionToken);
    if (session) {
      await endSession(sessionToken);
      await logAction(session.userId, "logout", `User ${session.username} logged out`, ipAddress, userAgent);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get("/me", async (req, res) => {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const session = await getSession(sessionToken);
    if (!session) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    // Get full user info
    const [rows] = await query<User>(
      `SELECT id, username, email, full_name, role, active, require_2fa, twofa_method, twofa_contact
       FROM dnsadmin_users
       WHERE id = ?`,
      [session.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        require_2fa: user.require_2fa,
        twofa_method: user.twofa_method,
        twofa_contact: user.twofa_contact,
      },
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/auth/change-password
 * Change user password
 */
router.post("/change-password", async (req, res) => {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const { currentPassword, newPassword } = parsed.data;
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    const session = await getSession(sessionToken);
    if (!session) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    // Get current password hash
    const [rows] = await query<{ password_hash: string }>(
      `SELECT password_hash FROM dnsadmin_users WHERE id = ?`,
      [session.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // Verify current password
    const validPassword = await verifyPassword(currentPassword, rows[0].password_hash);
    if (!validPassword) {
      await logAction(session.userId, "other", `Failed password change attempt (bad current password)`, ipAddress, userAgent);
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    // Hash new password
    const newHash = await hashPassword(newPassword);

    // Update password
    await execute(`UPDATE dnsadmin_users SET password_hash = ? WHERE id = ?`, [newHash, session.userId]);

    await logAction(session.userId, "user_update", `Password changed`, ipAddress, userAgent, "user", session.userId);

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/auth/update-2fa
 * Update 2FA settings
 */
router.post("/update-2fa", async (req, res) => {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const parsed = update2FASchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const { twofa_method, twofa_contact } = parsed.data;
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    const session = await getSession(sessionToken);
    if (!session) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    // Validate contact if method is not none
    if (twofa_method !== "none" && !twofa_contact) {
      return res.status(400).json({ message: "Contact information required for 2FA" });
    }

    // Update 2FA settings
    await execute(
      `UPDATE dnsadmin_users SET twofa_method = ?, twofa_contact = ?, require_2fa = ? WHERE id = ?`,
      [twofa_method, twofa_contact || null, twofa_method !== "none" ? 1 : 0, session.userId]
    );

    await logAction(
      session.userId,
      "user_update",
      `2FA settings updated to ${twofa_method}`,
      ipAddress,
      userAgent,
      "user",
      session.userId
    );

    res.json({ success: true, message: "2FA settings updated" });
  } catch (error) {
    console.error("Update 2FA error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
