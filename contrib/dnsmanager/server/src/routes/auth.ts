import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { query } from "../db.js";
import { jwtSecret } from "../config.js";
import { verifyPassword } from "../security.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const router = Router();

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
  }
  const { username, password } = parsed.data;
  const [rows] = await query<{ id: number; username: string; password_hash: string; role: string }>(
    "SELECT id, username, password_hash, role FROM dnsmanager_users WHERE username = ?",
    [username],
  );
  if (!rows.length) {
    return res.status(401).json({ message: "Invalid credentials" });
  }
  const user = rows[0];
  try {
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "Password verification failed" });
  }
  if (!user.role) {
    return res.status(401).json({ message: "Invalid credentials" });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    jwtSecret,
    { expiresIn: "8h" },
  );
  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  });
});

export default router;
