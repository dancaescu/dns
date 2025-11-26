# MyDNS AXFR Slave Configuration Guide

Complete guide for configuring MyDNS to act as a slave DNS server receiving zone transfers via AXFR.

## Overview

MyDNS can now operate as an **AXFR slave**, pulling zone data from master DNS servers (BIND, PowerDNS, or other MyDNS servers) and storing it in the MySQL database.

This is useful for:
- **Hybrid deployments** - Master zones in BIND/PowerDNS, slaves in MyDNS
- **Migration scenarios** - Gradually migrate from BIND to MyDNS
- **Secondary DNS** - Use MyDNS as secondary for external primary servers
- **Load distribution** - Pull zones from central master to regional slaves

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│            Master DNS Server (BIND/PowerDNS)            │
│            - Authoritative zone data                    │
│            - Serves AXFR transfers                      │
└────────────────────┬────────────────────────────────────┘
                     │ AXFR over TCP
                     │ (Port 53)
                     ▼
┌────────────────────────────────────────────────────────┐
│                  mydns-xfer Daemon                      │
│                  - Checks SOA serials                   │
│                  - Requests AXFR transfers              │
│                  - Parses zone data                     │
└────────────────────┬───────────────────────────────────┘
                     │ SQL INSERT/UPDATE
                     ▼
┌────────────────────────────────────────────────────────┐
│                  MySQL Database                         │
│                  - soa table (zone info)                │
│                  - rr table (DNS records)               │
│                  - zone_masters (master config)         │
│                  - zone_transfer_log (history)          │
└────────────────────┬───────────────────────────────────┘
                     │ SQL SELECT
                     ▼
┌────────────────────────────────────────────────────────┐
│                  MyDNS Server                           │
│                  - Serves DNS queries                   │
│                  - Reads from MySQL                     │
└────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **MyDNS compiled with AXFR support**
2. **MySQL database** with MyDNS schema
3. **Master DNS server** configured to allow AXFR from your IP
4. **Network connectivity** between slave and master (TCP port 53)

## Installation

### Step 1: Install Database Schema

Apply the AXFR slave schema to your MyDNS database:

```bash
mysql -u root -p did < /scripts/mydns-ng-master/contrib/axfr-slave-schema.sql
```

This creates:
- `zone_masters` table - Master server configuration
- `zone_transfer_log` table - Transfer history
- `soa.slave_mode` column - Marks zones as slaves
- Views and stored procedures for monitoring

### Step 2: Build MyDNS with AXFR Support

```bash
cd /scripts/mydns-ng-master

# Configure with AXFR support
./configure --prefix=/usr --with-mysql --with-geoip --with-axfr

# Build
make

# Install
make install
```

### Step 3: Verify Installation

```bash
# Check if mydns-xfer was installed
which mydns-xfer

# Show version
mydns-xfer -v

# Show help
mydns-xfer -h
```

## Configuration

### Configure Master Server (BIND Example)

On your master DNS server, allow AXFR transfers from your MyDNS slave:

```bind
// /etc/bind/named.conf.local

zone "example.com" {
    type master;
    file "/var/cache/bind/db.example.com";

    // Allow AXFR from MyDNS slave IP
    allow-transfer { 192.168.1.10; };  // MyDNS slave IP

    // Optional: Send NOTIFY to slave
    also-notify { 192.168.1.10; };
};
```

Reload BIND:
```bash
rndc reload
```

### Configure MyDNS Slave

#### Method 1: Using Stored Procedure (Easiest)

```sql
-- Add a new slave zone
CALL add_slave_zone(
    'example.com',              -- Zone name
    'master-ns.example.com',    -- Master server hostname
    53,                         -- Master server port
    'ns1.example.com',          -- This server's NS record
    'admin.example.com'         -- Admin email
);
```

#### Method 2: Manual SQL (More Control)

