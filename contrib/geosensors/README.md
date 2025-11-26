# Geographic Multi-Provider DNS System

Enable MyDNS to work alongside Cloudflare as a Multi-Provider DNS, serving the same geo-aware proxy IPs that Cloudflare returns, with comprehensive access control.

## Quick Start

### 1. Install Database Schema

```bash
mysql -u root did < schema.sql
```

### 2. Deploy Sensor

```bash
# Install dependencies
pip3 install -r requirements.txt

# Run sensor (one location)
./sensor.py --location na

# Or run as daemon
./sensor.py --location na --daemon --interval 3600
```

### 3. Verify

```sql
-- Check learned IPs
SELECT s.location_name, COUNT(*) as records
FROM cloudflare_proxy_ips p
JOIN geo_sensors s ON p.sensor_id = s.id
GROUP BY s.id;
```

## What This Does

**Problem:** When using MyDNS alongside Cloudflare (Multi-Provider DNS), users get different IPs:
- Cloudflare DNS: Returns Cloudflare proxy IPs (geo-optimized)
- MyDNS: Returns origin server IPs

**Solution:** Sensors learn Cloudflare's IPs from different geographic locations, allowing MyDNS to return the same geo-aware IPs as Cloudflare.

## Components

### 1. Geographic Sensors (`sensor.py`)
- Deployed in multiple locations (EU, NA, APAC, SA, AF, OC)
- Resolves Cloudflare proxied records
- Stores learned IPs per location in database
- Runs continuously (hourly sync)

### 2. Database Schema (`schema.sql`)
- `geo_sensors` - Sensor locations
- `cloudflare_proxy_ips` - Learned IPs per sensor
- `geo_country_mapping` - Country → Sensor mapping
- `access_control_rules` - Whitelist/blacklist rules
- `access_control_log` - Access attempt logs

### 3. MyDNS GeoIP Integration
- Uses MaxMind GeoIP to identify requester location
- Returns appropriate IPs based on location
- Implements access control (whitelist/blacklist)

### 4. Web UI
- Toggle proxy mode per zone
- Manage sensors
- Configure access control rules

## Architecture

```
User in France queries www.example.com
         ↓
MyDNS receives query
         ↓
GeoIP lookup: France → EU sensor
         ↓
Access control check (whitelist/blacklist)
         ↓
Zone has use_proxy_ips=TRUE?
   YES: Return EU sensor's learned Cloudflare IPs
   NO: Return origin IPs
         ↓
User gets same IPs as Cloudflare would serve
```

## Configuration

### Sensor Locations

Default sensors in database:
- `na` - North America (default)
- `eu` - Europe
- `apac` - Asia Pacific
- `sa` - South America
- `af` - Africa
- `oc` - Oceania

### Deploy Multiple Sensors

Deploy one sensor instance per geographic region:

```bash
# Europe sensor
./sensor.py --location eu --daemon

# North America sensor
./sensor.py --location na --daemon

# Asia Pacific sensor
./sensor.py --location apac --daemon
```

### Systemd Service

```bash
# Create service file
cat > /etc/systemd/system/geosensor-eu.service <<EOF
[Unit]
Description=Geographic DNS Sensor (EU)
After=network.target mysql.service

[Service]
Type=simple
WorkingDirectory=/scripts/mydns-ng-master/contrib/geosensors
ExecStart=/usr/bin/python3 sensor.py --location eu --daemon --interval 3600
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable geosensor-eu
systemctl start geosensor-eu
```

## Access Control

### Rule Types

**Whitelist:** Only allow specified IPs/countries/ASNs
**Blacklist:** Block specified IPs/countries/ASNs

### Applies To

- `dns` - DNS queries only
- `webui` - Web UI access only
- `both` - Both DNS and web UI

### Match Criteria

- IP address (exact match)
- IP network (CIDR notation)
- ASN (Autonomous System Number)
- Country code (ISO 3166-1 alpha-2)
- Continent

