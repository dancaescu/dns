# DNS Cache Configuration Hierarchy

MyDNS 1.3.0 implements a three-tier configuration hierarchy for DNS caching, providing maximum flexibility for different deployment scenarios.

## Configuration Priority (Highest to Lowest)

### 1. Database Configuration (Highest Priority)
**Use Case**: Master servers with MySQL, centralized management via web UI

**Table**: `dns_cache_config`
**Location**: MySQL database specified in mydns.conf

When a MySQL connection is available, MyDNS first attempts to load cache configuration from the database. This allows:
- Central management via web UI
- Runtime configuration changes
- Per-server settings in multi-master setups

**Example**:
```sql
SELECT * FROM dns_cache_config;
+----+---------+---------------+---------------+---------------+-----------------------------+
| id | enabled | cache_size_mb | cache_ttl_min | cache_ttl_max | upstream_servers            |
+----+---------+---------------+---------------+---------------+-----------------------------+
|  1 |       1 |           384 |           120 |          7200 | 1.1.1.1,1.0.0.1,9.9.9.9     |
+----+---------+---------------+---------------+---------------+-----------------------------+
```

**Log Output**:
```
Loaded cache configuration from database
DNS cache initialized: 384 MB, TTL range 120-7200 seconds, 3 upstream servers
```

### 2. Config File (Middle Priority)
**Use Case**: Slave servers without MySQL, file-based configuration

**File**: `/etc/mydns/mydns.conf`
**Location**: Specified by `--conf` flag or default `/etc/mydns/mydns.conf`

