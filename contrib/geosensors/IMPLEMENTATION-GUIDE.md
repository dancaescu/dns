# Geographic Multi-Provider DNS Implementation Guide

## Overview

This system enables MyDNS to serve as a Multi-Provider DNS alongside Cloudflare, returning the same Cloudflare proxy IPs that users would get when querying Cloudflare directly, while also implementing geographic-aware access control.

**Key Features:**
1. **Geographic Sensors** - Learn Cloudflare proxy IPs from multiple global locations
2. **Geo-Aware DNS** - Return location-appropriate IPs based on requester's GeoIP
3. **Access Control** - Whitelist/blacklist by IP, network, ASN, country, or continent
4. **Multi-Provider DNS** - Serve same IPs as Cloudflare for seamless failover

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DNS Query Flow                            │
└─────────────────────────────────────────────────────────────┘

1. User queries www.example.com from France
                    ↓
2. MyDNS receives query, extracts source IP (203.0.113.50)
                    ↓
3. GeoIP lookup: 203.0.113.50 → Country: FR → Sensor: EU
                    ↓
4. Access Control check:
   - Check whitelist/blacklist rules
   - If blocked: return REFUSED
                    ↓
5. Zone check: Is use_proxy_ips enabled for example.com?
   - YES: Lookup cloudflare_proxy_ips for EU sensor
   - NO: Return origin IPs from cloudflare_records
                    ↓
6. Return appropriate IPs to user
```

### Component Stack

```
┌──────────────────────────────────────────────────────────┐
│                     Web UI (React)                       │
│  - Sensor management                                     │
│  - Access control rules                                  │
│  - Zone proxy mode toggle                               │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│                 Backend API (Express/Node)                │
│  - /api/sensors/*                                        │
│  - /api/access-control/*                                 │
│  - /api/zones/:id/proxy-mode                            │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│                    MySQL Database                         │
│  - geo_sensors                                           │
│  - cloudflare_proxy_ips                                  │
│  - access_control_rules                                  │
└──────────────────────────────────────────────────────────┘
       ↑                                    ↑
       │                                    │
┌──────────────┐                  ┌────────────────────────┐
│ Sensor (EU)  │                  │   MyDNS C Server       │
│ - Resolves   │                  │   + GeoIP integration  │
│ - Stores IPs │                  │   + Access control     │
└──────────────┘                  └────────────────────────┘
```

---

## Phase 1: Database Setup

### Step 1.1: Apply Schema

```bash
cd /scripts/mydns-ng-master/contrib/geosensors
mysql -u root did < schema.sql
```

**Tables created:**
- `geo_sensors` - Sensor locations
- `cloudflare_proxy_ips` - Learned IPs per sensor
- `geo_country_mapping` - Country → Sensor mapping
- `access_control_rules` - Whitelist/blacklist rules
- `access_control_log` - Access attempt logs
- `geo_sensor_health` - Sensor health monitoring

### Step 1.2: Verify Installation

```sql
-- Check sensors
SELECT * FROM geo_sensors;

-- Check country mappings
SELECT COUNT(*) FROM geo_country_mapping;

-- Verify procedures
SHOW PROCEDURE STATUS WHERE Db = 'did';
```

---

## Phase 2: Deploy Sensors

### Step 2.1: Install Dependencies

On each sensor location (EU, NA, APAC, etc.):

```bash
cd /scripts/mydns-ng-master/contrib/geosensors

# Install Python dependencies
pip3 install -r requirements.txt

# Or system-wide
apt-get install python3-dnspython python3-mysql.connector
```

### Step 2.2: Configure Sensor

The sensor automatically reads from `/etc/mydns/mydns.conf`:

```ini
# /etc/mydns/mydns.conf
db-host = localhost
db-user = root
db-password = your_password
database = did
```

### Step 2.3: Run Sensor

**One-time sync:**
```bash
chmod +x sensor.py
./sensor.py --location eu
```

**Daemon mode (continuous):**
```bash
./sensor.py --location eu --daemon --interval 3600
```

**Install as systemd service:**
```bash
cat > /etc/systemd/system/geosensor-eu.service <<EOF
[Unit]
Description=Geographic DNS Sensor (EU)
After=network.target mysql.service

[Service]
Type=simple
User=root
WorkingDirectory=/scripts/mydns-ng-master/contrib/geosensors
ExecStart=/usr/bin/python3 sensor.py --location eu --daemon --interval 3600
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable geosensor-eu.service
systemctl start geosensor-eu.service
```

### Step 2.4: Monitor Sensors

```bash
# Check sensor status
mysql -u root did -e "SELECT * FROM geo_sensor_health;"

# View learned IPs
mysql -u root did -e "
SELECT s.location_name, COUNT(*) as records
FROM cloudflare_proxy_ips p
JOIN geo_sensors s ON p.sensor_id = s.id
GROUP BY s.id;
"

# Check recent sync
tail -f /var/log/syslog | grep geosensor
```

---

## Phase 3: MyDNS C Code Integration

**⚠️ WARNING:** This requires significant C programming and MyDNS internals knowledge.

### Required Changes

#### 3.1: Add GeoIP Library Integration

**File:** `/scripts/mydns-ng-master/configure.ac`

```bash
# Add GeoIP library check
AC_CHECK_LIB([GeoIP], [GeoIP_open], [], [
    AC_MSG_ERROR([GeoIP library not found. Install with: apt-get install libgeoip-dev])
])
```

**File:** `/scripts/mydns-ng-master/src/lib/Makefile.am`

```makefile
libmydns_a_LIBADD = $(GEOIP_LIBS)
```

#### 3.2: Create GeoIP Module

**File:** `/scripts/mydns-ng-master/src/lib/geoip.h`

```c
#ifndef _MYDNS_GEOIP_H
#define _MYDNS_GEOIP_H

#include <GeoIP.h>
#include <mysql.h>

typedef struct {
    GeoIP *gi;
    MYSQL *db;
} GEOIP_CTX;

/* Initialize GeoIP */
GEOIP_CTX* geoip_init(MYSQL *db);

