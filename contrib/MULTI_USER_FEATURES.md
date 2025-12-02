# Multi-User Cloudflare and Zone ACL Features

**Version:** 1.0
**Date:** November 2025
**Author:** Dan Caescu <dan.caescu@multitel.net>

## Overview

This document describes the multi-user Cloudflare credentials and zone ACL features added to MyDNS and the DNS Manager web UI.

## Features

### 1. User Cloudflare Credentials Management

Users can now add their own Cloudflare API credentials through the web UI, allowing them to sync their own zones independently of the global administrator credentials.

**Key capabilities:**
- Multiple users can each have their own Cloudflare accounts
- Each user can have multiple Cloudflare credential sets
- API keys are encrypted at rest using AES-256-GCM
- Auto-sync can be enabled per credential
- Manual sync trigger available
- Credential testing/validation
- Sync status tracking

### 2. Zone ACLs (Access Control Lists)

Users can define IP-based access control rules for their DNS zones, providing firewall-like functionality at the DNS level.

**Two ACL types:**
- **Zone-specific ACLs**: Apply to individual zones
- **Global ACLs**: Apply to all zones for a user/account

**ACL features:**
- Allow/Deny rules
- IPv4 and IPv6 support
- CIDR notation support
- Apply to specific operations (query, AXFR, NOTIFY, update, DoH)
- Priority-based evaluation
- Statistics tracking

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Web UI (React + Node.js)                  │
│  ┌──────────────────────┐      ┌─────────────────────────────┐ │
│  │ CF Credentials Page  │      │    Zone ACL Management      │ │
│  │ - Add/Edit/Delete    │      │    - Create/Edit Rules      │ │
│  │ - Test Connection    │      │    - View Statistics        │ │
│  │ - Trigger Sync       │      │    - Enable/Disable         │ │
│  └──────────────────────┘      └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                           ↓                    ↓
┌─────────────────────────────────────────────────────────────────┐
│                        API Routes (Express)                      │
│  /api/user-cloudflare/*        /api/zone-acls/*                 │
└─────────────────────────────────────────────────────────────────┘
                           ↓                    ↓
┌─────────────────────────────────────────────────────────────────┐
│                      MySQL Database                              │
│  dnsmanager_cloudflare_credentials    dnsmanager_zone_acls     │
│  dnsmanager_global_acls                dnsmanager_zone_acl_stats│
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│            Python Sync Script (Cron Job)                        │
│  sync_cloudflare_records_multi_user.py                          │
│  - Reads global config (/etc/mydns/cloudflare.ini)             │
│  - Reads user credentials from database                         │
│  - Syncs all enabled accounts                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Database Schema

### dnsmanager_cloudflare_credentials

Stores user Cloudflare API credentials (encrypted).

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| user_id | INT | Owner user ID |
| account_id | INT | Account ID for multi-tenancy |
| cf_email | VARCHAR(255) | Cloudflare email |
| cf_api_key | VARCHAR(255) | Encrypted API key |
| cf_account_id | VARCHAR(64) | Cloudflare account ID |
| cf_domain | VARCHAR(255) | Optional: specific domain to sync |
| cf_api_url | VARCHAR(255) | API endpoint (default: CF v4 API) |
| enabled | TINYINT(1) | Enable/disable credential |
| auto_sync | TINYINT(1) | Auto-sync via cron |
| sync_frequency | INT | Seconds between syncs |
| last_sync_at | TIMESTAMP | Last sync timestamp |
| last_sync_status | VARCHAR(50) | 'success', 'failed', 'partial' |
| last_sync_error | TEXT | Error message if failed |
| created_at | TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | Last update timestamp |

### dnsmanager_zone_acls

Zone-specific access control rules.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| soa_id | INT | Zone (SOA) ID |
| user_id | INT | Owner user ID |
| account_id | INT | Account ID |
| rule_name | VARCHAR(255) | Descriptive name |
| rule_type | ENUM | 'allow' or 'deny' |
| ip_address | VARCHAR(45) | IP address (v4 or v6) |
| cidr_mask | INT | CIDR mask (0-32 for v4, 0-128 for v6) |
| applies_to_query | TINYINT(1) | Apply to DNS queries |
| applies_to_axfr | TINYINT(1) | Apply to zone transfers |
| applies_to_notify | TINYINT(1) | Apply to NOTIFY |
| applies_to_update | TINYINT(1) | Apply to dynamic updates |
| applies_to_doh | TINYINT(1) | Apply to DoH |
| priority | INT | Rule priority (lower = higher priority) |
| enabled | TINYINT(1) | Enable/disable rule |
| description | TEXT | Optional description |
| created_at | TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | Last update timestamp |

### dnsmanager_global_acls

Account/user-wide access control rules (apply to all zones).

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| user_id | INT | Owner user ID (NULL = all users) |
| account_id | INT | Account ID |
| rule_name | VARCHAR(255) | Descriptive name |
| rule_type | ENUM | 'allow' or 'deny' |
| ip_address | VARCHAR(45) | IP address (v4 or v6) |
| cidr_mask | INT | CIDR mask |
| applies_to_* | TINYINT(1) | Operation flags |
| priority | INT | Rule priority |
| enabled | TINYINT(1) | Enable/disable rule |
| description | TEXT | Optional description |
| created_at | TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | Last update timestamp |

### dnsmanager_zone_acl_stats

Tracks ACL rule hits for monitoring and analytics.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGINT | Primary key |
| acl_id | INT | ACL rule ID |
| source_ip | VARCHAR(45) | Source IP address |
| request_type | ENUM | 'query', 'axfr', 'notify', 'update', 'doh' |
| action_taken | ENUM | 'allowed' or 'denied' |
| timestamp | TIMESTAMP | Request timestamp |

## API Endpoints

### User Cloudflare Credentials

#### `GET /api/user-cloudflare/credentials`
List all credentials for authenticated user.

**Response:**
```json
[
  {
    "id": 1,
    "user_id": 1,
    "account_id": 1,
    "cf_email": "user@example.com",
    "cf_account_id": "abc123...",
    "cf_domain": null,
    "enabled": true,
    "auto_sync": true,
    "sync_frequency": 300,
    "last_sync_at": "2025-11-28 12:00:00",
    "last_sync_status": "success"
  }
]
```

#### `POST /api/user-cloudflare/credentials`
Add new Cloudflare credentials.

**Request:**
```json
{
  "account_id": 1,
  "cf_email": "user@example.com",
  "cf_api_key": "your_api_key_here",
  "cf_account_id": "cloudflare_account_id",
  "cf_domain": "example.com",  // Optional
  "enabled": true,
  "auto_sync": true,
  "sync_frequency": 300
}
```

**Response:**
```json
{
  "message": "Cloudflare credentials added successfully",
  "id": 1
}
```

#### `PUT /api/user-cloudflare/credentials/:id`
Update credentials.

**Request:**
```json
{
  "cf_email": "newemail@example.com",
  "enabled": false
}
```

#### `DELETE /api/user-cloudflare/credentials/:id`
Delete credentials.

#### `POST /api/user-cloudflare/credentials/:id/test`
Test credentials by verifying with Cloudflare API.

**Response:**
```json
{
  "success": true,
  "message": "Cloudflare credentials are valid",
  "data": {
    "id": "token_id",
    "status": "active"
  }
}
```

#### `POST /api/user-cloudflare/credentials/:id/sync`
Manually trigger sync for specific credentials.

### Zone ACLs

#### `GET /api/zone-acls`
Get all ACLs (zone-specific and global) for user.

**Response:**
```json
{
  "zoneAcls": [ /* zone-specific rules */ ],
  "globalAcls": [ /* global rules */ ]
}
```

#### `GET /api/zone-acls/zone/:soaId`
Get all ACLs for a specific zone.

#### `POST /api/zone-acls/zone`
Create zone-specific ACL.

**Request:**
```json
{
  "soa_id": 1,
  "account_id": 1,
  "rule_name": "Allow office network",
  "rule_type": "allow",
  "ip_address": "192.168.1.0",
  "cidr_mask": 24,
  "applies_to_query": true,
  "applies_to_doh": true,
  "priority": 100,
  "enabled": true,
  "description": "Allow queries from office"
}
```

#### `POST /api/zone-acls/global`
Create global ACL (applies to all zones).

**Request:**
```json
{
  "account_id": 1,
  "rule_name": "Deny abusers",
  "rule_type": "deny",
  "ip_address": "10.0.0.0",
  "cidr_mask": 8,
  "applies_to_query": true,
  "priority": 50,
  "enabled": true,
  "applies_to_all_users": false
}
```

#### `PUT /api/zone-acls/zone/:id`
Update zone-specific ACL.

#### `PUT /api/zone-acls/global/:id`
Update global ACL.

#### `DELETE /api/zone-acls/zone/:id`
Delete zone-specific ACL.

#### `DELETE /api/zone-acls/global/:id`
Delete global ACL.

#### `GET /api/zone-acls/stats`
Get ACL hit statistics.

**Response:**
```json
[
  {
    "acl_id": 1,
    "rule_name": "Allow office",
    "rule_type": "allow",
    "total_hits": 1000,
    "allowed_count": 1000,
    "denied_count": 0,
    "last_hit": "2025-11-28 12:00:00"
  }
]
```

## Security

### API Key Encryption

API keys are encrypted using AES-256-GCM before being stored in the database.

**Encryption format:**
```
iv:authTag:encrypted (all hex-encoded)
```

**Environment variable:**
```bash
export CF_ENCRYPTION_KEY="your-32-char-encryption-key-here"
```

**Important:** The encryption key must be **exactly 32 characters** and should be:
- Stored securely (environment variable, not in code)
- Same on all servers that access the database
- Never committed to version control

### ACL Security Model

1. **Priority-based evaluation**: Lower priority number = checked first
2. **First match wins**: First matching rule determines action
3. **Default policy**: If no rules match, default is ALLOW
4. **Zone ACLs checked before global ACLs**
5. **Deny rules should have lower priority than allow rules** (checked first)

**Example priority scheme:**
- 10-50: Deny rules (blacklist)
- 51-100: Allow rules (whitelist)
- 101+: Low-priority rules

## Installation

### 1. Apply Database Schema

```bash
cd /scripts/mydns-ng-master/contrib
mysql -u root -p your_database < user-cloudflare-acl-schema.sql
```

### 2. Configure Backend

The routes are already integrated in the web UI backend. No additional configuration needed.

### 3. Set Encryption Key

```bash
# Add to /etc/environment or systemd service file
export CF_ENCRYPTION_KEY="change_this_to_a_secure_32char_key"
```

### 4. Setup Cloudflare Sync

#### Option A: Cron Job (Recommended)

```bash
# Install multi-user sync script
cp sync_cloudflare_records_multi_user.py /usr/local/bin/
chmod +x /usr/local/bin/sync_cloudflare_records_multi_user.py