### Examples

```sql
-- Block China from DNS
INSERT INTO access_control_rules (rule_name, rule_type, applies_to, country_code, reason)
VALUES ('Block China DNS', 'blacklist', 'dns', 'CN', 'Policy');

-- Allow only US for web UI
INSERT INTO access_control_rules (rule_name, rule_type, applies_to, country_code, reason)
VALUES ('US Only WebUI', 'whitelist', 'webui', 'US', 'Security');

-- Block specific IP
INSERT INTO access_control_rules (rule_name, rule_type, applies_to, ip_address, reason)
VALUES ('Block Attacker', 'blacklist', 'both', '203.0.113.50', 'Abuse');

-- Block network
INSERT INTO access_control_rules (rule_name, rule_type, applies_to, ip_network, reason)
VALUES ('Block Subnet', 'blacklist', 'both', '192.0.2.0/24', 'Spam');
```

## Web UI Integration

### Zone Page

Add proxy mode toggle:

```
┌─────────────────────────────────────┐
│ Zone: example.com                   │
├─────────────────────────────────────┤
│ Serve Cloudflare Proxy IPs: [x] ON │
│                                     │
│ When enabled, MyDNS returns the    │
│ same IPs as Cloudflare based on    │
│ the requester's geographic location│
└─────────────────────────────────────┘
```

### Sensors Page

```
┌─────────────────────────────────────┐
│ Geographic Sensors                  │
├─────────────────────────────────────┤
│ ✓ North America (na) - Online       │
│   Records: 1,234 | Default          │
│                                     │
│ ✓ Europe (eu) - Online              │
│   Records: 1,189                    │
│                                     │
│ ⚠ Asia Pacific (apac) - Offline    │
│   Last sync: 2 hours ago            │
└─────────────────────────────────────┘
```

### Access Control Page

```
┌─────────────────────────────────────┐
│ Access Control Rules                │
├─────────────────────────────────────┤
│ [Add Rule]                          │
│                                     │
│ Rule Name         | Type  | Active  │
│────────────────── | ───── | ─────   │
│ Block China DNS   | Block | [x]     │
│ US Only WebUI     | Allow | [x]     │
│ Block Attacker IP | Block | [ ]     │
└─────────────────────────────────────┘
```

## MyDNS Integration

**⚠️ Requires C code modifications - see IMPLEMENTATION-GUIDE.md**

Key changes needed:
1. Add GeoIP library integration
2. Implement geo-aware record lookup
3. Add access control checks
4. Parse learned IPs from JSON

**Dependencies:**
```bash
apt-get install libgeoip-dev geoip-database
```

## Monitoring

### Sensor Health

```sql
SELECT * FROM geo_sensor_health;
```

### Learned IPs Summary

```sql
SELECT
    s.location_name,
    COUNT(*) as records,
    MAX(p.last_resolved) as last_update
FROM cloudflare_proxy_ips p
JOIN geo_sensors s ON p.sensor_id = s.id
GROUP BY s.id;
```

### Access Control Activity

```sql
SELECT
    rule_name,
    hit_count,
    last_hit
FROM access_control_rules
WHERE hit_count > 0
ORDER BY hit_count DESC;
```

### Recent Blocks

```sql
SELECT * FROM access_control_log
WHERE action = 'blocked'
ORDER BY date_created DESC
LIMIT 20;
```

## Files

```
geosensors/
├── schema.sql                  # Database schema
├── sensor.py                   # Sensor script
├── requirements.txt            # Python dependencies
├── README.md                   # This file
└── IMPLEMENTATION-GUIDE.md     # Detailed implementation guide
```

## Workflow

### Initial Setup

1. Apply database schema
2. Deploy sensors in multiple locations
3. Let sensors sync for 24 hours
4. Verify learned IPs in database
5. Update MyDNS with GeoIP support
6. Enable proxy mode for zones
7. Test DNS queries from different locations