```sql
-- 1. Create zone in soa table
INSERT INTO soa (origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, slave_mode)
VALUES (
    'example.com.',              -- Zone name (must end with .)
    'ns1.example.com.',          -- NS server
    'admin.example.com.',        -- Admin email
    1,                           -- Serial (will be updated by transfer)
    3600,                        -- Refresh
    600,                         -- Retry
    86400,                       -- Expire
    3600,                        -- Minimum TTL
    3600,                        -- Default TTL
    'Y',                         -- Active
    TRUE                         -- Slave mode
);

-- 2. Get the zone ID
SET @zone_id = LAST_INSERT_ID();

-- 3. Configure master server
INSERT INTO zone_masters (zone_id, master_host, master_port, enabled, transfer_interval)
VALUES (
    @zone_id,                    -- Zone ID
    'master-ns.example.com',     -- Master hostname/IP
    53,                          -- Master port
    TRUE,                        -- Enabled
    300                          -- Check every 5 minutes
);
```

### Configure Multiple Masters (Redundancy)

```sql
-- Primary master
INSERT INTO zone_masters (zone_id, master_host, master_port, enabled)
VALUES (@zone_id, 'ns1-master.example.com', 53, TRUE);

-- Secondary master (fallback)
INSERT INTO zone_masters (zone_id, master_host, master_port, enabled)
VALUES (@zone_id, 'ns2-master.example.com', 53, TRUE);
```

mydns-xfer will try the first master, then fall back to the second if needed.

### Configure TSIG Authentication (Optional)

If your master requires TSIG authentication:

```sql
UPDATE zone_masters
SET
    tsig_key_name = 'transfer-key',
    tsig_key_secret = 'base64encodedkeyhere==',
    tsig_algorithm = 'hmac-sha256'
WHERE zone_id = @zone_id;
```

## Running Zone Transfers

### Manual Transfer (One-Time)

Transfer all configured zones:
```bash
mydns-xfer
```

Transfer specific zone:
```bash
mydns-xfer -z 123  # Where 123 is the zone_id
```

### Daemon Mode (Continuous)

Run mydns-xfer as a daemon that continuously monitors and transfers zones:

```bash
# Foreground (for testing)
mydns-xfer -d -f

# Background daemon
mydns-xfer -d
```

### Systemd Service (Recommended)

Create `/etc/systemd/system/mydns-xfer.service`:

```ini
[Unit]
Description=MyDNS Zone Transfer Daemon
Documentation=man:mydns-xfer(8)
After=network.target mysql.service
Wants=network-online.target

[Service]
Type=forking
User=mydns
Group=mydns
ExecStart=/usr/sbin/mydns-xfer -d
ExecReload=/bin/kill -HUP $MAINPID
PIDFile=/run/mydns/mydns-xfer.pid
Restart=on-failure
RestartSec=10

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
systemctl daemon-reload
systemctl enable mydns-xfer
systemctl start mydns-xfer
```

### Cron Job (Alternative)

Add to crontab for periodic transfers:

```cron
# Transfer zones every 5 minutes
*/5 * * * * /usr/sbin/mydns-xfer >> /var/log/mydns-xfer.log 2>&1
```

## Monitoring

### Check Zone Status

```sql
-- View all slave zones and their status
SELECT * FROM v_zone_transfer_status;

-- Output:
-- zone_id | zone_name     | master_host           | last_transfer       | health_status
-- 123     | example.com.  | ns1-master.example.com| 2025-11-26 10:30:00 | OK
-- 124     | test.com.     | ns1-master.example.com| NULL                | NEVER_TRANSFERRED
```

### View Transfer History

```sql
-- View recent transfers
SELECT * FROM v_recent_transfers LIMIT 20;

-- View transfers for specific zone
SELECT *
FROM zone_transfer_log
WHERE zone_id = 123
ORDER BY transfer_start DESC
LIMIT 10;

-- View failed transfers
SELECT
    s.origin,
    ztl.master_host,
    ztl.transfer_start,
    ztl.error_message
FROM zone_transfer_log ztl
JOIN soa s ON s.id = ztl.zone_id
WHERE ztl.status != 0
ORDER BY ztl.transfer_start DESC;
```