/* Lookup country code from IP */
const char* geoip_lookup_country(GEOIP_CTX *ctx, const char *ip);

/* Get sensor ID for country */
int geoip_get_sensor_for_country(GEOIP_CTX *ctx, const char *country_code);

/* Get default sensor ID */
int geoip_get_default_sensor(GEOIP_CTX *ctx);

/* Check access control */
int geoip_check_access(GEOIP_CTX *ctx, const char *ip, const char *zone, int access_type);

/* Cleanup */
void geoip_cleanup(GEOIP_CTX *ctx);

#endif /* _MYDNS_GEOIP_H */
```

**File:** `/scripts/mydns-ng-master/src/lib/geoip.c`

```c
#include "geoip.h"
#include "mydns.h"
#include <stdlib.h>
#include <string.h>

GEOIP_CTX* geoip_init(MYSQL *db) {
    GEOIP_CTX *ctx = calloc(1, sizeof(GEOIP_CTX));
    if (!ctx) return NULL;

    /* Open GeoIP database */
    ctx->gi = GeoIP_open("/usr/share/GeoIP/GeoIP.dat", GEOIP_MEMORY_CACHE);
    if (!ctx->gi) {
        /* Try alternative path */
        ctx->gi = GeoIP_open("/var/lib/GeoIP/GeoIP.dat", GEOIP_MEMORY_CACHE);
    }

    if (!ctx->gi) {
        Warnx("GeoIP database not found");
        free(ctx);
        return NULL;
    }

    ctx->db = db;
    return ctx;
}

const char* geoip_lookup_country(GEOIP_CTX *ctx, const char *ip) {
    if (!ctx || !ctx->gi || !ip) return NULL;

    const char *country = GeoIP_country_code_by_addr(ctx->gi, ip);
    return country;
}

int geoip_get_sensor_for_country(GEOIP_CTX *ctx, const char *country_code) {
    if (!ctx || !ctx->db || !country_code) return -1;

    MYSQL_RES *res;
    MYSQL_ROW row;
    int sensor_id = -1;
    char query[256];

    snprintf(query, sizeof(query),
        "SELECT sensor_id FROM geo_country_mapping WHERE country_code='%s' LIMIT 1",
        country_code);

    if (mysql_query(ctx->db, query) == 0) {
        res = mysql_store_result(ctx->db);
        if (res) {
            if ((row = mysql_fetch_row(res))) {
                sensor_id = atoi(row[0]);
            }
            mysql_free_result(res);
        }
    }

    return sensor_id;
}