### Ongoing Operations

1. Sensors sync hourly automatically
2. Monitor sensor health daily
3. Review access control logs weekly
4. Update GeoIP database monthly
5. Add new zones to proxy mode as needed

## Testing

### Test Sensor

```bash
# Run manual sync
./sensor.py --location na

# Check results
mysql -u root did -e "
SELECT record_name, learned_ips
FROM cloudflare_proxy_ips
WHERE sensor_id = (SELECT id FROM geo_sensors WHERE location_code='na')
LIMIT 5;
"
```

### Test GeoIP (after MyDNS integration)

```bash
# From different locations
dig @your-mydns-server www.example.com A

# Should return different IPs based on location
```

### Test Access Control

```sql
-- Add test rule
INSERT INTO access_control_rules (rule_name, rule_type, applies_to, ip_address)
VALUES ('Test Block', 'blacklist', 'dns', '1.2.3.4');

-- Try DNS query from that IP
-- Check logs
SELECT * FROM access_control_log WHERE source_ip = '1.2.3.4';
```

## Troubleshooting

**Sensor not syncing:**
```bash
# Check logs
journalctl -u geosensor-* -f

# Test database connection
mysql -u root did -e "SELECT 1"

# Test DNS resolution
dig @1.1.1.1 www.cloudflare.com
```

**No learned IPs:**
```bash
# Check if records are proxied
mysql -u root did -e "
SELECT COUNT(*) FROM cloudflare_records WHERE proxied=TRUE;
"

# Check sensor health
mysql -u root did -e "SELECT * FROM geo_sensor_health;"
```

**Access control not working:**
```bash
# Check GeoIP database
ls -l /usr/share/GeoIP/GeoIP.dat

# Test GeoIP lookup
geoiplookup 8.8.8.8

# Check rules
mysql -u root did -e "SELECT * FROM access_control_rules WHERE is_active=TRUE;"
```

## Performance

- **Sensor sync:** ~1-5 minutes per 1000 records
- **Database growth:** ~10 KB per proxied record per sensor
- **MyDNS overhead:** <1ms GeoIP lookup per query
- **Recommended sync interval:** 3600s (1 hour)

## Security

- Sensors run on trusted infrastructure only
- Database credentials in MyDNS config file
- Access control rules logged for audit
- GeoIP database updated monthly
- Web UI requires authentication

## Limitations

- Requires MyDNS C code modifications (complex)
- GeoIP accuracy ~95% at country level
- Cloudflare IPs may change (sensors adapt hourly)
- Requires sensors in each geographic region
- Only works with Cloudflare proxied records

## Multi-Provider DNS

This system enables **true Multi-Provider DNS**:

**Without this system:**
- Cloudflare NS: Returns 104.16.1.2 (Cloudflare proxy)
- MyDNS NS: Returns 1.2.3.4 (origin server)
- ❌ Different IPs = DNS inconsistency

**With this system:**
- Cloudflare NS: Returns 104.16.1.2 (Cloudflare proxy)
- MyDNS NS: Returns 104.16.1.2 (learned from sensor)
- ✅ Same IPs = Seamless failover

See Cloudflare docs: https://developers.cloudflare.com/dns/nameservers/nameserver-options/#multi-provider-dns

## Next Steps

1. Read IMPLEMENTATION-GUIDE.md for detailed implementation
2. Apply database schema
3. Deploy first sensor (na)
4. Verify learned IPs after 1 hour
5. Deploy remaining sensors (eu, apac, sa, af, oc)
6. Plan MyDNS C code integration
7. Update web UI with sensor management
8. Configure access control rules
9. Enable proxy mode for test zone
10. Test thoroughly before production

## Support

For detailed implementation guidance, see:
- `IMPLEMENTATION-GUIDE.md` - Complete implementation steps
- `schema.sql` - Database structure and comments
- `sensor.py` - Sensor script with inline documentation