### Check Logs

```bash
# Systemd service logs
journalctl -u mydns-xfer -f

# Manual run logs
tail -f /var/log/mydns-xfer.log
```

## Troubleshooting

### Transfer Fails: "Connection refused"

**Problem:** Cannot connect to master server

**Solutions:**
```bash
# 1. Verify network connectivity
ping master-ns.example.com
telnet master-ns.example.com 53

# 2. Check master's allow-transfer configuration
# On BIND master:
named-checkconf
grep allow-transfer /etc/bind/named.conf.local

# 3. Check firewall
iptables -L | grep 53
```

### Transfer Fails: "Not authoritative"

**Problem:** Master refuses AXFR request

**Solutions:**
```sql
-- Verify master_host is correct
SELECT * FROM zone_masters WHERE zone_id = 123;

-- Update if needed
UPDATE zone_masters
SET master_host = 'correct-master-hostname.com'
WHERE zone_id = 123;
```

### Transfer Fails: "TSIG authentication failed"

**Problem:** TSIG key mismatch

**Solutions:**
```bash
# On master, check TSIG key configuration
# On BIND:
grep -A5 "key transfer-key" /etc/bind/named.conf

# Verify key in database matches
mysql -u root -p did -e "SELECT tsig_key_name, tsig_key_secret FROM zone_masters WHERE zone_id = 123"
```

### No Records After Transfer

**Problem:** Transfer succeeded but no records in database

**Solutions:**
```sql
-- Check if records were inserted
SELECT COUNT(*) FROM rr WHERE zone = 123;

-- Check transfer log for details
SELECT records_received, records_added, error_message
FROM zone_transfer_log
WHERE zone_id = 123
ORDER BY transfer_start DESC
LIMIT 1;

-- Verify zone is active
SELECT origin, active, slave_mode FROM soa WHERE id = 123;
```

### Transfer Too Slow

**Problem:** Large zones take too long to transfer

**Solutions:**
```sql
-- Increase transfer interval
UPDATE zone_masters
SET transfer_interval = 3600  -- 1 hour instead of 5 minutes
WHERE zone_id = 123;

-- Check network latency
-- Run on slave server:
ping -c 10 master-ns.example.com
```

## Advanced Configuration

### Transfer Scheduling

```sql
-- Different intervals for different zones
UPDATE zone_masters SET transfer_interval = 300 WHERE zone_id = 123;  -- 5 min
UPDATE zone_masters SET transfer_interval = 3600 WHERE zone_id = 124; -- 1 hour
UPDATE zone_masters SET transfer_interval = 86400 WHERE zone_id = 125;-- 24 hours
```

### Retry Configuration

```sql
-- Aggressive retry for critical zones
UPDATE zone_masters
SET
    retry_interval = 30,        -- Retry every 30 seconds
    max_failures = 20           -- Allow more failures
WHERE zone_id = 123;

-- Conservative retry for stable zones
UPDATE zone_masters
SET
    retry_interval = 300,       -- Retry every 5 minutes
    max_failures = 5            -- Disable after 5 failures
WHERE zone_id = 124;
```

### Disable Failing Zones

```sql
-- Automatically disabled after max_failures
SELECT * FROM v_zone_transfer_status WHERE health_status = 'FAILED';

-- Manually disable problematic zone
UPDATE zone_masters SET enabled = FALSE WHERE zone_id = 123;

-- Re-enable after fixing
UPDATE zone_masters
SET
    enabled = TRUE,
    transfer_failures = 0
WHERE zone_id = 123;
```

### Log Rotation

