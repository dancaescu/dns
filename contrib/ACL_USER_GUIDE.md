# MyDNS Enhanced ACL System - User Guide

**Last Updated:** 2025-11-26
**MyDNS Version:** 1.2.8.33+

## Overview

MyDNS now includes an enhanced Access Control List (ACL) system for DNS UPDATE operations that provides:

- **Granular Permissions**: Control add, delete, and update operations separately
- **IP-Based Access Control**: Allow/deny based on source IP or CIDR ranges
- **TSIG Authentication**: Optional cryptographic authentication for updates
- **Zone-Specific Rules**: Different ACLs for each zone
- **Complete Audit Trail**: Every update operation is logged to the database
- **Priority-Based Rules**: Multiple ACLs per zone with priority ordering

This replaces the older `soa.update_acl` column-based system with a much more flexible table-based approach.

---

## Quick Start

### 1. Enable the Enhanced ACL System

Edit `/etc/mydns/mydns.conf`:

```ini
# Enable DNS UPDATE
allow-update = yes

# Use new ACL table (recommended)
use-new-update-acl = yes

# Enable audit logging
audit-update-log = yes
```

Restart MyDNS:
```bash
systemctl restart mydns
```

### 2. Create Your First ACL

Allow updates from your local network:

```sql
mysql -u root did <<EOF
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('example.com.', '192.168.1.0/24,127.0.0.1', TRUE, TRUE, TRUE, TRUE);
EOF
```

### 3. Test the Update

```bash
nsupdate <<EOF
server 127.0.0.1
zone example.com.
update add test.example.com. 300 A 10.1.2.3
send
EOF
```

### 4. View the Audit Log

```sql
SELECT zone, source_ip, operation_type, success, created_at
FROM update_log
ORDER BY created_at DESC
LIMIT 10;
```

---

## Common Use Cases

### Use Case 1: Allow Updates from Specific IPs Only

**Scenario**: Allow only your admin workstations to update DNS records.

```sql
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('internal.company.com.', '10.1.1.50,10.1.1.51,10.1.1.52', TRUE, TRUE, TRUE, TRUE);
```

### Use Case 2: Allow Updates from a Network Range

**Scenario**: Allow any host in your operations subnet to update DNS.

```sql
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('ops.company.com.', '10.10.0.0/16', TRUE, TRUE, TRUE, TRUE);
```

### Use Case 3: Add-Only Access (DHCP Servers)

**Scenario**: Allow DHCP servers to add records but not delete or modify existing ones.

```sql
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('dhcp.company.com.', '10.1.5.10,10.1.5.11', TRUE, FALSE, FALSE, TRUE);
```

### Use Case 4: Multiple Networks

**Scenario**: Allow updates from multiple different network ranges.

```sql
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('multi.company.com.', '192.168.1.0/24,10.0.0.0/8,172.16.0.0/12', TRUE, TRUE, TRUE, TRUE);
```

### Use Case 5: TSIG Authentication Required

**Scenario**: Require cryptographic authentication for sensitive zones.

```sql
-- First, create a TSIG key (see TSIG documentation)
INSERT INTO tsig_keys (name, algorithm, secret, allow_update, enabled)
VALUES ('update-key.secure.com.', 'hmac-sha256',
        'xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==', TRUE, TRUE);

-- Then create ACL requiring this key
INSERT INTO update_acl (zone, key_name, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('secure.company.com.', 'update-key.secure.com.', '0.0.0.0/0', TRUE, TRUE, TRUE, TRUE);
```

Test with nsupdate:
```bash
# Create key file: /etc/mydns/update-key.conf
cat > /etc/mydns/update-key.conf <<EOF
key "update-key.secure.com." {
    algorithm hmac-sha256;
    secret "xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==";
};
EOF

# Use with nsupdate
nsupdate -k /etc/mydns/update-key.conf <<EOF
server 127.0.0.1
zone secure.company.com.
update add test.secure.company.com. 300 A 1.2.3.4
send
EOF
```

### Use Case 6: Any IP Allowed (Development Only)

**Scenario**: Allow updates from anywhere (not recommended for production).

```sql
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('dev.company.com.', NULL, TRUE, TRUE, TRUE, TRUE);
```

⚠️ **Warning**: NULL allowed_ips means any IP can update. Use only in development!

---

## Configuration Reference

### Configuration File Options

**File**: `/etc/mydns/mydns.conf`

```ini
# DNS UPDATE Settings
allow-update = yes                  # Enable DNS UPDATE protocol (required)
use-new-update-acl = yes           # Use update_acl table (default: yes)
audit-update-log = yes             # Log all operations (default: yes)

# TSIG Authentication (optional)
tsig-enforce-update = no           # Require TSIG for all updates (default: no)
```