# Add cron job (every 5 minutes)
echo "*/5 * * * * /usr/local/bin/sync_cloudflare_records_multi_user.py >> /var/log/cf-sync.log 2>&1" | crontab -
```

#### Option B: Systemd Timer

```bash
# Create service file
cat > /etc/systemd/system/cloudflare-sync.service <<EOF
[Unit]
Description=Cloudflare Zone Sync
After=network.target mysql.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/sync_cloudflare_records_multi_user.py
StandardOutput=journal
StandardError=journal
EOF

# Create timer file
cat > /etc/systemd/system/cloudflare-sync.timer <<EOF
[Unit]
Description=Cloudflare Zone Sync Timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF

# Enable and start
systemctl daemon-reload
systemctl enable --now cloudflare-sync.timer
```

#### Option C: Ansible (Automated)

```bash
cd /scripts/mydns-ng-master/contrib
python3 generate_ansible.py
cd ansible
ansible-playbook -i inventory cloudflare-sync.yml
```

### 5. Rebuild Web UI Backend

```bash
cd /scripts/mydns-ng-master/contrib/dnsmanager/server
npm install
npm run build
pm2 restart dnsmanager-api
```

## Usage Examples

### Add Cloudflare Credentials via API

```bash
curl -X POST https://dns.example.com/api/user-cloudflare/credentials \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "account_id": 1,
    "cf_email": "me@example.com",
    "cf_api_key": "my_cloudflare_api_key",
    "cf_account_id": "my_cf_account_id",
    "enabled": true,
    "auto_sync": true
  }'
