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

// Middleware to check admin access
function requireAdmin(req: any, res: Response, next: any) {
  const user = req.user;
  if (!['superadmin', 'account_admin'].includes(user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// GET /api/acl - List all ACL rules
router.get('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [rules] = await query<RowDataPacket[]>(`
      SELECT
        id,
        target,
        type,
        value,
        action,
        description,
        priority,
        enabled,
        created_at,
        updated_at
      FROM access_control
      ORDER BY priority ASC, created_at DESC
    `);

    res.json({ rules: rules || [] });
  } catch (error) {
    console.error('Error fetching ACL rules:', error);
    res.status(500).json({ error: 'Failed to fetch ACL rules' });
  }
});

// GET /api/acl/:id - Get single ACL rule
router.get('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [rows] = await query<RowDataPacket[]>(
      'SELECT * FROM access_control WHERE id = ?',
      [req.params.id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'ACL rule not found' });
    }

    res.json({ rule: rows[0] });
  } catch (error) {
    console.error('Error fetching ACL rule:', error);
    res.status(500).json({ error: 'Failed to fetch ACL rule' });
  }
});

// POST /api/acl - Create new ACL rule
router.post('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { target, type, value, action, description, priority, enabled } = req.body;

    // Validate required fields
    if (!target || !type || !value || !action) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate target
    const validTargets = ['system', 'master', 'slave', 'cache', 'webui', 'doh'];
    if (!validTargets.includes(target)) {
      return res.status(400).json({ error: 'Invalid target. Must be one of: ' + validTargets.join(', ') });
    }

    // Validate type
    const validTypes = ['ip', 'network', 'country', 'asn'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be one of: ' + validTypes.join(', ') });
    }

    // Validate action
    const validActions = ['allow', 'deny'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be allow or deny' });
    }

    // Validate value format based on type
    if (type === 'ip') {
      // Basic IPv4/IPv6 validation
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
      if (!ipv4Regex.test(value) && !ipv6Regex.test(value)) {
        return res.status(400).json({ error: 'Invalid IP address format' });
      }
    } else if (type === 'network') {
      // CIDR validation
      const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
      if (!cidrRegex.test(value)) {
        return res.status(400).json({ error: 'Invalid network CIDR format' });
      }
    } else if (type === 'country') {
      // 2-letter country code
      if (!/^[A-Z]{2}$/.test(value)) {
        return res.status(400).json({ error: 'Country code must be 2 uppercase letters (e.g., US, CN)' });
      }
    } else if (type === 'asn') {
      // ASN number
      if (!/^AS?\d+$/.test(value)) {
        return res.status(400).json({ error: 'ASN must be a number with optional AS prefix (e.g., AS15169 or 15169)' });
      }
    }

    const [result] = await execute<ResultSetHeader>(`
      INSERT INTO access_control
        (target, type, value, action, description, priority, enabled, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [target, type, value, action, description || null, priority || 100, enabled !== false ? 1 : 0, user.user_id]);

    res.json({
      message: 'ACL rule created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating ACL rule:', error);
    res.status(500).json({ error: 'Failed to create ACL rule' });
  }
});

// PUT /api/acl/:id - Update ACL rule
router.put('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { target, type, value, action, description, priority, enabled } = req.body;

    // Check if rule exists
    const [existing] = await query<RowDataPacket[]>(
      'SELECT id FROM access_control WHERE id = ?',
      [req.params.id]
    );

    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'ACL rule not found' });
    }

    // Validate fields (same as POST)
    if (target) {
      const validTargets = ['system', 'master', 'slave', 'cache', 'webui', 'doh'];
      if (!validTargets.includes(target)) {
        return res.status(400).json({ error: 'Invalid target' });
      }
    }

    if (type) {
      const validTypes = ['ip', 'network', 'country', 'asn'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid type' });
      }
    }

    if (action) {
      const validActions = ['allow', 'deny'];
      if (!validActions.includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
      }
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];

    if (target !== undefined) {
      updates.push('target = ?');
      values.push(target);
    }
    if (type !== undefined) {
      updates.push('type = ?');
      values.push(type);
    }
    if (value !== undefined) {
      updates.push('value = ?');
      values.push(value);
    }
    if (action !== undefined) {
      updates.push('action = ?');
      values.push(action);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      values.push(priority);
    }
    if (enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(enabled ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(req.params.id);

    await execute(
      `UPDATE access_control SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    res.json({ message: 'ACL rule updated successfully' });
  } catch (error) {
    console.error('Error updating ACL rule:', error);
    res.status(500).json({ error: 'Failed to update ACL rule' });
  }
});

// DELETE /api/acl/:id - Delete ACL rule
router.delete('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [result] = await execute<ResultSetHeader>(
      'DELETE FROM access_control WHERE id = ?',
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'ACL rule not found' });
    }

    res.json({ message: 'ACL rule deleted successfully' });
  } catch (error) {
    console.error('Error deleting ACL rule:', error);
    res.status(500).json({ error: 'Failed to delete ACL rule' });
  }
});

// GET /api/acl/stats - Get ACL statistics
router.get('/stats/summary', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [stats] = await query<RowDataPacket[]>(`
      SELECT
        target,
        COUNT(*) as total_rules,
        SUM(CASE WHEN action = 'allow' THEN 1 ELSE 0 END) as allow_rules,
        SUM(CASE WHEN action = 'deny' THEN 1 ELSE 0 END) as deny_rules,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_rules
      FROM access_control
      GROUP BY target
      ORDER BY target
    `);

    res.json({ stats: stats || [] });
  } catch (error) {
    console.error('Error fetching ACL stats:', error);
    res.status(500).json({ error: 'Failed to fetch ACL stats' });
  }
});

// GET /api/acl/cache-config - Get DNS cache configuration
router.get('/cache-config', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [rows] = await query<RowDataPacket[]>(
      'SELECT * FROM dns_cache_config LIMIT 1'
    );

    if (!rows || rows.length === 0) {
      // Return default configuration
      return res.json({
        config: {
          enabled: true,
          cache_size_mb: 256,
          cache_ttl_min: 60,
          cache_ttl_max: 86400,
          upstream_servers: '8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1'
        }
      });
    }

    res.json({ config: rows[0] });
  } catch (error) {
    console.error('Error fetching cache config:', error);
    res.status(500).json({ error: 'Failed to fetch cache config' });
  }
});

// PUT /api/acl/cache-config - Update DNS cache configuration
router.put('/cache-config', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { enabled, cache_size_mb, cache_ttl_min, cache_ttl_max, upstream_servers } = req.body;

    // Validate values
    if (cache_size_mb !== undefined && (cache_size_mb < 1 || cache_size_mb > 4096)) {
      return res.status(400).json({ error: 'Cache size must be between 1 and 4096 MB' });
    }

    if (cache_ttl_min !== undefined && (cache_ttl_min < 1 || cache_ttl_min > 86400)) {
      return res.status(400).json({ error: 'Minimum TTL must be between 1 and 86400 seconds' });
    }

    if (cache_ttl_max !== undefined && (cache_ttl_max < 60 || cache_ttl_max > 604800)) {
      return res.status(400).json({ error: 'Maximum TTL must be between 60 and 604800 seconds' });
    }

    if (cache_ttl_min !== undefined && cache_ttl_max !== undefined && cache_ttl_min >= cache_ttl_max) {
      return res.status(400).json({ error: 'Minimum TTL must be less than maximum TTL' });
    }

    // Check if config exists
    const [existing] = await query<RowDataPacket[]>('SELECT id FROM dns_cache_config LIMIT 1');

    const updates: string[] = [];
    const values: any[] = [];

    if (enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(enabled ? 1 : 0);
    }
    if (cache_size_mb !== undefined) {
      updates.push('cache_size_mb = ?');
      values.push(cache_size_mb);
    }
    if (cache_ttl_min !== undefined) {
      updates.push('cache_ttl_min = ?');
      values.push(cache_ttl_min);
    }
    if (cache_ttl_max !== undefined) {
      updates.push('cache_ttl_max = ?');
      values.push(cache_ttl_max);
    }
    if (upstream_servers !== undefined) {
      updates.push('upstream_servers = ?');
      values.push(upstream_servers);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');

    if (existing && existing.length > 0) {
      // Update existing
      values.push(existing[0].id);
      await execute(
        `UPDATE dns_cache_config SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    } else {
      // Insert new
      await execute(`
        INSERT INTO dns_cache_config
          (enabled, cache_size_mb, cache_ttl_min, cache_ttl_max, upstream_servers)
        VALUES (?, ?, ?, ?, ?)
      `, [
        enabled !== false ? 1 : 0,
        cache_size_mb || 256,
        cache_ttl_min || 60,
        cache_ttl_max || 86400,
        upstream_servers || '8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1'
      ]);
    }

    res.json({ message: 'Cache configuration updated successfully' });
  } catch (error) {
    console.error('Error updating cache config:', error);
    res.status(500).json({ error: 'Failed to update cache config' });
  }
});

export default router;