When database loading fails (no MySQL connection, table doesn't exist, or no rows), MyDNS falls back to mydns.conf settings.

**Example mydns.conf**:
```ini
# DNS Caching Configuration
dns-cache-enabled = 1
dns-cache-size = 512
dns-cache-ttl-min = 30
dns-cache-ttl-max = 43200
dns-cache-upstream = 8.8.8.8,1.1.1.1
```

**Log Output**:
```
Loaded cache configuration from config file
DNS cache initialized: 512 MB, TTL range 30-43200 seconds, 2 upstream servers
```

### 3. Hardcoded Defaults (Lowest Priority)
**Use Case**: Fallback when no configuration is provided

When both database and config file fail to provide cache settings, MyDNS uses safe, sensible defaults.

**Default Values**:
- **enabled**: 1 (true)
- **cache_size_mb**: 256
- **cache_ttl_min**: 60 seconds
- **cache_ttl_max**: 86400 seconds (24 hours)
- **upstream_servers**: 8.8.8.8, 8.8.4.4, 1.1.1.1, 1.0.0.1 (Google DNS + Cloudflare)

**Log Output**:
```
Using default cache configuration
No upstream servers configured, using Google DNS and Cloudflare
DNS cache initialized: 256 MB, TTL range 60-86400 seconds, 4 upstream servers
```

## Configuration Options Reference

### dns-cache-enabled
- **Type**: Boolean (1 or 0)
- **Default**: 1
- **Description**: Enable/disable DNS caching globally

### dns-cache-size
- **Type**: Integer (megabytes)
- **Default**: 256
- **Range**: 1-4096 recommended
- **Description**: Maximum memory for cache storage

### dns-cache-ttl-min
- **Type**: Integer (seconds)
- **Default**: 60
- **Range**: 1-86400
- **Description**: Minimum TTL for cached records (clamps lower values)

### dns-cache-ttl-max
- **Type**: Integer (seconds)
- **Default**: 86400 (24 hours)
- **Range**: 60-604800 (1 week)
- **Description**: Maximum TTL for cached records (clamps higher values)

### dns-cache-upstream
- **Type**: Comma-separated list
- **Default**: 8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1
- **Format**: IP[:PORT][,IP[:PORT]...]
- **Description**: Upstream DNS servers for recursive queries

**Examples**:
```
dns-cache-upstream = 8.8.8.8,1.1.1.1
dns-cache-upstream = 192.168.1.1:53,8.8.8.8:53
dns-cache-upstream = 2001:4860:4860::8888,8.8.8.8
```

## Deployment Scenarios

### Scenario 1: Master Server with MySQL
```
┌─────────────────┐
│ Database Config │  ← Loaded (Priority 1)
└─────────────────┘
┌─────────────────┐
│ mydns.conf      │  ← Ignored (Priority 2)
└─────────────────┘
┌─────────────────┐
│ Hardcoded       │  ← Not used (Priority 3)
└─────────────────┘

Result: Uses database configuration
```

**mydns.conf**:
```ini
db-host = localhost
database = did
# Cache config comes from database
```

### Scenario 2: Slave Server (AXFR) without MySQL
```
┌─────────────────┐
│ Database Config │  ← Not available (no MySQL)
└─────────────────┘
┌─────────────────┐
│ mydns.conf      │  ← Loaded (Priority 2)
└─────────────────┘
┌─────────────────┐
│ Hardcoded       │  ← Not used (Priority 3)
└─────────────────┘

Result: Uses mydns.conf configuration
```

**mydns.conf** (no db- lines):
```ini
# No MySQL connection - runs as AXFR slave
dns-cache-enabled = 1
dns-cache-size = 512
dns-cache-ttl-min = 120
dns-cache-ttl-max = 7200
dns-cache-upstream = 8.8.8.8,1.1.1.1
```

### Scenario 3: Minimal Configuration
```
┌─────────────────┐
│ Database Config │  ← Not available
└─────────────────┘
┌─────────────────┐
│ mydns.conf      │  ← No cache options
└─────────────────┘
┌─────────────────┐
│ Hardcoded       │  ← Loaded (Priority 3)
└─────────────────┘

Result: Uses hardcoded defaults (256MB, Google DNS + Cloudflare)
```

**mydns.conf** (minimal):
```ini
db-host = localhost
database = did
# No cache options - uses defaults
```

## Verifying Configuration

### Check Active Configuration
```bash
# View logs
journalctl -u mydns | grep -E "cache.*configuration|DNS cache initialized"

# Check runtime stats
systemctl status mydns | grep -A3 "DNS cache"
```

### Test Priority Override
```bash
# 1. Set database config
mysql -u root did -e "UPDATE dns_cache_config SET cache_size_mb = 384 WHERE id = 1;"

# 2. Set conflicting mydns.conf
echo "dns-cache-size = 512" >> /etc/mydns/mydns.conf

# 3. Restart
systemctl restart mydns

# 4. Verify database takes precedence
journalctl -u mydns --since "10 seconds ago" | grep "384 MB"
# Should show: "DNS cache initialized: 384 MB..." (from database)
```

## Troubleshooting

### Cache Not Initializing
**Symptom**: `DNS cache initialization failed - caching disabled`

**Causes**:
1. Memory allocation failure (system RAM exhausted)
2. Invalid configuration values
3. Upstream servers unreachable

**Debug**:
```bash
# Check memory
free -m

# Test database config
mysql -u root did -e "SELECT * FROM dns_cache_config;"

# Verify mydns.conf syntax
grep dns-cache /etc/mydns/mydns.conf
```

### Wrong Configuration Source
**Symptom**: Cache using unexpected values

**Check Priority**:
```bash
# View which source was used
journalctl -u mydns | grep -E "Loaded cache configuration|Using default"

# Database: "Loaded cache configuration from database"
# File:     "Loaded cache configuration from config file"
# Default:  "Using default cache configuration"
```

### Database Config Not Loading
**Symptom**: Uses file config despite database table existing

**Causes**:
1. Table is empty: `INSERT INTO dns_cache_config (...) VALUES (...);`
2. SQL connection fails: Check `db-host`, `database` in mydns.conf
3. Table doesn't exist: Run `/scripts/mydns-ng-master/contrib/dns-cache-schema.sql`

**Fix**:
```sql
-- Check if table exists
SHOW TABLES LIKE 'dns_cache_config';

-- Check if has rows
SELECT COUNT(*) FROM dns_cache_config;

-- Insert default row if empty
INSERT INTO dns_cache_config (enabled, cache_size_mb, upstream_servers)
VALUES (1, 256, '8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1');
```

## Best Practices

1. **Master Servers**: Use database configuration for central management
2. **Slave Servers**: Use mydns.conf for file-based configuration
3. **Development**: Use mydns.conf for quick iteration
4. **Production**: Use database with web UI for runtime changes
5. **Monitoring**: Always check logs after configuration changes

## See Also

- [DNS_CACHING_GUIDE.md](DNS_CACHING_GUIDE.md) - Detailed caching documentation
- [ACL_EXTENDED_GUIDE.md](ACL_EXTENDED_GUIDE.md) - Access control integration
- [INTEGRATION_SUMMARY.md](INTEGRATION_SUMMARY.md) - Complete feature overview
