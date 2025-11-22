import { Router, Request, Response } from 'express';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { execute, query } from '../db.js';
import { getSession } from '../auth.js';

const router = Router();

// Middleware to check authentication
async function requireAuth(req: any, res: any, next: any) {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const session = await getSession(sessionToken);
  if (!session) {
    return res.status(401).json({ message: "Invalid or expired session" });
  }

  req.user = session;
  next();
}

// ===== ADMIN: Zone Assignment Management =====

// GET /api/permissions/zones - List all zones with their assignments
router.get('/zones', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Only superadmin and account_admin can view zones
    if (!['superadmin', 'account_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get SOA zones
    const [soaZones] = await query<RowDataPacket[]>(`
      SELECT
        s.id,
        s.origin,
        'soa' AS zone_type
      FROM soa s
      WHERE s.deleted_at IS NULL
      ORDER BY s.origin
    `);

    // Get Cloudflare zones
    const [cfZones] = await query<RowDataPacket[]>(`
      SELECT
        cz.id,
        cz.name AS origin,
        'cloudflare' AS zone_type
      FROM cloudflare_zones cz
      WHERE cz.deleted_at IS NULL
      ORDER BY cz.name
    `);

    // Combine zones into single array
    const allZones = [
      ...(Array.isArray(soaZones) ? soaZones : []).map(z => ({
        id: z.id,
        origin: z.origin,
        zone_type: 'soa' as const
      })),
      ...(Array.isArray(cfZones) ? cfZones : []).map(z => ({
        id: z.id,
        origin: z.origin,
        zone_type: 'cloudflare' as const
      }))
    ];

    console.log(`[GET /permissions/zones] Returning ${allZones.length} zones:`,
      allZones.slice(0, 3).map(z => ({ id: z.id, origin: z.origin, zone_type: z.zone_type })));

    res.json({ zones: allZones });
  } catch (error) {
    console.error('Error fetching zones:', error);
    res.status(500).json({ error: 'Failed to fetch zones' });
  }
});

// POST /api/permissions/zones/assign - Assign zone to account
router.post('/zones/assign', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { zone_type, zone_id, account_id, can_view, can_add, can_edit, can_delete } = req.body;

    // Only admin can assign zones
    if (user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!['soa', 'cloudflare'].includes(zone_type)) {
      return res.status(400).json({ error: 'Invalid zone_type' });
    }

    // Insert or update assignment
    await execute(`
      INSERT INTO dnsmanager_zone_assignments
        (zone_type, zone_id, account_id, assigned_by, can_view, can_add, can_edit, can_delete)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        can_view = VALUES(can_view),
        can_add = VALUES(can_add),
        can_edit = VALUES(can_edit),
        can_delete = VALUES(can_delete),
        updated_at = CURRENT_TIMESTAMP
    `, [zone_type, zone_id, account_id, user.id, can_view ?? 1, can_add ?? 0, can_edit ?? 0, can_delete ?? 0]);

    res.json({ success: true, message: 'Zone assigned successfully' });
  } catch (error) {
    console.error('Error assigning zone:', error);
    res.status(500).json({ error: 'Failed to assign zone' });
  }
});

// DELETE /api/permissions/zones/assign - Remove zone assignment
router.delete('/zones/assign', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { zone_type, zone_id, account_id } = req.body;

    // Only admin can remove assignments
    if (user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await execute(`
      DELETE FROM dnsmanager_zone_assignments
      WHERE zone_type = ? AND zone_id = ? AND account_id = ?
    `, [zone_type, zone_id, account_id]);

    res.json({ success: true, message: 'Zone assignment removed' });
  } catch (error) {
    console.error('Error removing zone assignment:', error);
    res.status(500).json({ error: 'Failed to remove assignment' });
  }
});

// ===== ACCOUNT ADMIN: User Permission Management =====

