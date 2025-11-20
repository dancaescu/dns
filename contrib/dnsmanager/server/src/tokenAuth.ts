import crypto from "crypto";
import bcrypt from "bcrypt";
import { query, execute } from "./db.js";

const SALT_ROUNDS = 10;

/**
 * Generate a new API token
 * Format: dnsm_<random_32_chars>
 */
export function generateToken(): { token: string; prefix: string } {
  const randomBytes = crypto.randomBytes(24).toString("hex");
  const token = `dnsm_${randomBytes}`;
  const prefix = token.substring(0, 15); // "dnsm_" + first 10 chars
  return { token, prefix };
}

/**
 * Hash a token for storage
 */
export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, SALT_ROUNDS);
}

/**
 * Verify a token against a hash
 */
export async function verifyToken(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}

/**
 * Authenticate request with API token
 */
export async function authenticateToken(token: string): Promise<{
  tokenId: number;
  userId: number;
  username: string;
  role: string;
  scopes: string[];
} | null> {
  if (!token || !token.startsWith("dnsm_")) {
    return null;
  }

  const prefix = token.substring(0, 15);

  // Find tokens with matching prefix
  const [tokens] = await query<{
    id: number;
    user_id: number;
    token_hash: string;
    scopes: string;
    active: number;
    expires_at: Date | null;
    username: string;
    role: string;
  }>(
    `SELECT t.id, t.user_id, t.token_hash, t.scopes, t.active, t.expires_at,
            u.username, u.role
     FROM dnsmanager_tokens t
     JOIN dnsmanager_users u ON u.id = t.user_id
     WHERE t.token_prefix = ? AND t.active = 1`,
    [prefix]
  );

  // Check each token (should usually be just one)
  for (const tokenRow of tokens) {
    // Check expiry
    if (tokenRow.expires_at && new Date() > new Date(tokenRow.expires_at)) {
      continue;
    }

    // Verify token hash
    const valid = await verifyToken(token, tokenRow.token_hash);
    if (valid) {
      // Update last used
      await execute(
        `UPDATE dnsmanager_tokens SET last_used = NOW(), last_used_ip = ? WHERE id = ?`,
        ["api", tokenRow.id]
      );

      return {
        tokenId: tokenRow.id,
        userId: tokenRow.user_id,
        username: tokenRow.username,
        role: tokenRow.role,
        scopes: JSON.parse(tokenRow.scopes),
      };
    }
  }

  return null;
}

/**
 * Check if token has required scope
 */
export function hasScope(tokenScopes: string[], requiredScope: string): boolean {
  // Check for exact match or wildcard
  return tokenScopes.includes(requiredScope) || tokenScopes.includes("*");
}

/**
 * Log token usage
 */
export async function logTokenUsage(
  tokenId: number,
  endpoint: string,
  method: string,
  ipAddress: string,
  userAgent: string,
  responseStatus: number
): Promise<void> {
  await execute(
    `INSERT INTO dnsmanager_token_usage (token_id, endpoint, method, ip_address, user_agent, response_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tokenId, endpoint, method, ipAddress, userAgent, responseStatus]
  );
}