```

### Test Credentials

```bash
curl -X POST https://dns.example.com/api/user-cloudflare/credentials/1/test \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Add Zone ACL

```bash
curl -X POST https://dns.example.com/api/zone-acls/zone \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "soa_id": 1,
    "account_id": 1,
    "rule_name": "Allow office network",
    "rule_type": "allow",
    "ip_address": "192.168.1.0",
    "cidr_mask": 24,
    "applies_to_query": true,
    "priority": 100,
    "enabled": true
  }'
```

### Manual Sync

```bash
# Sync all enabled credentials
/usr/local/bin/sync_cloudflare_records_multi_user.py --verbose

# Skip global config, only sync user credentials
/usr/local/bin/sync_cloudflare_records_multi_user.py --skip-global

# Skip user credentials, only sync global config
/usr/local/bin/sync_cloudflare_records_multi_user.py --skip-users
```

### Check Sync Logs

```bash
# Via journald
journalctl -u cloudflare-sync -f

# Via log file
tail -f /var/log/cf-sync.log

# Check sync status in database
mysql -u root -p -e "SELECT id, cf_email, last_sync_at, last_sync_status FROM dnsmanager_cloudflare_credentials WHERE enabled=1"
```

## Troubleshooting

### Sync Script Errors

**Problem:** "Failed to decrypt API key"

