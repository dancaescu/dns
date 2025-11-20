import mysql from "mysql2/promise";
import { dbConfig } from "./config.js";

let pool: mysql.Pool | null = null;
let activeHost: string | null = null;

function orderedHosts() {
  const hosts = [...dbConfig.hosts];
  const policy = dbConfig.policy;
  if (["round-robin", "roundrobin", "rr"].includes(policy) && hosts.length > 1) {
    const start = Math.floor(Math.random() * hosts.length);
    return hosts.slice(start).concat(hosts.slice(0, start));
  }
  if (["least-used", "least_used", "least"].includes(policy) && hosts.length > 1) {
    return hosts.sort(() => Math.random() - 0.5);
  }
  return hosts;
}

async function initPool(): Promise<mysql.Pool> {
  const attempts = orderedHosts();
  let lastError: unknown = null;
  for (const host of attempts) {
    try {
      const candidate = mysql.createPool({
        host: host.host,
        port: host.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        waitForConnections: true,
        connectionLimit: 10,
        charset: "utf8mb4",
      });
      await candidate.query("SELECT 1");
      pool = candidate;
      activeHost = `${host.host}:${host.port}`;
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Unable to connect to any database host");
}

export async function getPool(): Promise<mysql.Pool> {
  if (pool) return pool;
  return initPool();
}

export function getActiveHost(): string | null {
  return activeHost;
}

export async function query<T = mysql.RowDataPacket>(
  sql: string,
  params?: unknown[],
): Promise<[T[], mysql.FieldPacket[]]> {
  const p = await getPool();
  const [rows, fields] = await p.query<mysql.RowDataPacket[]>(sql, params);
  return [rows as unknown as T[], fields];
}

export async function execute<T = any>(sql: string, params?: unknown[]): Promise<mysql.ResultSetHeader> {
  const p = await getPool();
  const [result] = await p.execute<mysql.ResultSetHeader>(sql, params);
  return result;
}

export async function withTransaction<T>(handler: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const p = await getPool();
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
