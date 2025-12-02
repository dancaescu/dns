/**
 * DNSSEC Key Generation Module
 * Generates DNSSEC keys using Node.js crypto or external dnssec-keygen tool
 */

import { exec } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

const execAsync = promisify(exec);

interface DNSSECKey {
  algorithm: number;
  key_tag: number;
  public_key: string;
  private_key: string;
  is_ksk: boolean;
}

const ALGORITHM_NAMES: Record<number, string> = {
  8: "RSASHA256",
  10: "RSASHA512",
  13: "ECDSAP256SHA256",
  14: "ECDSAP384SHA384",
  15: "ED25519",
  16: "ED448",
};

const KEYGEN_ALGORITHMS: Record<number, string> = {
  8: "RSASHA256",
  10: "RSASHA512",
  13: "ECDSAP256SHA256",
  14: "ECDSAP384SHA384",
  15: "ED25519",
  16: "ED448",
};

/**
 * Calculate RFC 4034 key tag from DNSKEY RDATA
 */
function calculateKeyTag(rdata: Buffer): number {
  let ac = 0;
  for (let i = 0; i < rdata.length; i++) {
    ac += (i & 1) ? rdata[i] : (rdata[i] << 8);
  }
  ac += (ac >> 16) & 0xFFFF;
  return ac & 0xFFFF;
}

/**
 * Parse DNSKEY record to extract key tag
 */
function parseKeyTag(dnskeyFile: string): number | null {
  // Extract key tag from filename like Kexample.com.+013+12345.key
  const match = dnskeyFile.match(/\+(\d{5})\.key$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Generate DNSSEC key pair using dnssec-keygen tool
 */
export async function generateKeyWithDnssecKeygen(
  zoneName: string,
  algorithm: number,
  keySize: number | null,
  isKSK: boolean,
  keysDir: string = "/etc/mydns/keys"
): Promise<DNSSECKey> {
  // Ensure keys directory exists
  await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });

  const algoName = KEYGEN_ALGORITHMS[algorithm];
  if (!algoName) {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  // Build dnssec-keygen command
  const args = [
    "dnssec-keygen",
    "-a", algoName,
    "-n", "ZONE",
  ];

  // Add key size for RSA algorithms
  if ((algorithm === 8 || algorithm === 10) && keySize) {
    args.push("-b", keySize.toString());
  }

  // Add KSK flag if needed
  if (isKSK) {
    args.push("-f", "KSK");
  }

  // Ensure zone name ends with dot
  const normalizedZone = zoneName.endsWith('.') ? zoneName : `${zoneName}.`;
  args.push(normalizedZone);

  console.log(`[dnssec-keygen] Executing: ${args.join(' ')}`);
  console.log(`[dnssec-keygen] Working directory: ${keysDir}`);

  try {
    const { stdout, stderr } = await execAsync(args.join(' '), {
      cwd: keysDir,
      timeout: 30000,
    });

    console.log(`[dnssec-keygen] stdout: ${stdout.trim()}`);
    if (stderr) {
      console.warn(`[dnssec-keygen] stderr: ${stderr.trim()}`);
    }

    // Extract key filename from output (e.g., "Kexample.com.+013+12345")
    const keyBaseName = stdout.trim();
    if (!keyBaseName) {
      throw new Error("dnssec-keygen did not return key filename");
    }

    // Read public key (.key file)
    const publicKeyPath = path.join(keysDir, `${keyBaseName}.key`);
    const publicKeyContent = await fs.readFile(publicKeyPath, 'utf-8');

    // Read private key (.private file)
    const privateKeyPath = path.join(keysDir, `${keyBaseName}.private`);
    const privateKeyContent = await fs.readFile(privateKeyPath, 'utf-8');

    // Extract key tag from filename
    const keyTag = parseKeyTag(`${keyBaseName}.key`);
    if (!keyTag) {
      throw new Error("Could not extract key tag from filename");
    }

    console.log(`[dnssec-keygen] Generated key ${keyTag} for ${zoneName}`);

    return {
      algorithm,
      key_tag: keyTag,
      public_key: publicKeyContent.trim(),
      private_key: privateKeyContent.trim(),
      is_ksk: isKSK,
    };
  } catch (error: any) {
    console.error(`[dnssec-keygen] Failed to generate key:`, error);
    throw new Error(`Key generation failed: ${error.message}`);
  }
}

/**
 * Check if dnssec-keygen is available
 */
export async function isDnssecKeygenAvailable(): Promise<boolean> {
  try {
    await execAsync("which dnssec-keygen", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate key and import into database
 */
export async function generateAndImportKey(
  db: any,
  zoneId: number,
  zoneName: string,
  algorithm: number,
  keySize: number | null,
  isKSK: boolean,
  keysDir: string = "/etc/mydns/keys"
): Promise<{ keyId: number; keyTag: number }> {
  // Check if dnssec-keygen is available
  const hasKeygen = await isDnssecKeygenAvailable();
  if (!hasKeygen) {
    throw new Error("dnssec-keygen command not found. Install bind-tools or bind9-utils package.");
  }

  // Generate key
  const key = await generateKeyWithDnssecKeygen(zoneName, algorithm, keySize, isKSK, keysDir);

  // Import into database
  const result = await db.execute(
    `INSERT INTO dnssec_keys
     (zone_id, algorithm, key_tag, is_ksk, public_key, private_key, active, created_at, activated_at)
     VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())`,
    [zoneId, key.algorithm, key.key_tag, key.is_ksk, key.public_key, key.private_key]
  );

  // Log the operation
  await db.execute(
    `INSERT INTO dnssec_log (zone_id, operation, message, success, timestamp)
     VALUES (?, ?, ?, TRUE, NOW())`,
    [
      zoneId,
      "key_generate",
      `Generated ${key.is_ksk ? 'KSK' : 'ZSK'} key ${key.key_tag} using algorithm ${algorithm} (${ALGORITHM_NAMES[algorithm]})`
    ]
  );

  console.log(`[dnssec-keygen] Imported key ${key.key_tag} into database (ID: ${result.insertId})`);

  return {
    keyId: result.insertId,
    keyTag: key.key_tag,
  };
}