### Database Schema

**Table**: `update_acl`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INT | Auto-increment primary key |
| `zone` | VARCHAR(255) | Zone name (e.g., `example.com.`) |
| `key_name` | VARCHAR(255) | TSIG key required (NULL = no TSIG) |
| `allowed_ips` | TEXT | Comma-separated IPs/CIDRs (NULL = any) |
| `allow_add` | BOOLEAN | Allow adding new records |
| `allow_delete` | BOOLEAN | Allow deleting records |
| `allow_update` | BOOLEAN | Allow modifying existing records |
| `enabled` | BOOLEAN | ACL active/inactive |
| `priority` | INT | Lower = higher priority (default: 100) |
| `description` | VARCHAR(255) | Optional notes |
| `created_at` | TIMESTAMP | When ACL was created |
| `updated_at` | TIMESTAMP | Last modification time |

**Table**: `update_log`

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Auto-increment primary key |
| `zone` | VARCHAR(255) | Zone being updated |
| `source_ip` | VARCHAR(45) | Client IP address |
| `key_name` | VARCHAR(255) | TSIG key used (NULL if none) |
| `operation_type` | ENUM | ADD, DELETE, UPDATE |
| `record_name` | VARCHAR(255) | Record being modified |
| `record_type` | VARCHAR(10) | DNS record type (A, AAAA, etc.) |
| `record_data` | TEXT | Record data |
| `success` | BOOLEAN | Operation succeeded/failed |
| `rcode` | INT | DNS response code |
| `new_serial` | INT | New SOA serial after update |
| `error_message` | VARCHAR(255) | Error details if failed |
| `created_at` | TIMESTAMP | When operation occurred |

---

## Managing ACLs

### View All Active ACLs

```sql
SELECT
    id,
    zone,
    key_name,
    allowed_ips,
    allow_add,
    allow_delete,
    allow_update,
    enabled
FROM update_acl
WHERE enabled = TRUE
ORDER BY zone, priority;
```

### Enable/Disable an ACL

```sql
-- Disable ACL temporarily
UPDATE update_acl SET enabled = FALSE WHERE zone = 'example.com.';

-- Re-enable ACL
UPDATE update_acl SET enabled = TRUE WHERE zone = 'example.com.';
```

### Modify ACL Permissions

```sql
-- Change to read-only (add only, no delete/update)
UPDATE update_acl
SET allow_add = TRUE, allow_delete = FALSE, allow_update = FALSE
WHERE zone = 'readonly.example.com.';

-- Allow everything
UPDATE update_acl
SET allow_add = TRUE, allow_delete = TRUE, allow_update = TRUE
WHERE zone = 'example.com.';
```

### Update Allowed IPs

```sql
-- Add more IPs
UPDATE update_acl
SET allowed_ips = '192.168.1.0/24,10.0.0.0/8,172.16.5.100'
WHERE zone = 'example.com.';

-- Allow from anywhere (dangerous!)
UPDATE update_acl
SET allowed_ips = NULL
WHERE zone = 'test.local.';
```

### Delete an ACL

```sql
DELETE FROM update_acl WHERE zone = 'old-zone.com.';
```

---

## Monitoring and Audit Logs

### View Recent Updates

```sql
SELECT
    zone,
    source_ip,
    operation_type,
    record_name,
    record_type,
    success,
    created_at
FROM update_log
ORDER BY created_at DESC
LIMIT 50;
```

### View Failed Update Attempts

```sql
SELECT
    zone,
    source_ip,
    operation_type,
    record_name,
    error_message,
    created_at
FROM update_log
WHERE success = FALSE
ORDER BY created_at DESC
LIMIT 20;
```

**Tip**: Failed attempts from unexpected IPs may indicate attack attempts!

### Update Statistics by Zone

```sql
SELECT
    zone,
    COUNT(*) AS total_updates,
    SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) AS successful,
    SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) AS failed,
    MAX(created_at) AS last_update
FROM update_log
GROUP BY zone
ORDER BY total_updates DESC;
```

### Find Most Active IPs

```sql
SELECT
    source_ip,
    COUNT(*) AS update_count,
    COUNT(DISTINCT zone) AS zones_updated,
    SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) AS failures
FROM update_log
WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY source_ip
ORDER BY update_count DESC
LIMIT 20;
```

### Updates by Date

