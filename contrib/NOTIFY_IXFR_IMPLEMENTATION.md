# NOTIFY and IXFR Implementation for MyDNS
Date: 2025-11-26

## Overview

This document describes the implementation of DNS NOTIFY (RFC 1996) and IXFR (RFC 1995) protocols for MyDNS, completing the zone transfer functionality along with the existing AXFR implementation.

## Implemented Features

### 1. Date-Based SOA Serial Management (✅ Completed)

**File:** `/contrib/soa-serial-trigger.sql`

**Description:** MySQL trigger system for automatic SOA serial increment using date-based format (YYYYMMDDNN).

**Format:**
- YYYYMMDD: Current date (e.g., 20251126)
- NN: Daily revision number (01-99)

**Features:**
- Automatic increment on INSERT/UPDATE/DELETE to `rr` table
- Only affects master zones (slave_mode=FALSE)
- Handles daily rollover
- Maximum 99 revisions per day

**Usage:**
```sql
mysql -u root -p did < contrib/soa-serial-trigger.sql
```

### 2. Serial Check Function (✅ Completed)

**Function:** `axfr_check_serial()`
**Location:** `src/lib/axfr.c`

**Description:** Queries master server via UDP DNS to check SOA serial before performing transfer.

**Features:**
- Creates UDP DNS query for SOA record
- Parses SOA response to extract serial number
- Compares master serial vs local serial
- Returns:
  - 0 if transfer needed (master > local)
  - 1 if up-to-date (master <= local)
  - -1 on error

**Benefits:**
- Avoids unnecessary full zone transfers
- Bandwidth efficient
- Reduces master server load

### 3. NOTIFY Protocol (RFC 1996) (✅ Completed)

**Files:**
- `src/lib/axfr.h` - Function declarations
- `src/lib/axfr.c` - Implementation (400+ lines)
- `src/mydns/xfer.c` - Integration into transfer daemon
- `contrib/axfr-notify-migration.sql` - Database migration

**Description:** Push-based zone change notifications from master to slaves.

**Functions:**
- `axfr_notify_listen(port)` - Creates UDP listener socket
- `axfr_notify_parse(message, length, ...)` - Parses NOTIFY message
- `axfr_notify_respond(sockfd, query_id, ...)` - Sends response
- `axfr_notify_process(db, zone_name, source_ip)` - Validates and triggers transfer

**Features:**
- Listens on UDP port 5300 (configurable)
- Validates source IP against configured masters
- Parses DNS NOTIFY messages (opcode=4)
- Sends proper DNS response
- Triggers immediate zone transfer on valid NOTIFY
- Logs last_notify timestamp to database

**Integration:**
- Integrated into mydns-xfer daemon transfer loop
- Uses select() for non-blocking operation
- Runs alongside scheduled polling
- Falls back to polling if NOTIFY unavailable

**Database Changes:**
```sql
ALTER TABLE zone_masters
ADD COLUMN last_notify TIMESTAMP NULL;
```

**Master Configuration:**
For BIND masters, add to zone configuration:
```
notify yes;
also-notify { slave-ip-address port 5300; };
```

### 4. IXFR Protocol (RFC 1995) (✅ Completed)

**Files:**
- `src/lib/axfr.h` - Function declarations
- `src/lib/axfr.c` - Implementation (400+ lines)
- `contrib/axfr-ixfr-schema.sql` - Database schema

**Description:** Incremental zone transfers sending only changed records.

**Functions:**
- `axfr_create_ixfr_query(zone_name, query_id, current_serial, ...)` - Creates IXFR query
- `axfr_ixfr_transfer_zone(db, zone, result)` - Performs IXFR transfer
- `axfr_parse_ixfr_response(response, length, ...)` - Parses IXFR response
- `axfr_apply_ixfr_changes(db, zone, records, result)` - Applies changes to database

**Features:**
- QTYPE=251 (IXFR) DNS queries
- Includes current serial in authority section
- Detects AXFR fallback from master
- Parses SOA-delimited change sequences
- Applies add/delete/modify operations
- Automatic fallback to full AXFR if needed

**Database Schema:**
- `zone_changes` - Stores change history for master zones
- `zone_ixfr_config` - IXFR configuration per zone
- `zone_ixfr_log` - IXFR transfer activity log
- Automatic triggers to log changes to `rr` table

