import { query } from "./db.js";

interface PermissionCheck {
  userId: number;
  role: string;
  permissionType: "zone" | "soa" | "rr" | "cloudflare";
  zoneType?: "soa" | "cloudflare";
  resourceId?: number;
  action: "view" | "add" | "edit" | "delete";
}

/**
 * Check if a user has permission to perform an action on a resource
 */
export async function checkPermission(check: PermissionCheck): Promise<boolean> {
  // Superadmins have all permissions
  if (check.role === "superadmin") {
    return true;
  }

  // Build permission query
  let sql = `
    SELECT can_view, can_add, can_edit, can_delete
    FROM dnsmanager_user_permissions
    WHERE user_id = ?
      AND permission_type = ?
  `;
  const params: any[] = [check.userId, check.permissionType];

  // Add zone type filter if applicable
  if (check.zoneType) {
    sql += " AND zone_type = ?";
    params.push(check.zoneType);
  }

  // Add resource ID filter if specific resource
  if (check.resourceId !== undefined) {
    sql += " AND (resource_id = ? OR resource_id IS NULL)";
    params.push(check.resourceId);
  }

  // Execute query
  const [permissions] = await query<{
    can_view: number;
    can_add: number;
    can_edit: number;
    can_delete: number;
  }>(sql, params);

  // If no permissions found, deny access
  if (permissions.length === 0) {
    return false;
  }

  // Check the specific action permission
  // If multiple permissions exist, grant access if ANY permission allows the action
  for (const perm of permissions) {
    let hasPermission = false;

    switch (check.action) {
      case "view":
        hasPermission = Boolean(perm.can_view);
        break;
      case "add":
        hasPermission = Boolean(perm.can_add);
        break;
      case "edit":
        hasPermission = Boolean(perm.can_edit);
        break;
      case "delete":
        hasPermission = Boolean(perm.can_delete);
        break;
    }

    if (hasPermission) {
      return true;
    }
  }

  return false;
}

/**
 * Express middleware to check permissions
 */
export function requirePermission(
  permissionType: "zone" | "soa" | "rr" | "cloudflare",
  action: "view" | "add" | "edit" | "delete",
  options?: {
    zoneType?: "soa" | "cloudflare";
    resourceIdParam?: string; // e.g., "id" or "zoneId"
  }
) {
  return async (req: any, res: any, next: any) => {
    const resourceId = options?.resourceIdParam ? Number(req.params[options.resourceIdParam]) : undefined;

    const hasPermission = await checkPermission({
      userId: req.tokenAuth.userId,
      role: req.tokenAuth.role,
      permissionType,
      zoneType: options?.zoneType,
      resourceId,
      action,
    });

    if (!hasPermission) {
      return res.status(403).json({
        error: `Insufficient permissions. You do not have permission to ${action} this resource.`,
      });
    }

    next();
  };
}

/**
 * Helper to check SOA zone permission by getting zone ID from resource
 */
export function requireSoaPermissionForRr(
  action: "view" | "add" | "edit" | "delete"
) {
  return async (req: any, res: any, next: any) => {
    // For RR operations, we need to check the SOA zone permission
    let zoneId: number | undefined;

    // For POST (create), zone ID is in the body
    if (req.method === "POST" && req.body.zone) {
      zoneId = Number(req.body.zone);
    }
    // For PUT/DELETE, get zone from existing RR record
    else if (req.params.id) {
      const [rr] = await query<{ zone: number }>(
        "SELECT zone FROM rr WHERE id = ?",
        [req.params.id]
      );
      if (rr.length > 0) {
        zoneId = rr[0].zone;
      }
    }

    const hasPermission = await checkPermission({
      userId: req.tokenAuth.userId,
      role: req.tokenAuth.role,
      permissionType: "soa",
      zoneType: "soa",
      resourceId: zoneId,
      action,
    });

    if (!hasPermission) {
      return res.status(403).json({
        error: `Insufficient permissions. You do not have permission to ${action} records in this zone.`,
      });
    }

    next();
  };
}