**Solution:** Ensure CF_ENCRYPTION_KEY environment variable is set and matches the key used during encryption.

```bash
# Check environment
echo $CF_ENCRYPTION_KEY

# Set for cron job
echo "CF_ENCRYPTION_KEY=your_key_here" >> /etc/environment
```

**Problem:** "Cloudflare API error 401"

**Solution:** Invalid API credentials. Test credentials via API:

```bash
curl -X POST https://dns.example.com/api/user-cloudflare/credentials/1/test
```

### ACL Not Working

**Problem:** Queries not being blocked

**Solution:**
1. Check ACL is enabled: `SELECT * FROM dnsmanager_zone_acls WHERE id=X`
2. Check priority order (lower priority = checked first)
3. Verify IP address format (use CIDR notation)
4. Check applies_to_query flag is 1
5. Restart MyDNS: `systemctl restart mydns`

### Encryption Issues

**Problem:** Can't decrypt existing keys after server change

**Solution:** Encryption key must be the same on all servers. Export and import:

```bash
# Export from old server
echo $CF_ENCRYPTION_KEY > /tmp/cf-key.txt

# Import on new server
export CF_ENCRYPTION_KEY=$(cat /tmp/cf-key.txt)
echo "CF_ENCRYPTION_KEY=$(cat /tmp/cf-key.txt)" >> /etc/environment
```

## Performance Considerations

### Sync Frequency

Default sync frequency is 5 minutes. Adjust based on your needs:

- **High-frequency (1-2 min)**: Real-time changes, higher load
- **Normal (5 min)**: Good balance (recommended)
- **Low-frequency (15-30 min)**: Lower load, delayed updates

### Database Indexes

The schema includes indexes on frequently queried columns:

```sql
-- Credentials
INDEX idx_user_id, idx_enabled, idx_auto_sync

-- ACLs
INDEX idx_soa_id, idx_enabled, idx_priority, idx_ip_address

-- Stats
INDEX idx_acl_id, idx_timestamp, idx_source_ip
```

### ACL Stats Table Growth

The `dnsmanager_zone_acl_stats` table can grow large. Consider:

1. **Partitioning by date**:
```sql
ALTER TABLE dnsmanager_zone_acl_stats
PARTITION BY RANGE (YEAR(timestamp)) (
  PARTITION p2025 VALUES LESS THAN (2026),
  PARTITION p2026 VALUES LESS THAN (2027),
  PARTITION p_future VALUES LESS THAN MAXVALUE
);
```

2. **Regular cleanup**:
```bash
# Delete stats older than 90 days
mysql -u root -p -e "DELETE FROM dnsmanager_zone_acl_stats WHERE timestamp < DATE_SUB(NOW(), INTERVAL 90 DAY)"
```

3. **Archive old data**:
```bash
# Archive to separate table
mysql -u root -p -e "INSERT INTO dnsmanager_zone_acl_stats_archive SELECT * FROM dnsmanager_zone_acl_stats WHERE timestamp < DATE_SUB(NOW(), INTERVAL 90 DAY)"
```

## Future Enhancements

Potential improvements for future versions:

1. **Rate Limiting**: Per-IP request rate limits
2. **Geographic ACLs**: Allow/deny by country code
3. **Time-based ACLs**: Apply rules only during specific hours
4. **Conditional ACLs**: Rules based on query type, domain, etc.
5. **ACL Templates**: Pre-defined rule sets for common scenarios
6. **Bulk Import/Export**: CSV/JSON import of ACL rules
7. **Audit Logging**: Detailed logs of ACL changes
8. **Notification System**: Email/webhook on sync failures or ACL triggers

## Support

For issues, questions, or feature requests:

- GitHub Issues: https://github.com/yourusername/mydns-ng/issues
- Documentation: https://docs.mydns.example.com
- Email: support@example.com

## License

GPLv2 - See LICENSE file

---

**Generated:** November 2025
**Author:** Dan Caescu <dan.caescu@multitel.net>