int geoip_get_default_sensor(GEOIP_CTX *ctx) {
    if (!ctx || !ctx->db) return -1;

    MYSQL_RES *res;
    MYSQL_ROW row;
    int sensor_id = -1;

    if (mysql_query(ctx->db, "SELECT id FROM geo_sensors WHERE is_default=TRUE LIMIT 1") == 0) {
        res = mysql_store_result(ctx->db);
        if (res) {
            if ((row = mysql_fetch_row(res))) {
                sensor_id = atoi(row[0]);
            }
            mysql_free_result(res);
        }
    }

    return sensor_id;
}

int geoip_check_access(GEOIP_CTX *ctx, const char *ip, const char *zone, int access_type) {
    if (!ctx || !ctx->db || !ip) return 0; /* Deny by default */

    MYSQL_RES *res;
    MYSQL_ROW row;
    char query[1024];
    const char *country = geoip_lookup_country(ctx, ip);
    int allowed = 1; /* Default: allow */

    /* Check blacklist first (higher priority) */
    snprintf(query, sizeof(query),
        "SELECT id FROM access_control_rules "
        "WHERE rule_type='blacklist' AND is_active=TRUE "
        "AND (applies_to='both' OR applies_to='%s') "
        "AND (ip_address='%s' OR country_code='%s' OR ip_network IS NOT NULL) "
        "ORDER BY priority LIMIT 1",
        access_type == 0 ? "dns" : "webui", ip, country ? country : "");

    if (mysql_query(ctx->db, query) == 0) {
        res = mysql_store_result(ctx->db);
        if (res) {
            if (mysql_num_rows(res) > 0) {
                allowed = 0; /* Blocked */
            }
            mysql_free_result(res);
        }
    }

    /* Check whitelist if not blocked */
    if (allowed) {
        snprintf(query, sizeof(query),
            "SELECT id FROM access_control_rules "
            "WHERE rule_type='whitelist' AND is_active=TRUE "
            "AND (applies_to='both' OR applies_to='%s') "
            "LIMIT 1",
            access_type == 0 ? "dns" : "webui");

        if (mysql_query(ctx->db, query) == 0) {
            res = mysql_store_result(ctx->db);
            if (res) {
                if (mysql_num_rows(res) > 0) {
                    /* Whitelist exists, check if IP is in it */
                    mysql_free_result(res);

                    snprintf(query, sizeof(query),
                        "SELECT id FROM access_control_rules "
                        "WHERE rule_type='whitelist' AND is_active=TRUE "
                        "AND (applies_to='both' OR applies_to='%s') "
                        "AND (ip_address='%s' OR country_code='%s') "
                        "LIMIT 1",
                        access_type == 0 ? "dns" : "webui", ip, country ? country : "");

                    if (mysql_query(ctx->db, query) == 0) {
                        res = mysql_store_result(ctx->db);
                        if (res) {
                            allowed = (mysql_num_rows(res) > 0);
                            mysql_free_result(res);
                        }
                    }
                } else {
                    mysql_free_result(res);
                }
            }
        }
    }

    /* Log access attempt */
    snprintf(query, sizeof(query),
        "INSERT INTO access_control_log (source_ip, country_code, access_type, action) "
        "VALUES ('%s', '%s', '%s', '%s')",
        ip, country ? country : "", access_type == 0 ? "dns" : "webui",
        allowed ? "allowed" : "blocked");
    mysql_query(ctx->db, query);

    return allowed;
}

void geoip_cleanup(GEOIP_CTX *ctx) {
    if (ctx) {
        if (ctx->gi) {
            GeoIP_delete(ctx->gi);
        }
        free(ctx);
    }
}
```

#### 3.3: Integrate into DNS Query Handler

**File:** `/scripts/mydns-ng-master/src/mydns/task.c`

Add to task structure:
```c
typedef struct _task {
    /* ... existing fields ... */

    /* GeoIP context */
    GEOIP_CTX *geoip_ctx;
    const char *client_country;
    int client_sensor_id;
} TASK;
```

**File:** `/scripts/mydns-ng-master/src/mydns/reply.c`

Modify record lookup to use geo-aware IPs:

```c
/* In reply_add_a() or similar functions */