```sql
-- Delete old transfer logs (run monthly via cron)
DELETE FROM zone_transfer_log
WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);

-- Or keep only last 1000 per zone
DELETE ztl
FROM zone_transfer_log ztl
WHERE ztl.id NOT IN (
    SELECT id FROM (
        SELECT id
        FROM zone_transfer_log
        WHERE zone_id = ztl.zone_id
        ORDER BY transfer_start DESC
        LIMIT 1000
    ) AS keep
);
```

## Performance Tuning

### Database Optimization

```sql
-- Add indexes for better query performance
CREATE INDEX idx_ztl_zone_start ON zone_transfer_log(zone_id, transfer_start);
CREATE INDEX idx_zm_next_check ON zone_masters(last_check, enabled);

-- Optimize tables periodically
OPTIMIZE TABLE zone_masters;
OPTIMIZE TABLE zone_transfer_log;
```

### Network Optimization

```ini
# /etc/mydns.conf
# Increase TCP buffer sizes for large zone transfers
tcp-send-buffer = 262144
tcp-recv-buffer = 262144
```

### Concurrent Transfers

By default, mydns-xfer processes zones sequentially. For many zones, run multiple instances:

```bash
# Transfer zones 1-100
mydns-xfer -z 1-100 &

# Transfer zones 101-200
mydns-xfer -z 101-200 &
```

## Security Considerations

1. **TSIG Authentication:**
   - Always use TSIG for production
   - Rotate keys regularly
   - Use strong algorithms (hmac-sha256, hmac-sha512)

2. **Network Security:**
   - Restrict AXFR to specific IPs
   - Use VPN or private network
   - Monitor transfer logs for suspicious activity

3. **Database Security:**
   - Limit mydns-xfer user privileges
   - Encrypt MySQL connections
   - Regular backups before transfers

4. **Access Control:**
   ```sql
   -- Create limited user for mydns-xfer
   CREATE USER 'mydns_xfer'@'localhost' IDENTIFIED BY 'password';
   GRANT SELECT, INSERT, UPDATE, DELETE ON did.* TO 'mydns_xfer'@'localhost';
   ```

## Migration Guide

### Migrating from BIND to MyDNS

1. **Set up MyDNS as slave:**
   ```sql
   CALL add_slave_zone('example.com', 'bind-master', 53, 'ns-mydns', 'admin');
   ```

2. **Verify transfers working:**
   ```bash
   mydns-xfer -z <zone_id>
   dig @localhost example.com SOA
   ```

3. **Update NS records at registrar** to point to MyDNS

4. **Monitor for 24-48 hours**

5. **Decommission BIND master** (MyDNS now primary)

6. **Update zone to master mode:**
   ```sql
   UPDATE soa SET slave_mode = FALSE WHERE id = <zone_id>;
   UPDATE zone_masters SET enabled = FALSE WHERE zone_id = <zone_id>;
   ```

## Comparison: AXFR Slave vs MySQL Replication

| Feature | AXFR Slave | MySQL Replication |
|---------|------------|-------------------|
| **Setup Complexity** | Medium | Complex |
| **Master Type** | Any DNS server | MySQL only |
| **Update Latency** | 5-60 minutes | Real-time |
| **Bandwidth** | Higher (full zone) | Lower (incremental) |
| **Use Case** | Hybrid setups | Pure MyDNS deployments |
| **DNSSEC Support** | Yes | Yes |
| **Best For** | Migration, Secondary | Production clusters |

**Recommendation:** Use AXFR slave for hybrid/migration scenarios, MySQL replication for pure MyDNS deployments.

## Support

- **Documentation:** `/contrib/AXFR_SLAVE_GUIDE.md` (this file)
- **Schema:** `/contrib/axfr-slave-schema.sql`
- **Source Code:** `/src/lib/axfr.c`, `/src/lib/axfr.h`, `/src/mydns/xfer.c`
- **Issues:** GitHub Issues

## License

Same as MyDNS-NG parent project.