```sql
SELECT
    DATE(created_at) AS date,
    COUNT(*) AS total_updates,
    SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) AS successful,
    SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) AS failed
FROM update_log
WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### Cleanup Old Logs

```sql
-- Delete logs older than 90 days
DELETE FROM update_log
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- Or archive to another table first
INSERT INTO update_log_archive SELECT * FROM update_log
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

DELETE FROM update_log
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
```

---

## Security Best Practices

### 1. **Use IP Restrictions**
Always restrict by IP or network when possible:
```sql
-- Good: Specific network
allowed_ips = '10.1.1.0/24'

-- Bad: Any IP allowed
allowed_ips = NULL
```

### 2. **Require TSIG for Public-Facing Servers**
If your DNS server is accessible from the internet:
```sql
-- Always require TSIG authentication
INSERT INTO update_acl (zone, key_name, allowed_ips, ...)
VALUES ('public.com.', 'update-key.public.com.', '0.0.0.0/0', ...);
```

### 3. **Use Least Privilege**
Only grant necessary permissions:
```sql
-- DHCP server: add only
allow_add = TRUE, allow_delete = FALSE, allow_update = FALSE

-- Monitoring system: update only
allow_add = FALSE, allow_delete = FALSE, allow_update = TRUE

-- Full control: admin workstations only
allow_add = TRUE, allow_delete = TRUE, allow_update = TRUE
```

### 4. **Monitor Failed Attempts**
Set up alerts for suspicious activity:
```sql
-- Check for brute force attempts
SELECT source_ip, COUNT(*) as failures
FROM update_log
WHERE success = FALSE
  AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY source_ip
HAVING failures > 10;
```

### 5. **Rotate TSIG Keys Regularly**
Update keys every 90-180 days:
```sql
-- Generate new key: openssl rand -base64 32
UPDATE tsig_keys
SET secret = 'NEW_SECRET_HERE', updated_at = NOW()
WHERE name = 'update-key.example.com.';
```

### 6. **Separate ACLs by Zone**
Don't use one ACL for all zones:
```sql
-- Good: Separate ACLs
INSERT INTO update_acl (zone, ...) VALUES ('zone1.com.', ...);
INSERT INTO update_acl (zone, ...) VALUES ('zone2.com.', ...);

-- Bad: Wildcard zones (not supported)
```

### 7. **Use Unique Keys per Client**
Each system should have its own TSIG key:
```sql
INSERT INTO tsig_keys (name, ...) VALUES ('dhcp-server-1.example.com.', ...);
INSERT INTO tsig_keys (name, ...) VALUES ('dhcp-server-2.example.com.', ...);
INSERT INTO tsig_keys (name, ...) VALUES ('admin-workstation.example.com.', ...);
```

This allows you to revoke access individually without affecting other systems.

---

## Troubleshooting

### Problem: "DNS UPDATE denied by ACL"

**Symptoms**: Updates fail with `REFUSED` response code.

**Diagnosis**:
```sql
-- Check if ACL exists
SELECT * FROM update_acl WHERE zone = 'example.com.' AND enabled = TRUE;

-- Check recent failures
SELECT zone, source_ip, error_message, created_at
FROM update_log
WHERE zone = 'example.com.' AND success = FALSE
ORDER BY created_at DESC LIMIT 5;
```

**Solutions**:
1. Verify ACL exists and is enabled
2. Check source IP is in `allowed_ips`
3. Verify CIDR notation is correct
4. Check firewall isn't masquerading IP

### Problem: "No ACL found for zone"

**Symptoms**: Logs show "No ACL found for zone" error.

**Solution**: Create an ACL for the zone:
```sql
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('example.com.', '127.0.0.1', TRUE, TRUE, TRUE, TRUE);
```

### Problem: Updates Not Logged

**Symptoms**: No entries appear in `update_log`.

**Diagnosis**:
```bash
# Check if audit logging is enabled
grep audit-update-log /etc/mydns/mydns.conf

# Check table exists
mysql -u root did -e "SHOW TABLES LIKE 'update_log'"
```

**Solutions**:
1. Enable audit logging: `audit-update-log = yes`
2. Restart mydns: `systemctl restart mydns`
3. Verify table exists (run `contrib/dnsupdate-schema.sql`)

### Problem: TSIG Authentication Fails

**Symptoms**: Updates with TSIG key fail with `NOTAUTH`.

**Diagnosis**:
```sql
-- Verify key exists
SELECT name, algorithm, enabled FROM tsig_keys
WHERE name = 'update-key.example.com.';