/* Check if zone uses proxy IPs */
int use_proxy_ips = 0;
int zone_id = /* get from SOA */;

MYSQL_RES *res;
MYSQL_ROW row;
char query[512];

snprintf(query, sizeof(query),
    "SELECT use_proxy_ips FROM cloudflare_zones WHERE zone_id IN "
    "(SELECT zone_id FROM cloudflare_records WHERE record_name='%s' LIMIT 1)",
    r->name);

if (mysql_query(sql, query) == 0) {
    res = mysql_store_result(sql);
    if (res && (row = mysql_fetch_row(res))) {
        use_proxy_ips = atoi(row[0]);
    }
    mysql_free_result(res);
}

if (use_proxy_ips && t->client_sensor_id > 0) {
    /* Get learned IPs for this sensor */
    snprintf(query, sizeof(query),
        "SELECT learned_ips FROM cloudflare_proxy_ips "
        "WHERE record_name='%s' AND sensor_id=%d LIMIT 1",
        r->name, t->client_sensor_id);

    if (mysql_query(sql, query) == 0) {
        res = mysql_store_result(sql);
        if (res && (row = mysql_fetch_row(res))) {
            /* Parse JSON array of IPs */
            const char *ips_json = row[0];
            /* Return these IPs instead of origin IPs */
            /* ... IP parsing and response building ... */
        }
        mysql_free_result(res);
    }
}
```

#### 3.4: Add Access Control to Query Processing

**File:** `/scripts/mydns-ng-master/src/mydns/udp.c`

```c
/* In udp_main() after receiving packet */

/* Extract client IP */
char client_ip[INET6_ADDRSTRLEN];
inet_ntop(AF_INET, &addr.sin_addr, client_ip, sizeof(client_ip));

/* Check access control */
if (!geoip_check_access(geoip_ctx, client_ip, NULL, 0)) {
    /* Log and drop packet or return REFUSED */
    return; /* Or send REFUSED response */
}
```

### Installation Steps for MyDNS Changes

```bash
# Install GeoIP library
apt-get install libgeoip-dev geoip-database

# Download latest GeoIP database
cd /usr/share/GeoIP
wget https://dl.miyuru.lk/geoip/maxmind/country/maxmind.dat.gz
gunzip maxmind.dat.gz
mv maxmind.dat GeoIP.dat

# Rebuild MyDNS
cd /scripts/mydns-ng-master
autoreconf -fi
./configure --with-geoip
make clean
make
make install

# Restart MyDNS
systemctl restart mydns
```

---

## Phase 4: Backend API Implementation

### 4.1: Sensor Management API

**File:** `/contrib/dnsmanager/server/src/routes/sensors.ts`

```typescript
import express from 'express';
import { authenticateToken } from '../middleware/auth';
import db from '../db';

const router = express.Router();