**Change Tracking:**
- Logs INSERT, UPDATE, DELETE operations
- Tracks old and new serial numbers
- Stores before/after values for MODIFY
- Automatic cleanup of old changes
- Configurable retention period

**Usage:**
```sql
-- Enable IXFR for a zone
CALL enable_zone_ixfr(zone_id, 10000, 30);

-- View IXFR status
SELECT * FROM v_ixfr_status;

-- View recent changes
SELECT * FROM zone_changes
WHERE zone_id = 123
ORDER BY id DESC
LIMIT 50;
```

### 5. Database Schema Updates (✅ Completed)

**Main Schema:** `contrib/axfr-slave-schema.sql`
- Added `last_notify` column to `zone_masters`
- Updated `v_zone_transfer_status` view to include NOTIFY data

**IXFR Schema:** `contrib/axfr-ixfr-schema.sql` (NEW)
- `zone_changes` table - Change history
- `zone_ixfr_config` table - IXFR settings
- `zone_ixfr_log` table - Transfer log
- Triggers for automatic change tracking
- Stored procedures for management

**Migration:** `contrib/axfr-notify-migration.sql` (NEW)
- Adds NOTIFY support to existing installations
- Safe to run on databases with axfr-slave-schema.sql already applied

## Architecture

### Zone Transfer Flow

```
1. Master zone changes
   ↓
2. SOA serial auto-incremented (trigger)
   ↓
3. Master sends NOTIFY to slaves (RFC 1996)
   ↓
4. Slave receives NOTIFY, validates source
   ↓
5. Slave checks SOA serial (axfr_check_serial)
   ↓
6. If serial > current:
   a. Try IXFR transfer (RFC 1995)
   b. If IXFR unavailable, fall back to AXFR (RFC 1035)
   ↓
7. Apply changes to database and memzone
   ↓
8. Update last_transfer, last_notify timestamps
```

### Transfer Types

| Protocol | RFC  | Type        | Bandwidth | Use Case |
|----------|------|-------------|-----------|----------|
| AXFR     | 1035 | Full        | High      | Initial transfer, fallback |
| IXFR     | 1995 | Incremental | Low       | Small changes to large zones |
| NOTIFY   | 1996 | Push        | Minimal   | Instant change notifications |

### Serial Check Flow

```
Scheduled check or NOTIFY received
↓
axfr_check_serial()
  ├─ Create UDP DNS query for SOA
  ├─ Send to master port 53
  ├─ Parse SOA response
  ├─ Extract serial number
  └─ Compare: master_serial > local_serial?
     ├─ Yes → Trigger transfer
     └─ No → Skip (already up-to-date)
```

## Configuration Examples

### Example 1: Master Zone with IXFR

```sql
-- Enable IXFR change tracking
INSERT INTO zone_ixfr_config (zone_id, ixfr_enabled, max_journal_size, journal_retention_days)
VALUES (123, TRUE, 10000, 30);

-- Changes to rr table are automatically logged
INSERT INTO rr (zone, name, type, data, ttl)
VALUES (123, 'newhost', 'A', '10.1.1.1', 3600);

-- SOA serial auto-incremented: 2025112601 → 2025112602
-- Change logged to zone_changes table
```

### Example 2: Slave Zone with NOTIFY

```sql
-- Configure slave zone
INSERT INTO soa (origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, slave_mode)
VALUES ('example.com.', 'ns1.example.com.', 'admin.example.com.', 1, 3600, 600, 86400, 3600, 3600, 'Y', TRUE);

-- Add master server
INSERT INTO zone_masters (zone_id, master_host, master_port)
SELECT id, 'master.example.com', 53
FROM soa WHERE origin = 'example.com.';

-- Start mydns-xfer daemon
mydns-xfer -d

-- Daemon listens for:
--   - NOTIFY messages on UDP port 5300
--   - Scheduled transfers every 300 seconds
```

### Example 3: BIND Master Configuration

```bind
zone "example.com" {
    type master;
    file "/etc/bind/zones/db.example.com";

    // Enable NOTIFY to MyDNS slaves
    notify yes;
    also-notify {
        10.1.1.2 port 5300;  // MyDNS slave #1
        10.1.1.3 port 5300;  // MyDNS slave #2
    };

    // Allow zone transfers
    allow-transfer {
        10.1.1.2;
        10.1.1.3;
    };
};
```

## Monitoring

### Check NOTIFY Activity