-- Check ACL references correct key
SELECT zone, key_name FROM update_acl
WHERE zone = 'example.com.';
```

**Solutions**:
1. Verify key name matches exactly (case-sensitive)
2. Verify key secret is correct (base64-encoded)
3. Verify algorithm matches (hmac-sha256, hmac-sha512, etc.)
4. Check key is enabled: `enabled = TRUE`

### Problem: Old ACL System Still Active

**Symptoms**: `soa.update_acl` column is being used instead of `update_acl` table.

**Solution**:
```bash
# Enable new ACL system
echo "use-new-update-acl = yes" >> /etc/mydns/mydns.conf
systemctl restart mydns
```

### Problem: ACL Works but Wrong Permissions

**Symptoms**: Can add but not delete, or vice versa.

**Solution**: Check and update permissions:
```sql
-- View current permissions
SELECT zone, allow_add, allow_delete, allow_update
FROM update_acl
WHERE zone = 'example.com.';

-- Fix permissions
UPDATE update_acl
SET allow_add = TRUE, allow_delete = TRUE, allow_update = TRUE
WHERE zone = 'example.com.';
```

---

## Testing and Validation

### Test Basic Update (No TSIG)

```bash
nsupdate <<EOF
server 127.0.0.1
zone test.local.
update add test-$(date +%s).test.local. 300 A 1.2.3.4
send
EOF
```

### Test Update with TSIG

```bash
# Create key file
cat > /tmp/test-key.conf <<EOF
key "test-key.example.com." {
    algorithm hmac-sha256;
    secret "YOUR_SECRET_HERE";
};
EOF

# Test update
nsupdate -k /tmp/test-key.conf <<EOF
server 127.0.0.1
zone test.local.
update add secure-$(date +%s).test.local. 300 A 1.2.3.4
send
EOF

# Clean up
rm /tmp/test-key.conf
```

### Verify Update in Database

```sql
-- Check record was added
SELECT name, type, data FROM rr
WHERE name LIKE 'test-%'
ORDER BY id DESC LIMIT 5;

-- Check audit log
SELECT zone, operation_type, record_name, success, created_at
FROM update_log
ORDER BY created_at DESC LIMIT 5;
```

### Test ACL Denial

```bash
# Create ACL that denies your IP
mysql -u root did <<EOF
UPDATE update_acl SET allowed_ips = '1.2.3.4' WHERE zone = 'test.local.';
EOF

# Try update (should fail)
nsupdate <<EOF
server 127.0.0.1
zone test.local.
update add denied.test.local. 300 A 1.2.3.4
send
EOF
# Expected: update failed: REFUSED

# Restore access
mysql -u root did <<EOF
UPDATE update_acl SET allowed_ips = '127.0.0.1' WHERE zone = 'test.local.';
EOF
```

---

## Migration from Old ACL System

If you're currently using the `soa.update_acl` column:

### Step 1: Export Existing ACLs

```sql
SELECT origin, update_acl FROM soa
WHERE update_acl IS NOT NULL AND update_acl != '';
```

### Step 2: Create New ACL Entries

```sql
-- For each zone with update_acl
INSERT INTO update_acl (zone, allowed_ips, allow_add, allow_delete, allow_update, enabled)
SELECT
    origin,
    update_acl,
    TRUE,
    TRUE,
    TRUE,
    TRUE
FROM soa
WHERE update_acl IS NOT NULL AND update_acl != '';
```

### Step 3: Enable New System

```bash
# Edit config
sed -i 's/use-new-update-acl = no/use-new-update-acl = yes/' /etc/mydns/mydns.conf

# Or add if not present
echo "use-new-update-acl = yes" >> /etc/mydns/mydns.conf

# Restart
systemctl restart mydns
```

### Step 4: Test

Test updates for each migrated zone to ensure ACLs work correctly.

### Step 5: Clean Up (Optional)

Once confirmed working, you can clear old ACL data:
```sql
UPDATE soa SET update_acl = NULL;
```

**Note**: The old system remains as a fallback if `use-new-update-acl = no`.

---

## Related Documentation

- **Database Schema**: `contrib/dnsupdate-schema.sql` - Complete schema with SQL examples
- **TSIG Authentication**: `contrib/tsig-schema.sql` - TSIG key management
- **Implementation Details**: `contrib/INTEGRATION_COMPLETE_2025-11-26.md` - Technical internals
- **RFC 2136**: DNS UPDATE protocol specification
- **RFC 2845**: TSIG authentication specification

---

## Support and Feedback

For issues, questions, or feature requests:
- Check MyDNS logs: `journalctl -u mydns -f`
- Review audit logs: `SELECT * FROM update_log WHERE success = FALSE`
- File issues on GitHub or contact maintainer

---

**End of ACL User Guide**
