/**
 * GeoSensor API Routes
 * Date: 2025-11-26
 *
 * Handles:
 * - Sensor data submission from sensor.py
 * - Sensor management (CRUD)
 * - Access control rules
 * - Geo-aware RR management
 */

import express, { Request, Response } from 'express';
import { getSession } from '../auth.js';
import { query, execute } from '../db.js';
import { z } from 'zod';

const router = express.Router();

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

  req.session = session;
  next();
}

// Middleware to require superadmin role
function requireSuperadmin(req: any, res: any, next: any) {
  if (req.session.role !== "superadmin") {
    return res.status(403).json({ message: "Superadmin access required" });
  }
  next();
}

// ============================================================================
// SENSOR DATA SUBMISSION
// ============================================================================

/**
 * Submit sensor data (from sensor.py)
 * POST /api/sensors/submit
 *
 * Authorization:
 * - Superadmin: can update all zones
 * - Account admin/user: can only update their own zones
 */
const submitSchema = z.object({
  sensor_id: z.number(),
  location_code: z.string(),
  results: z.array(z.object({
    zone_id: z.string(),
    record_id: z.string(),
    record_name: z.string(),
    record_type: z.enum(['A', 'AAAA', 'CNAME']),
    learned_ips: z.array(z.string())
  })),
  timestamp: z.string()
});

