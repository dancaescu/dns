import { Router } from "express";
import { authenticate } from "../middleware.js";
import { query, execute } from "../db.js";
import { logAction } from "../auth.js";

const router = Router();

router.use(authenticate);

router.get("/", async (req: any, res) => {
  const limit = Math.min(Number(req.query.limit) || 15, 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const resourceType = typeof req.query.resourceType === "string" ? req.query.resourceType : null;
  const actionType = typeof req.query.actionType === "string" ? req.query.actionType : null;
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : null;
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : null;
  const user = typeof req.query.user === "string" ? req.query.user : null;
  const action = typeof req.query.action === "string" ? req.query.action : null;
  const ipAddress = typeof req.query.ipAddress === "string" ? req.query.ipAddress : null;
  const description = typeof req.query.description === "string" ? req.query.description : null;
  const domain = typeof req.query.domain === "string" ? req.query.domain : null;

  let sql = `SELECT
    l.id, l.user_id, l.action_type, l.resource_type, l.resource_id,
    l.description, l.metadata, l.ip_address, l.user_agent, l.created_at,
    u.username
    FROM dnsmanager_logs l
    LEFT JOIN dnsmanager_users u ON l.user_id = u.id
    WHERE 1=1`;

  const params: unknown[] = [];

  if (resourceType) {
    sql += " AND l.resource_type = ?";
    params.push(resourceType);
  }

  if (actionType) {
    sql += " AND l.action_type = ?";
    params.push(actionType);
  }

  if (dateFrom) {
    sql += " AND l.created_at >= ?";
    params.push(dateFrom);
  }

  if (dateTo) {
    sql += " AND l.created_at <= ?";
    params.push(dateTo + " 23:59:59");
  }

  if (user) {
    sql += " AND u.username LIKE ?";
    params.push(`%${user}%`);
  }

  if (action) {
    sql += " AND l.action_type LIKE ?";
    params.push(`%${action}%`);
  }

  if (ipAddress) {
    sql += " AND l.ip_address LIKE ?";
    params.push(`%${ipAddress}%`);
  }

  if (description) {
    sql += " AND l.description LIKE ?";
    params.push(`%${description}%`);
  }

  if (domain) {
    sql += " AND l.description LIKE ?";
    params.push(`%${domain}%`);
  }

  // Get total count for pagination
  const countSql = sql.replace(
    /SELECT[\s\S]+FROM/,
    "SELECT COUNT(*) as total FROM"
  );
  const [countRows] = await query<{ total: number }>(countSql, params);
  const total = countRows[0]?.total || 0;

  sql += " ORDER BY l.created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const [rows] = await query(sql, params);

  // For each delete action, check if the record has been restored
  const logsWithRestoreStatus = await Promise.all(
    rows.map(async (log: any) => {
      if (log.action_type === 'rr_delete' && log.resource_type === 'dns_record' && log.resource_id) {
        try {
          const [records] = await query(
            'SELECT deleted_at FROM rr WHERE id = ?',
            [log.resource_id]
          );
          // If deleted_at is NULL, the record has been restored
          log.isRestored = records.length > 0 && records[0].deleted_at === null;
        } catch (error) {
          log.isRestored = false;
        }
      } else {
        log.isRestored = false;
      }
      return log;
    })
  );

  res.json({ logs: logsWithRestoreStatus, total });
});

router.post("/restore/:id", async (req: any, res) => {
  const logId = Number(req.params.id);

  // Get the log entry
  const [logs] = await query<{
    action_type: string;
    resource_type: string;
    resource_id: number;
  }>(
    "SELECT action_type, resource_type, resource_id FROM dnsmanager_logs WHERE id = ?",
    [logId]
  );

  if (logs.length === 0) {
    return res.status(404).json({ message: "Log entry not found" });
  }

  const log = logs[0];

  // Only allow restore for delete actions
  if (!log.action_type.endsWith("_delete")) {
    return res.status(400).json({ message: "Can only restore deleted records" });
  }

  // Determine which table to restore from
  let tableName: string;
  switch (log.resource_type) {
    case "soa":
      tableName = "soa";
      break;
    case "rr":
      tableName = "rr";
      break;
    case "cloudflare_zone":
      tableName = "cloudflare_zones";
      break;
    case "cloudflare_record":
      tableName = "cloudflare_records";
      break;
    case "cloudflare_account":
      tableName = "cloudflare_accounts";
      break;
    case "cloudflare_lb":
      tableName = "cloudflare_load_balancers";
      break;
    case "cloudflare_pool":
      tableName = "cloudflare_lb_pools";
      break;
    case "cloudflare_origin":
      tableName = "cloudflare_lb_pool_origins";
      break;
    default:
      return res.status(400).json({ message: "Unknown resource type" });
  }

  // Restore the record by setting deleted_at to NULL
  await execute(
    `UPDATE ${tableName} SET deleted_at = NULL WHERE id = ?`,
    [log.resource_id]
  );

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  // Log the restore action
  await logAction(
    req.user.id,
    `${log.resource_type}_restore`,
    `Restored ${log.resource_type} record ID ${log.resource_id}`,
    ipAddress,
    userAgent,
    log.resource_type,
    log.resource_id
  );

  res.json({ success: true });
});

export default router;