```sql
SELECT
    s.origin AS zone_name,
    zm.master_host,
    zm.last_notify,
    zm.last_transfer,
    TIMESTAMPDIFF(SECOND, zm.last_notify, NOW()) AS seconds_since_notify
FROM soa s
JOIN zone_masters zm ON zm.zone_id = s.id
WHERE zm.last_notify > DATE_SUB(NOW(), INTERVAL 1 HOUR)
ORDER BY zm.last_notify DESC;
```

### Check IXFR Status

```sql
SELECT * FROM v_ixfr_status WHERE zone_name = 'example.com.';
```

### View Recent Zone Changes

```sql
SELECT
    zc.id,
    zc.change_type,
    zc.old_serial,
    zc.new_serial,
    zc.record_name,
    zc.record_type,
    zc.record_data,
    zc.created_at
FROM zone_changes zc
JOIN soa s ON s.id = zc.zone_id
WHERE s.origin = 'example.com.'
ORDER BY zc.id DESC
LIMIT 50;
```

### View IXFR Transfer Log

```sql
SELECT
    s.origin,
    zil.old_serial,
    zil.new_serial,
    zil.transfer_type,
    zil.changes_received,
    zil.changes_applied,
    zil.transfer_time,
    zil.created_at
FROM zone_ixfr_log zil
JOIN soa s ON s.id = zil.zone_id
ORDER BY zil.created_at DESC
LIMIT 20;
```

## Performance Benefits

### NOTIFY vs Polling

| Aspect | Polling Only | With NOTIFY |
|--------|--------------|-------------|
| Update latency | 5 minutes (typical) | < 1 second |
| Master queries | Constant (every interval) | Only on changes |
| Network traffic | High (constant SOA checks) | Minimal (push only) |
| Scalability | Poor (O(n) slaves) | Excellent |

### IXFR vs AXFR

| Aspect | AXFR Only | With IXFR |
|--------|-----------|-----------|
| Bandwidth | Full zone every time | Only changes |
| Transfer time | Minutes (large zones) | Seconds |
| Master load | High (full zone generation) | Low (delta only) |
| Example | 10 MB zone, 1 change = 10 MB | 10 MB zone, 1 change = 1 KB |

## Future Enhancements

### Optional Additions (Not Implemented)

1. **TSIG Authentication (RFC 2845)**
   - Framework exists in zone_masters table
   - Full implementation pending
   - Provides cryptographic authentication for transfers

2. **Dynamic DNS UPDATE (RFC 2136)**
   - Separate protocol from zone transfers
   - Allows clients to update records directly
   - Requires security considerations

3. **DNSSEC-aware AXFR/IXFR**
   - Transfer DNSSEC signatures
   - Maintain chain of trust
   - Requires DNSSEC implementation

## Testing

### Test NOTIFY

```bash
# Send test NOTIFY (requires dig or similar tool)
dig @master-server example.com NOTIFY

# Check if slave received it
mysql -u root did -e "
SELECT zone_name, master_host, last_notify
FROM v_zone_transfer_status
WHERE zone_name = 'example.com.';"
```

### Test IXFR

```bash
# Make a change on master
mysql -u root did -e "
INSERT INTO rr (zone, name, type, data, ttl)
VALUES (123, 'test', 'A', '10.1.1.100', 3600);"

# Check change was logged
mysql -u root did -e "
SELECT * FROM zone_changes
WHERE zone_id = 123
ORDER BY id DESC LIMIT 5;"

# Trigger transfer on slave
mydns-xfer -z 123

# Check transfer log
mysql -u root did -e "
SELECT * FROM zone_ixfr_log
ORDER BY created_at DESC LIMIT 5;"
```

## References

- RFC 1035: Domain Names - Implementation and Specification (AXFR)
- RFC 1995: Incremental Zone Transfer in DNS (IXFR)
- RFC 1996: A Mechanism for Prompt Notification of Zone Changes (NOTIFY)
- RFC 2845: Secret Key Transaction Authentication for DNS (TSIG)
- RFC 2136: Dynamic Updates in the Domain Name System (DNS UPDATE)

## Changelog

- 2025-11-26: Initial implementation of NOTIFY and IXFR protocols
- 2025-11-26: Added date-based SOA serial management
- 2025-11-26: Implemented axfr_check_serial() function
- 2025-11-26: Created comprehensive database schema for IXFR
- 2025-11-26: Integrated NOTIFY listener into mydns-xfer daemon