router.post('/submit', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = submitSchema.parse(req.body);
    const userId = (req as any).session.userId;
    const isSuperuser = (req as any).session.role === 'superadmin';

    // Verify sensor exists and is active
    const [sensorRows] = await query(
      `SELECT id, location_name, is_active
       FROM geo_sensors
       WHERE id = ? AND location_code = ?`,
      [data.sensor_id, data.location_code]
    );

    if (!Array.isArray(sensorRows) || sensorRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sensor not found or inactive'
      });
    }

    const sensor = sensorRows[0] as any;
    if (!sensor.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Sensor is not active'
      });
    }

    let processed = 0;
    let errors = 0;
    const errorMessages: string[] = [];

    // Process each result
    for (const result of data.results) {
      try {
        // Authorization check: verify user owns this zone
        if (!isSuperuser) {
          const [zoneOwnerRows] = await query(
            `SELECT cz.zone_id
             FROM cloudflare_zones cz
             JOIN dnsmanager_user_accounts ua ON cz.account_id = ua.account_id
             WHERE cz.zone_id = ? AND ua.user_id = ?`,
            [result.zone_id, userId]
          );

          if (!Array.isArray(zoneOwnerRows) || zoneOwnerRows.length === 0) {
            errorMessages.push(`Unauthorized: zone ${result.zone_id} not owned by user`);
            errors++;
            continue;
          }
        }

        // Insert or update learned IPs
        const learnedIpsJson = JSON.stringify(result.learned_ips);

        await query(
          `INSERT INTO cloudflare_proxy_ips
           (zone_id, record_id, record_name, record_type, sensor_id, learned_ips, is_proxied, resolve_count)
           VALUES (?, ?, ?, ?, ?, ?, TRUE, 1)
           ON DUPLICATE KEY UPDATE
             learned_ips = VALUES(learned_ips),
             last_resolved = CURRENT_TIMESTAMP,
             resolve_count = resolve_count + 1`,
          [
            result.zone_id,
            result.record_id,
            result.record_name,
            result.record_type,
            data.sensor_id,
            learnedIpsJson
          ]
        );

        processed++;

      } catch (error: any) {
        errors++;
        errorMessages.push(`Error processing ${result.record_name}: ${error.message}`);
      }
    }

    // Update sensor health
    await query(
      `CALL update_sensor_health(?, TRUE, ?, ?)`,
      [data.sensor_id, processed, errors]
    );

    res.json({
      success: true,
      processed,
      errors,
      error_messages: errors > 0 ? errorMessages : undefined
    });

  } catch (error: any) {
    console.error('Error in sensor submit:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Get zones that need syncing
 * GET /api/sensors/zones-to-sync
 *
 * Returns zones based on authentication:
 * - Superadmin: all zones with use_proxy_ips=1
 * - User: only their zones with use_proxy_ips=1
 */
router.get('/zones-to-sync', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).session.userId;
    const isSuperuser = (req as any).session.role === 'superadmin';

    let query: string;
    let params: any[];

    if (isSuperuser) {
      // Superadmin: all zones with use_proxy_ips=1
      query = `
        SELECT
          cz.zone_id,
          cz.zone_name,
          cz.account_id,
          cz.use_proxy_ips
        FROM cloudflare_zones cz
        WHERE cz.use_proxy_ips = TRUE
          AND cz.is_active = TRUE
        ORDER BY cz.zone_name
      `;
      params = [];
    } else {
      // Regular user: only their zones with use_proxy_ips=1
      query = `
        SELECT
          cz.zone_id,
          cz.zone_name,
          cz.account_id,
          cz.use_proxy_ips
        FROM cloudflare_zones cz
        JOIN dnsmanager_user_accounts ua ON cz.account_id = ua.account_id
        WHERE cz.use_proxy_ips = TRUE
          AND cz.is_active = TRUE
          AND ua.user_id = ?
        ORDER BY cz.zone_name
      `;
      params = [userId];
    }

    const [rows] = await query(query, params);
    res.json(rows);

  } catch (error: any) {
    console.error('Error fetching zones to sync:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Get proxied records for a zone
 * GET /api/sensors/zones/:zoneId/proxied-records
 */
router.get('/zones/:zoneId/proxied-records', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const userId = (req as any).session.userId;
    const isSuperuser = (req as any).session.role === 'superadmin';

    // Authorization check
    if (!isSuperuser) {
      const [ownerRows] = await query(
        `SELECT cz.zone_id
         FROM cloudflare_zones cz
         JOIN dnsmanager_user_accounts ua ON cz.account_id = ua.account_id
         WHERE cz.zone_id = ? AND ua.user_id = ?`,
        [zoneId, userId]
      );

      if (!Array.isArray(ownerRows) || ownerRows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }
    }

    // Get proxied records
    const [rows] = await query(
      `SELECT
        record_id,
        record_name,
        record_type,
        ttl,
        proxied
       FROM cloudflare_records
       WHERE zone_id = ?
         AND proxied = TRUE
         AND record_type IN ('A', 'AAAA', 'CNAME')
         AND deleted_at IS NULL
       ORDER BY record_name`,
      [zoneId]
    );

    res.json(rows);

  } catch (error: any) {
    console.error('Error fetching proxied records:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================================================
// SENSOR MANAGEMENT
// ============================================================================

/**
 * Get sensor by location code
 * GET /api/sensors/:locationCode
 */
router.get('/:locationCode', requireAuth, async (req: Request, res: Response) => {
  try {
    const { locationCode } = req.params;

    const [rows] = await query(
      `SELECT
        id,
        location_name,
        location_code,
        description,
        continent,
        is_default,
        is_active
       FROM geo_sensors
       WHERE location_code = ?`,
      [locationCode]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sensor not found'
      });
    }

    res.json(rows[0]);

  } catch (error: any) {
    console.error('Error fetching sensor:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * List all sensors
 * GET /api/sensors
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const [rows] = await query(
      `SELECT
        s.id,
        s.location_name,
        s.location_code,
        s.description,
        s.continent,
        s.is_default,
        s.is_active,
        s.last_sync,
        h.is_online,
        h.status,
        h.records_synced,
        h.sync_errors
       FROM geo_sensors s
       LEFT JOIN geo_sensor_health h ON s.id = h.sensor_id
       ORDER BY s.is_default DESC, s.location_name`
    );

    res.json({ success: true, data: rows });

  } catch (error: any) {
    console.error('Error listing sensors:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Create custom sensor (for users with custom locations)
 * POST /api/sensors
 * Requires authentication, creates user-specific sensor
 */
const createSensorSchema = z.object({
  location_name: z.string().min(1).max(50),
  location_code: z.string().min(2).max(10),
  description: z.string().optional(),
  continent: z.string().optional()
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = createSensorSchema.parse(req.body);
    const userId = (req as any).session.userId;

    // Check if location_code already exists
    const [existing] = await query(
      'SELECT id FROM geo_sensors WHERE location_code = ?',
      [data.location_code]
    );

    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Sensor with this location code already exists'
      });
    }

    // Create sensor
    const [result] = await query(
      `INSERT INTO geo_sensors
       (location_name, location_code, description, continent, is_default, is_active, created_by_user_id)
       VALUES (?, ?, ?, ?, FALSE, TRUE, ?)`,
      [
        data.location_name,
        data.location_code,
        data.description || `Custom sensor - ${data.location_name}`,
        data.continent || null,
        userId
      ]
    );

    const insertResult = result as any;

    res.json({
      success: true,
      sensor_id: insertResult.insertId,
      message: 'Sensor created successfully'
    });

  } catch (error: any) {
    console.error('Error creating sensor:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================================================
// GEO-AWARE RR MANAGEMENT
// ============================================================================

/**
 * Get geo-aware records for a zone
 * GET /api/geo-rr/zone/:zoneId
 */
router.get('/geo-rr/zone/:zoneId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const userId = (req as any).session.userId;
    const isSuperuser = (req as any).session.role === 'superadmin';

    // Authorization check
    if (!isSuperuser) {
      const [ownerRows] = await query(
        `SELECT id FROM soa WHERE id = ? AND xfer IN (
          SELECT CONCAT(user_id) FROM dnsmanager_user_accounts WHERE user_id = ?
        )`,
        [zoneId, userId]
      );

      if (!Array.isArray(ownerRows) || ownerRows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }
    }

    // Get geo-aware records
    const [rows] = await query(
      `SELECT
        r.id as rr_id,
        r.name,
        r.type,
        r.data as default_data,
        r.ttl,
        g.id as geo_id,
        g.sensor_id,
        s.location_name,
        s.location_code,
        g.data as geo_data,
        g.is_active
       FROM rr r
       LEFT JOIN geo_rr g ON r.id = g.rr_id
       LEFT JOIN geo_sensors s ON g.sensor_id = s.id
       WHERE r.zone = ?
         AND r.type IN ('A', 'AAAA')
       ORDER BY r.name, s.location_name`,
      [zoneId]
    );

    res.json({ success: true, data: rows });

  } catch (error: any) {
    console.error('Error fetching geo-aware records:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Set geo-specific IP for a record
 * POST /api/geo-rr
 */
const setGeoIPSchema = z.object({
  rr_id: z.number(),
  zone_id: z.number(),
  sensor_id: z.number(),
  data: z.string(), // IP address
  is_active: z.boolean().optional()
});

router.post('/geo-rr', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = setGeoIPSchema.parse(req.body);
    const userId = (req as any).session.userId;
    const isSuperuser = (req as any).session.role === 'superadmin';

    // Authorization check
    if (!isSuperuser) {
      const [ownerRows] = await query(
        `SELECT id FROM soa WHERE id = ? AND xfer IN (
          SELECT CONCAT(user_id) FROM dnsmanager_user_accounts WHERE user_id = ?
        )`,
        [data.zone_id, userId]
      );

      if (!Array.isArray(ownerRows) || ownerRows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }
    }

    // Verify record exists and belongs to zone
    const [rrRows] = await query(
      'SELECT id FROM rr WHERE id = ? AND zone = ?',
      [data.rr_id, data.zone_id]
    );

    if (!Array.isArray(rrRows) || rrRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Record not found or does not belong to zone'
      });
    }

    // Insert or update geo-specific IP
    await query(
      `INSERT INTO geo_rr (rr_id, zone_id, sensor_id, data, is_active)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         data = VALUES(data),
         is_active = VALUES(is_active),
         date_updated = CURRENT_TIMESTAMP`,
      [
        data.rr_id,
        data.zone_id,
        data.sensor_id,
        data.data,
        data.is_active !== undefined ? data.is_active : true
      ]
    );

    res.json({
      success: true,
      message: 'Geo-specific IP set successfully'
    });

  } catch (error: any) {
    console.error('Error setting geo-specific IP:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Delete geo-specific IP
 * DELETE /api/geo-rr/:geoId
 */
router.delete('/geo-rr/:geoId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { geoId } = req.params;
    const userId = (req as any).session.userId;
    const isSuperuser = (req as any).session.role === 'superadmin';

    // Authorization check
    if (!isSuperuser) {
      const [ownerRows] = await query(
        `SELECT g.id
         FROM geo_rr g
         JOIN soa s ON g.zone_id = s.id
         WHERE g.id = ? AND s.xfer IN (
           SELECT CONCAT(user_id) FROM dnsmanager_user_accounts WHERE user_id = ?
         )`,
        [geoId, userId]
      );

      if (!Array.isArray(ownerRows) || ownerRows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }
    }

    await query('DELETE FROM geo_rr WHERE id = ?', [geoId]);

    res.json({
      success: true,
      message: 'Geo-specific IP deleted successfully'
    });

  } catch (error: any) {
    console.error('Error deleting geo-specific IP:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Toggle zone GeoIP
 * PATCH /api/geo-rr/zone/:zoneId/toggle
 */
router.patch('/geo-rr/zone/:zoneId/toggle', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const { use_geoip } = req.body;
    const userId = (req as any).session.userId;
    const isSuperuser = (req as any).session.role === 'superadmin';

    // Authorization check
    if (!isSuperuser) {
      const [ownerRows] = await query(
        `SELECT id FROM soa WHERE id = ? AND xfer IN (
          SELECT CONCAT(user_id) FROM dnsmanager_user_accounts WHERE user_id = ?
        )`,
        [zoneId, userId]
      );

      if (!Array.isArray(ownerRows) || ownerRows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }
    }

    await query(
      'UPDATE soa SET use_geoip = ?, geoip_updated = CURRENT_TIMESTAMP WHERE id = ?',
      [use_geoip ? 1 : 0, zoneId]
    );

    res.json({
      success: true,
      message: `GeoIP ${use_geoip ? 'enabled' : 'disabled'} for zone`
    });

  } catch (error: any) {
    console.error('Error toggling zone GeoIP:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================================================
// SENSOR SCRIPT AUTO-UPDATE
// ============================================================================

/**
 * Check for script updates
 * GET /api/sensors/script/version
 * Public endpoint (no auth required)
 */
router.get('/script/version', async (req: Request, res: Response) => {
  try {
    const [rows] = await query(
      `SELECT version, changelog, min_python_version, date_updated
       FROM sensor_script_versions
       WHERE is_active = TRUE
       LIMIT 1`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active script version found'
      });
    }

    res.json({
      success: true,
      ...rows[0]
    });

  } catch (error: any) {
    console.error('Error checking script version:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Download latest script and prerequisites
 * GET /api/sensors/script/download
 * Requires authentication
 */
router.get('/script/download', requireAuth, async (req: Request, res: Response) => {
  try {
    const [rows] = await query(
      `SELECT version, script_content, prerequisites_script, changelog, min_python_version
       FROM sensor_script_versions
       WHERE is_active = TRUE
       LIMIT 1`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active script version found'
      });
    }

    const scriptData = rows[0] as any;

    res.json({
      success: true,
      version: scriptData.version,
      script_content: scriptData.script_content,
      prerequisites_script: scriptData.prerequisites_script,
      changelog: scriptData.changelog,
      min_python_version: scriptData.min_python_version
    });

  } catch (error: any) {
    console.error('Error downloading script:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * Upload new script version (superadmin only)
 * POST /api/sensors/script/upload
 */
const uploadScriptSchema = z.object({
  version: z.string(),
  script_content: z.string(),
  prerequisites_script: z.string().optional(),
  changelog: z.string().optional(),
  min_python_version: z.string().optional(),
  make_active: z.boolean().optional()
});

router.post('/script/upload', requireAuth, async (req: Request, res: Response) => {
  try {
    const isSuperuser = (req as any).session.role === 'superadmin';

    if (!isSuperuser) {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can upload script versions'
      });
    }

    const data = uploadScriptSchema.parse(req.body);

    // If make_active, deactivate all other versions first
    if (data.make_active) {
      await query('UPDATE sensor_script_versions SET is_active = FALSE');
    }

    // Insert new version
    await query(
      `INSERT INTO sensor_script_versions
       (version, script_content, prerequisites_script, changelog, min_python_version, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.version,
        data.script_content,
        data.prerequisites_script || null,
        data.changelog || null,
        data.min_python_version || '3.7',
        data.make_active || false
      ]
    );

    res.json({
      success: true,
      message: `Script version ${data.version} uploaded successfully`
    });

  } catch (error: any) {
    console.error('Error uploading script:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export default router;