// Get all sensors
router.get('/sensors', authenticateToken, async (req, res) => {
    try {
        const [sensors] = await db.query(`
            SELECT s.*, h.is_online, h.status, h.last_heartbeat, h.records_synced
            FROM geo_sensors s
            LEFT JOIN geo_sensor_health h ON s.id = h.sensor_id
            ORDER BY s.is_default DESC, s.location_name
        `);

        res.json({ success: true, data: sensors });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get sensor by ID
router.get('/sensors/:id', authenticateToken, async (req, res) => {
    try {
        const [sensors] = await db.query(
            'SELECT * FROM geo_sensors WHERE id = ?',
            [req.params.id]
        );

        if (sensors.length === 0) {
            return res.status(404).json({ success: false, error: 'Sensor not found' });
        }

        res.json({ success: true, data: sensors[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create sensor
router.post('/sensors', authenticateToken, async (req, res) => {
    try {
        const { location_name, location_code, continent, description } = req.body;

        const [result] = await db.query(
            'INSERT INTO geo_sensors (location_name, location_code, continent, description) VALUES (?, ?, ?, ?)',
            [location_name, location_code, continent, description]
        );

        res.json({ success: true, id: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update sensor
router.put('/sensors/:id', authenticateToken, async (req, res) => {
    try {
        const { location_name, continent, description, is_active, is_default } = req.body;

        await db.query(
            'UPDATE geo_sensors SET location_name=?, continent=?, description=?, is_active=?, is_default=? WHERE id=?',
            [location_name, continent, description, is_active, is_default, req.params.id]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete sensor
router.delete('/sensors/:id', authenticateToken, async (req, res) => {
    try {
        await db.query('DELETE FROM geo_sensors WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get learned IPs for a zone
router.get('/sensors/:id/ips/:zoneId', authenticateToken, async (req, res) => {
    try {
        const [ips] = await db.query(`
            SELECT record_name, record_type, learned_ips, last_resolved
            FROM cloudflare_proxy_ips
            WHERE sensor_id = ? AND zone_id = ?
            ORDER BY record_name
        `, [req.params.id, req.params.zoneId]);

        res.json({ success: true, data: ips });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
```

### 4.2: Access Control API

**File:** `/contrib/dnsmanager/server/src/routes/accessControl.ts`

```typescript
import express from 'express';
import { authenticateToken } from '../middleware/auth';
import db from '../db';

const router = express.Router();

// Get all rules
router.get('/access-control/rules', authenticateToken, async (req, res) => {
    try {
        const [rules] = await db.query(`
            SELECT r.*, u.username as created_by_name
            FROM access_control_rules r
            LEFT JOIN dnsmanager_user_accounts u ON r.created_by = u.id
            ORDER BY r.priority, r.date_created DESC
        `);

        res.json({ success: true, data: rules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create rule
router.post('/access-control/rules', authenticateToken, async (req, res) => {
    try {
        const {
            rule_name, rule_type, applies_to,
            ip_address, ip_network, asn, country_code, continent,
            zone_id, reason, priority
        } = req.body;

        const [result] = await db.query(`
            INSERT INTO access_control_rules
            (rule_name, rule_type, applies_to, ip_address, ip_network, asn,
             country_code, continent, zone_id, reason, priority, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [rule_name, rule_type, applies_to, ip_address, ip_network, asn,
            country_code, continent, zone_id, reason, priority, req.user.id]);

        res.json({ success: true, id: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Toggle rule active status
router.patch('/access-control/rules/:id/toggle', authenticateToken, async (req, res) => {
    try {
        await db.query(
            'UPDATE access_control_rules SET is_active = NOT is_active WHERE id = ?',
            [req.params.id]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete rule
router.delete('/access-control/rules/:id', authenticateToken, async (req, res) => {
    try {
        await db.query('DELETE FROM access_control_rules WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get access log
router.get('/access-control/log', authenticateToken, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 100;
        const [logs] = await db.query(`
            SELECT * FROM access_control_log
            ORDER BY date_created DESC
            LIMIT ?
        `, [limit]);

        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
```

### 4.3: Zone Proxy Mode API

**File:** `/contrib/dnsmanager/server/src/routes/cloudflare.ts` (add to existing)

```typescript
// Toggle proxy mode for a zone
router.patch('/zones/:zoneId/proxy-mode', authenticateToken, async (req, res) => {
    try {
        const { use_proxy_ips } = req.body;

        await db.query(
            'UPDATE cloudflare_zones SET use_proxy_ips = ?, proxy_mode_updated = NOW() WHERE zone_id = ?',
            [use_proxy_ips, req.params.zoneId]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
```

### 4.4: Register Routes

**File:** `/contrib/dnsmanager/server/src/index.ts`

```typescript
import sensorRoutes from './routes/sensors';
import accessControlRoutes from './routes/accessControl';

// ... existing code ...

app.use('/api', sensorRoutes);
app.use('/api', accessControlRoutes);
```

---

## Phase 5: Web UI Implementation

### 5.1: Sensor Management Page

**File:** `/contrib/dnsmanager/client/src/pages/Sensors.tsx`

```typescript
import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

interface Sensor {
    id: number;
    location_name: string;
    location_code: string;
    continent: string;
    is_default: boolean;
    is_active: boolean;
    is_online: boolean;
    status: string;
    last_heartbeat: string;
    records_synced: number;
}

export default function SensorsPage() {
    const [sensors, setSensors] = useState<Sensor[]>([]);

    useEffect(() => {
        fetchSensors();
    }, []);

    const fetchSensors = async () => {
        const response = await fetch('/api/sensors');
        const data = await response.json();
        setSensors(data.data);
    };

    const toggleActive = async (id: number) => {
        await fetch(`/api/sensors/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: true }),
        });
        fetchSensors();
    };

    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold mb-6">Geographic Sensors</h1>

            <div className="grid gap-4">
                {sensors.map((sensor) => (
                    <Card key={sensor.id}>
                        <CardHeader>
                            <CardTitle className="flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                    {sensor.location_name}
                                    <Badge variant={sensor.is_online ? 'default' : 'destructive'}>
                                        {sensor.is_online ? 'Online' : 'Offline'}
                                    </Badge>
                                    {sensor.is_default && <Badge>Default</Badge>}
                                </div>
                                <Switch
                                    checked={sensor.is_active}
                                    onCheckedChange={() => toggleActive(sensor.id)}
                                />
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                    <span className="text-gray-500">Code:</span> {sensor.location_code}
                                </div>
                                <div>
                                    <span className="text-gray-500">Continent:</span> {sensor.continent}
                                </div>
                                <div>
                                    <span className="text-gray-500">Records Synced:</span> {sensor.records_synced}
                                </div>
                                <div>
                                    <span className="text-gray-500">Last Heartbeat:</span> {sensor.last_heartbeat}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
```

### 5.2: Proxy Mode Toggle in Zone Page

**File:** `/contrib/dnsmanager/client/src/pages/CloudflareZonePage.tsx` (modify existing)

Add to zone header:

```typescript
const [useProxyIPs, setUseProxyIPs] = useState(false);

// Load current setting
useEffect(() => {
    fetch(`/api/zones/${zoneId}`)
        .then(res => res.json())
        .then(data => setUseProxyIPs(data.use_proxy_ips));
}, [zoneId]);

// Toggle handler
const toggleProxyMode = async () => {
    await fetch(`/api/zones/${zoneId}/proxy-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_proxy_ips: !useProxyIPs }),
    });
    setUseProxyIPs(!useProxyIPs);
};

// Add to UI
<div className="flex items-center gap-4">
    <label>Serve Cloudflare Proxy IPs:</label>
    <Switch checked={useProxyIPs} onCheckedChange={toggleProxyMode} />
    <span className="text-sm text-gray-500">
        {useProxyIPs ? 'Using learned geo IPs' : 'Using origin IPs'}
    </span>
</div>
```

### 5.3: Access Control Page

**File:** `/contrib/dnsmanager/client/src/pages/AccessControl.tsx`

```typescript
import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

interface AccessRule {
    id: number;
    rule_name: string;
    rule_type: 'whitelist' | 'blacklist';
    applies_to: 'dns' | 'webui' | 'both';
    ip_address?: string;
    country_code?: string;
    is_active: boolean;
    hit_count: number;
}

export default function AccessControlPage() {
    const [rules, setRules] = useState<AccessRule[]>([]);

    useEffect(() => {
        fetchRules();
    }, []);

    const fetchRules = async () => {
        const response = await fetch('/api/access-control/rules');
        const data = await response.json();
        setRules(data.data);
    };

    const toggleRule = async (id: number) => {
        await fetch(`/api/access-control/rules/${id}/toggle`, { method: 'PATCH' });
        fetchRules();
    };

    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold mb-6">Access Control Rules</h1>

            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Rule Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Applies To</TableHead>
                        <TableHead>Criteria</TableHead>
                        <TableHead>Hits</TableHead>
                        <TableHead>Active</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rules.map((rule) => (
                        <TableRow key={rule.id}>
                            <TableCell>{rule.rule_name}</TableCell>
                            <TableCell>
                                <Badge variant={rule.rule_type === 'blacklist' ? 'destructive' : 'default'}>
                                    {rule.rule_type}
                                </Badge>
                            </TableCell>
                            <TableCell>{rule.applies_to}</TableCell>
                            <TableCell>
                                {rule.ip_address || rule.country_code || 'N/A'}
                            </TableCell>
                            <TableCell>{rule.hit_count}</TableCell>
                            <TableCell>
                                <Switch
                                    checked={rule.is_active}
                                    onCheckedChange={() => toggleRule(rule.id)}
                                />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
```

---

## Testing

### Test Sensor

```bash
# Run sensor
./sensor.py --location na

# Verify learned IPs
mysql -u root did -e "
SELECT s.location_name, p.record_name, p.learned_ips
FROM cloudflare_proxy_ips p
JOIN geo_sensors s ON p.sensor_id = s.id
LIMIT 10;
"
```

### Test Access Control

```sql
-- Add test rule
INSERT INTO access_control_rules (rule_name, rule_type, applies_to, country_code, reason)
VALUES ('Test Block CN', 'blacklist', 'dns', 'CN', 'Testing');

-- Query from MyDNS and check logs
SELECT * FROM access_control_log ORDER BY date_created DESC LIMIT 10;
```

### Test Geo-Aware DNS

```bash
# From different locations, query same record
dig @your-mydns-server www.example.com A

# Should get different IPs based on your location
```

---

## Deployment Checklist

- [ ] Apply database schema
- [ ] Deploy sensors in multiple locations (EU, NA, APAC)
- [ ] Configure sensors as systemd services
- [ ] Verify sensors are syncing (check geo_sensor_health)
- [ ] Update MyDNS with GeoIP support
- [ ] Rebuild and restart MyDNS
- [ ] Deploy backend API updates
- [ ] Deploy frontend UI updates
- [ ] Configure access control rules
- [ ] Test geo-aware DNS responses
- [ ] Monitor sensor health
- [ ] Set up alerting for sensor failures

---

## Monitoring

```bash
# Sensor health
mysql -u root did -e "SELECT * FROM geo_sensor_health;"

# Access control hits
mysql -u root did -e "
SELECT rule_name, hit_count, last_hit
FROM access_control_rules
WHERE hit_count > 0
ORDER BY hit_count DESC;
"

# Learned IPs summary
mysql -u root did -e "
SELECT
    s.location_name,
    COUNT(*) as records,
    COUNT(DISTINCT p.zone_id) as zones
FROM cloudflare_proxy_ips p
JOIN geo_sensors s ON p.sensor_id = s.id
GROUP BY s.id;
"
```

---

## Troubleshooting

**Sensor not syncing:**
- Check database connectivity
- Check Cloudflare API credentials
- Check DNS resolution (dig should work)
- Check sensor logs: `journalctl -u geosensor-*`

**MyDNS not returning geo IPs:**
- Verify GeoIP database exists: `ls /usr/share/GeoIP/`
- Check use_proxy_ips is enabled for zone
- Check learned IPs exist for sensor
- Check MyDNS logs for errors

**Access control not working:**
- Verify rules are active
- Check rule priority
- Check access_control_log for blocked attempts
- Verify GeoIP is working in MyDNS

---

## Security Considerations

1. **Sensor Security:** Run sensors on trusted infrastructure
2. **API Authentication:** Ensure all API endpoints require auth
3. **Database Access:** Limit sensor database permissions
4. **GeoIP Updates:** Keep GeoIP database updated
5. **Access Logs:** Monitor for abuse patterns
6. **Rate Limiting:** Implement API rate limiting

---

## Performance

**Database Indexes:** Already created in schema for optimal performance

**Caching:** Consider caching learned IPs in MyDNS memory

**Sensor Frequency:** Run hourly (3600s) - Cloudflare IPs don't change often

**Log Retention:** Clean logs older than 30 days automatically

---

## Future Enhancements

- [ ] IPv6 GeoIP support
- [ ] ASN-based routing
- [ ] Real-time sensor sync via WebSocket
- [ ] Machine learning for attack detection
- [ ] Automatic sensor failover
- [ ] Per-record proxy mode (not just per-zone)
- [ ] Sensor health alerting
- [ ] Dashboard for geo distribution visualization

---

## Support

For issues or questions:
1. Check sensor logs: `journalctl -u geosensor-*`
2. Check MyDNS logs: `tail -f /var/log/syslog | grep mydns`
3. Check database for errors: `SELECT * FROM geo_sensor_health;`
4. Review access control logs: `SELECT * FROM access_control_log LIMIT 100;`