// GET /api/permissions/users/:accountId - Get users and their permissions for an account
router.get('/users/:accountId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { accountId } = req.params;

    // Check if user is admin or account admin of this account
    const isAdmin = user.role === 'superadmin';
    const isAccountAdmin = await query<RowDataPacket[]>(`
      SELECT 1 FROM dnsmanager_user_accounts
      WHERE account_id = ? AND user_id = ? AND is_account_admin = 1
    `, [accountId, user.id]);

    if (!isAdmin && isAccountAdmin.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all users in this account with their permissions
    const users = await query<RowDataPacket[]>(`
      SELECT
        u.id,
        u.username,
        u.email,
        ua.is_account_admin,
        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', p.id,
              'permission_type', p.permission_type,
              'zone_type', p.zone_type,
              'resource_id', p.resource_id,
              'can_view', p.can_view,
              'can_add', p.can_add,
              'can_edit', p.can_edit,
              'can_delete', p.can_delete
            )
          )
          FROM dnsmanager_user_permissions p
          WHERE p.user_id = u.id
        ) AS permissions
      FROM dnsmanager_users u
      JOIN dnsmanager_user_accounts ua ON ua.user_id = u.id
      WHERE ua.account_id = ?
    `, [accountId]);

    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/permissions/users/by-user/:userId - Get permissions for a specific user
router.get('/users/by-user/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { userId } = req.params;

    // Superadmin and account_admin can view user permissions
    if (!['superadmin', 'account_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get user permissions including zones and Cloudflare accounts
    const permissions = await query<RowDataPacket[]>(`
      SELECT
        p.id,
        p.permission_type,
        p.zone_type,
        p.resource_id,
        CASE
          WHEN p.permission_type = 'cloudflare_account' THEN ca.name
          WHEN p.resource_id IS NULL AND p.zone_type = 'soa' THEN 'New SOA Zone'
          WHEN p.resource_id IS NULL AND p.zone_type = 'cloudflare' THEN 'New Cloudflare Zone'
          WHEN p.zone_type = 'soa' THEN s.origin
          WHEN p.zone_type = 'cloudflare' THEN cz.name
          ELSE 'Unknown'
        END AS zone_name,
        p.resource_id AS zone_id,
        p.can_view,
        p.can_add,
        p.can_edit,
        p.can_delete,
        p.can_api_access
      FROM dnsmanager_user_permissions p
      LEFT JOIN soa s ON p.zone_type = 'soa' AND p.resource_id = s.id AND p.resource_id IS NOT NULL AND p.permission_type = 'zone'
      LEFT JOIN cloudflare_zones cz ON p.zone_type = 'cloudflare' AND p.resource_id = cz.id AND p.resource_id IS NOT NULL AND p.permission_type = 'zone'
      LEFT JOIN cloudflare_accounts ca ON p.permission_type = 'cloudflare_account' AND p.resource_id = ca.id
      WHERE p.user_id = ?
    `, [userId]);

    res.json({ permissions });
  } catch (error) {
    console.error('Error fetching user permissions:', error);
    res.status(500).json({ error: 'Failed to fetch user permissions' });
  }
});

// POST /api/permissions/users/grant - Grant permission to a user
router.post('/users/grant', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const {
      user_id,
      zone_type,
      zone_id,
      can_view,
      can_add,
      can_edit,
      can_delete,
      can_api_access
    } = req.body;

    // Use zone_id as resource_id and 'zone' as permission_type
    const permission_type = 'zone';
    const resource_id = zone_id;

    // Check if current user is superadmin
    const isAdmin = user.role === 'superadmin';

    // For non-superadmin, verify they are account_admin
    if (!isAdmin) {
      // Verify target user exists
      const [targetUser] = await query<RowDataPacket[]>(`
        SELECT id FROM dnsmanager_users WHERE id = ?
      `, [user_id]);

      if (!Array.isArray(targetUser) || targetUser.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if current user is account_admin
      if (user.role !== 'account_admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Prepare parameters with proper null handling
    const params = [
      user_id,
      permission_type,
      zone_type ?? null,
      resource_id ?? null,
      can_view ?? true,
      can_add ?? false,
      can_edit ?? false,
      can_delete ?? false,
      can_api_access ?? false,
      user.id
    ];

    console.log('[Grant Permission] Parameters:', {
      user_id,
      permission_type,
      zone_type,
      resource_id,
      can_view,
      can_add,
      can_edit,
      can_delete,
      can_api_access,
      created_by: user.id,
      params
    });

    // For "create new zone" permissions (zone_id = null), check if it already exists
    if (resource_id === null) {
      const [existing] = await query<RowDataPacket[]>(`
        SELECT id FROM dnsmanager_user_permissions
        WHERE user_id = ? AND permission_type = ? AND zone_type = ? AND resource_id IS NULL
      `, [user_id, permission_type, zone_type]);

      if (Array.isArray(existing) && existing.length > 0) {
        // Update existing permission
        await execute(`
          UPDATE dnsmanager_user_permissions
          SET can_view = ?, can_add = ?, can_edit = ?, can_delete = ?, can_api_access = ?
          WHERE user_id = ? AND permission_type = ? AND zone_type = ? AND resource_id IS NULL
        `, [can_view ?? true, can_add ?? false, can_edit ?? false, can_delete ?? false, can_api_access ?? false, user_id, permission_type, zone_type]);
      } else {
        // Insert new permission
        await execute(`
          INSERT INTO dnsmanager_user_permissions
            (user_id, permission_type, zone_type, resource_id, can_view, can_add, can_edit, can_delete, can_api_access, created_by)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `, [user_id, permission_type, zone_type, can_view ?? true, can_add ?? false, can_edit ?? false, can_delete ?? false, can_api_access ?? false, user.id]);
      }
    } else {
      // Insert or update permission for specific zone
      await execute(`
        INSERT INTO dnsmanager_user_permissions
          (user_id, permission_type, zone_type, resource_id, can_view, can_add, can_edit, can_delete, can_api_access, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          can_view = VALUES(can_view),
          can_add = VALUES(can_add),
          can_edit = VALUES(can_edit),
          can_delete = VALUES(can_delete),
          can_api_access = VALUES(can_api_access)
      `, params);
    }

    res.json({ success: true, message: 'Permission granted' });
  } catch (error) {
    console.error('Error granting permission:', error);
    res.status(500).json({ error: 'Failed to grant permission' });
  }
});

// DELETE /api/permissions/users/:permissionId - Revoke a permission
router.delete('/users/:permissionId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { permissionId } = req.params;

    // Only superadmin and account_admin can delete permissions
    if (!['superadmin', 'account_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get permission details
    const [perm] = await query<RowDataPacket[]>(`
      SELECT p.user_id
      FROM dnsmanager_user_permissions p
      WHERE p.id = ?
    `, [permissionId]);

    if (!Array.isArray(perm) || perm.length === 0) {
      return res.status(404).json({ error: 'Permission not found' });
    }

    await execute(`DELETE FROM dnsmanager_user_permissions WHERE id = ?`, [permissionId]);

    res.json({ success: true, message: 'Permission revoked' });
  } catch (error) {
    console.error('Error revoking permission:', error);
    res.status(500).json({ error: 'Failed to revoke permission' });
  }
});

// ===== CLOUDFLARE ACCOUNT MANAGEMENT =====

// GET /api/permissions/cloudflare-accounts - List all Cloudflare accounts
router.get('/cloudflare-accounts', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Only superadmin and account_admin can view accounts
    if (!['superadmin', 'account_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get all Cloudflare accounts
    const [accounts] = await query<RowDataPacket[]>(`
      SELECT id, name, cf_account_id
      FROM cloudflare_accounts
      WHERE deleted_at IS NULL
      ORDER BY name
    `);

    res.json({ accounts: Array.isArray(accounts) ? accounts : [] });
  } catch (error) {
    console.error('Error fetching Cloudflare accounts:', error);
    res.status(500).json({ error: 'Failed to fetch Cloudflare accounts' });
  }
});

// POST /api/permissions/cloudflare-accounts/grant - Grant Cloudflare account permission
router.post('/cloudflare-accounts/grant', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const {
      user_id,
      account_id,
      can_view,
      can_add,
      can_edit,
      can_delete,
      can_api_access
    } = req.body;

    // Only superadmin and account_admin can grant account permissions
    if (!['superadmin', 'account_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const permission_type = 'cloudflare_account';

    // Check if permission already exists
    const [existing] = await query<RowDataPacket[]>(`
      SELECT id FROM dnsmanager_user_permissions
      WHERE user_id = ? AND permission_type = ? AND resource_id = ?
    `, [user_id, permission_type, account_id]);

    if (Array.isArray(existing) && existing.length > 0) {
      // Update existing permission
      await execute(`
        UPDATE dnsmanager_user_permissions
        SET can_view = ?, can_add = ?, can_edit = ?, can_delete = ?, can_api_access = ?
        WHERE user_id = ? AND permission_type = ? AND resource_id = ?
      `, [can_view ?? true, can_add ?? false, can_edit ?? false, can_delete ?? false, can_api_access ?? false, user_id, permission_type, account_id]);
    } else {
      // Insert new permission
      await execute(`
        INSERT INTO dnsmanager_user_permissions
          (user_id, permission_type, resource_id, can_view, can_add, can_edit, can_delete, can_api_access, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [user_id, permission_type, account_id, can_view ?? true, can_add ?? false, can_edit ?? false, can_delete ?? false, can_api_access ?? false, user.id]);
    }

    res.json({ success: true, message: 'Cloudflare account permission granted' });
  } catch (error) {
    console.error('Error granting Cloudflare account permission:', error);
    res.status(500).json({ error: 'Failed to grant permission' });
  }
});

// ===== API TOKEN MANAGEMENT =====

// GET /api/permissions/api-access/:userId - Get user's API access settings
router.get('/api-access/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { userId } = req.params;

    // Get target user's API access status
    const [targetUser] = await query<RowDataPacket[]>(`
      SELECT can_use_api FROM dnsmanager_users WHERE id = ?
    `, [userId]);

    if (!Array.isArray(targetUser) || targetUser.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const canUseApi = Boolean(targetUser[0].can_use_api);

    // Return API access status as a token-like object for compatibility
    res.json({
      tokens: [{
        id: 0,
        token_name: 'API Access',
        token_prefix: 'permission',
        can_use_api: canUseApi,
        active: canUseApi
      }]
    });
  } catch (error) {
    console.error('Error fetching API access:', error);
    res.status(500).json({ error: 'Failed to fetch API access' });
  }
});

// POST /api/permissions/api-access/:userId/enable - Enable/disable API access for user
router.post('/api-access/:userId/enable', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { userId } = req.params;
    const { enabled } = req.body;

    // Only superadmin and account_admin can toggle API access
    if (!['superadmin', 'account_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update user's API access permission
    await execute(`
      UPDATE dnsmanager_users
      SET can_use_api = ?
      WHERE id = ?
    `, [enabled ? 1 : 0, userId]);

    res.json({ success: true, message: `API access ${enabled ? 'enabled' : 'disabled'}` });
  } catch (error) {
    console.error('Error updating API access:', error);
    res.status(500).json({ error: 'Failed to update API access' });
  }
});

// DELETE /api/permissions/api-access/:userId/token/:tokenId - Revoke specific token
router.delete('/api-access/:userId/token/:tokenId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { userId, tokenId } = req.params;

    // Get target user's account
    const targetUser = await query<RowDataPacket[]>(`
      SELECT account_id FROM dnsmanager_user_accounts WHERE user_id = ?
    `, [userId]);

    if (targetUser.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accountId = targetUser[0].account_id;

    // Check if current user is admin or account admin
    const isAdmin = user.role === 'superadmin';
    const isAccountAdmin = await query<RowDataPacket[]>(`
      SELECT 1 FROM dnsmanager_user_accounts
      WHERE account_id = ? AND user_id = ? AND is_account_admin = 1
    `, [accountId, user.id]);

    // Users can also revoke their own tokens
    const isSelf = user.id === parseInt(userId);

    if (!isAdmin && isAccountAdmin.length === 0 && !isSelf) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete token
    await execute(`
      DELETE FROM dnsmanager_tokens
      WHERE id = ? AND user_id = ?
    `, [tokenId, userId]);

    res.json({ success: true, message: 'Token revoked' });
  } catch (error) {
    console.error('Error revoking token:', error);
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

export default router;
