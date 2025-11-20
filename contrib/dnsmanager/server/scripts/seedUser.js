#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MYDNS_CONFIG_PATH = process.env.MYDNS_CONFIG || "/etc/mydns/mydns.conf";

function parseConfigFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const data = fs.readFileSync(resolved, "utf-8");
  const entries = {};
  for (const rawLine of data.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const line = trimmed.split("#", 1)[0];
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"+|"+$/g, "");
    entries[key] = value;
  }
  return entries;
}

function parseHost(entry) {
  if (!entry) return null;
  let host = entry.trim();
  if (!host) return null;
  let port = 3306;
  if (host.startsWith("[") && host.includes("]")) {
    const end = host.indexOf("]");
    const literal = host.slice(1, end);
    if (host.length > end + 2 && host[end + 1] === ":") {
      const maybe = Number(host.slice(end + 2));
      if (Number.isInteger(maybe)) port = maybe;
    }
    return { host: literal, port };
  }
  const colonCount = (host.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [name, portPart] = host.split(":");
    host = name || host;
    if (portPart) {
      const maybe = Number(portPart);
      if (Number.isInteger(maybe)) port = maybe;
    }
    return { host, port };
  }
  return { host, port };
}

function gatherHosts(config) {
  const hosts = [];
  for (const key of ["db-host", "db-host2", "db-host3", "db-host4"]) {
    const parsed = parseHost(config[key]);
    if (parsed) hosts.push(parsed);
  }
  if (!hosts.length) {
    const fallback = parseHost(config["mysql-host"] || config["db-host"]);
    if (fallback) hosts.push(fallback);
  }
  if (!hosts.length) {
    hosts.push({ host: "localhost", port: 3306 });
  }
  return hosts;
}

let mysqlModule = null;

async function loadMysql() {
  if (mysqlModule) return mysqlModule;
  try {
    mysqlModule = await import("mysql2/promise");
    return mysqlModule;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "mysql2 package not found. Please run `npm install --prefix contrib/dnsmanager/server` before seeding users.",
      );
    }
    throw error;
  }
}

async function connectToDatabase(config) {
  const mysql = await loadMysql();
  const hosts = gatherHosts(config);
  let lastError = null;
  for (const target of hosts) {
    try {
      const conn = await mysql.createConnection({
        host: target.host,
        port: target.port,
        user: config["db-user"] || config["mysql-user"],
        password: config["db-password"] || config["mysql-password"] || config["mysql-pass"] || "",
        database: config["database"],
        charset: "utf8mb4",
      });
      return conn;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Unable to connect to any DB host");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 310000;
  const derived = crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

async function main() {
  const config = parseConfigFile(MYDNS_CONFIG_PATH);
  if (!config["db-user"] && !config["mysql-user"]) {
    throw new Error("db-user missing in config");
  }
  if (!config["database"]) {
    throw new Error("database missing in config");
  }
  const rl = createInterface({ input, output });
  try {
    const username = (await rl.question("Username: ")).trim();
    if (!username) throw new Error("Username is required");
    const password = (await rl.question("Password: ")).trim();
    if (!password) throw new Error("Password is required");
    const role = (await rl.question("Role [admin]: ")).trim() || "admin";
    const hash = hashPassword(password);
    const conn = await connectToDatabase(config);
    await conn.execute(
      `CREATE TABLE IF NOT EXISTS dnsmanager_users (
        id int NOT NULL AUTO_INCREMENT,
        username varchar(64) NOT NULL,
        password_hash varchar(255) NOT NULL,
        role varchar(32) NOT NULL DEFAULT 'admin',
        created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_dnsmanager_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    );
    await conn.execute(
      `INSERT INTO dnsmanager_users (username, password_hash, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role)`,
      [username, hash, role],
    );
    console.log(`User ${username} saved/updated.`);
    await conn.end();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
