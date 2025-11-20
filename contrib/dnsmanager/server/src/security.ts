import crypto from "crypto";

const PBKDF_PREFIX = "pbkdf2$";
const DEFAULT_ITERATIONS = 310000;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(password, salt, DEFAULT_ITERATIONS, KEY_LENGTH, "sha512").toString("hex");
  return `${PBKDF_PREFIX}${DEFAULT_ITERATIONS}$${salt}$${derived}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith(PBKDF_PREFIX)) {
    const [, iterationStr, salt, hash] = storedHash.split("$");
    const iterations = Number(iterationStr);
    if (!salt || !hash || !Number.isFinite(iterations)) {
      return false;
    }
    const derived = crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, "sha512").toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
  }

  if (storedHash.startsWith("$2")) {
    try {
      const bcrypt = await import("bcryptjs");
      return bcrypt.compare(password, storedHash);
    } catch {
      throw new Error("bcrypt hash detected but bcryptjs is not installed");
    }
  }

  return false;
}
