# mydnsnotify - DNS NOTIFY Utility

## Overview

`mydnsnotify` is a standalone command-line utility for triggering DNS NOTIFY messages to slave servers for a specific zone. This tool allows you to manually notify slaves about zone changes without restarting the entire MyDNS server.

## Purpose

When zone records are updated through external means (e.g., Cloudflare sync, database modifications, API updates), slave DNS servers need to be notified about the changes. The `mydnsnotify` utility provides an efficient way to send these notifications immediately without waiting for the regular polling interval or restarting MyDNS.

## Features

- ✅ **Per-zone NOTIFY** - Send NOTIFY only for specific zones that changed
- ✅ **TSIG support** - Automatically signs NOTIFY messages with TSIG keys if configured
- ✅ **IPv4 and IPv6** - Supports both IPv4 and IPv6 slave servers
- ✅ **Comma-separated slaves** - Reads `also_notify` field from SOA table
- ✅ **Standalone** - No need to restart or modify running MyDNS server
- ✅ **Scriptable** - Easy to integrate with automation scripts and cron jobs

## Installation

### Build and Install

```bash
cd /scripts/mydns-ng-master
make clean
./configure
make
sudo make install
```

The binary will be installed to `/usr/local/bin/mydnsnotify`.

### Verify Installation

```bash
mydnsnotify --version
mydnsnotify --help
```

## Usage

### Basic Syntax

```bash
mydnsnotify [OPTIONS] ZONE
```

### Options

```
  -f, --conf=FILE         read config from FILE instead of the default
  -D, --database=DB       database name to use
  -h, --host=HOST         connect to SQL server at HOST
  -p, --password=PASS     password for SQL server (or prompt from tty)
  -u, --user=USER         username for SQL server if not current user
  -d, --debug             enable debug output
  -v, --verbose           be more verbose while running
      --help              display help and exit
      --version           output version information and exit
```

### Examples

#### Basic Usage

Send NOTIFY for a single zone:

```bash
mydnsnotify example.com.
```

**Note:** Zone names should end with a dot (`.`). If you omit the trailing dot, `mydnsnotify` will add it automatically.

#### With Custom Config File

```bash
mydnsnotify --conf=/etc/mydns/mydns.conf example.com.
```

#### With Database Credentials

```bash
mydnsnotify --host=localhost --user=mydns --password=secret example.com.
```

#### Verbose Mode

```bash
mydnsnotify -v example.com.
```

Example output:
```
Loaded SOA for zone example.com. (id=15)
also_notify field: 192.168.1.10,192.168.1.11
Using TSIG key 'transfer-key' for NOTIFY messages
Sent NOTIFY for zone example.com. to 192.168.1.10
Sent NOTIFY for zone example.com. to 192.168.1.11
Successfully sent NOTIFY to 2 slave(s)
```

## Integration with Cloudflare Sync

The `sync_cloudflare_records.py` script has been enhanced to automatically trigger NOTIFY after syncing zones from Cloudflare.

### How It Works

1. Script syncs zone records from Cloudflare to local database
2. After successful sync, calls `mydnsnotify <zone>`
3. Slaves receive NOTIFY and initiate AXFR/IXFR to get updated records

### Configuration

The sync script looks for `mydnsnotify` at `/usr/local/bin/mydnsnotify` by default. If installed elsewhere, the script will log a warning and skip NOTIFY.

### Manual Trigger After Sync

If you need to manually trigger NOTIFY after a Cloudflare sync:

```bash
# Sync Cloudflare records
python3 /scripts/mydns-ng-master/contrib/sync_cloudflare_records.py

# Manually trigger NOTIFY for specific zones
mydnsnotify example.com.
mydnsnotify test.zone.
```

## Database Schema Requirements

### SOA Table

The tool requires the `also_notify` field in the `soa` table:

```sql
ALTER TABLE soa ADD COLUMN also_notify VARCHAR(255) DEFAULT '' COMMENT 'Comma-separated list of slave IPs to notify';
```

### Setting Slave Servers

Add slave servers to the `also_notify` field (comma-separated):

```sql
UPDATE soa SET also_notify='192.168.1.10,192.168.1.11,2001:db8::10' WHERE origin='example.com.';
```

### Web UI Support

The web UI has been updated to include fields for managing slave servers:
- **AXFR Allowed IPs** (`xfer` field) - Controls which IPs can request zone transfers
- **Also Notify Servers** (`also_notify` field) - List of slaves to notify about changes

## TSIG Support

`mydnsnotify` automatically uses TSIG keys if configured in the database.

### TSIG Configuration

The tool queries for TSIG keys:

```sql
SELECT name, algorithm, secret FROM tsig_keys WHERE enabled=1 AND allow_notify=1 LIMIT 1;
```

### Setting Up TSIG for NOTIFY

```sql
-- Enable NOTIFY for an existing TSIG key
UPDATE tsig_keys SET allow_notify=1 WHERE name='transfer-key';

-- Or create a new key for NOTIFY
INSERT INTO tsig_keys (name, algorithm, secret, enabled, allow_notify)
VALUES ('notify-key', 'hmac-sha256', 'your-base64-secret-here', 1, 1);
```

When TSIG is configured:
- NOTIFY messages are automatically signed
- Verbose mode shows: "Using TSIG key 'notify-key' for NOTIFY messages"
- Each NOTIFY includes: "NOTIFY to 192.168.1.10 signed with TSIG key 'notify-key'"

## Automation Examples

### Cron Job

Trigger NOTIFY daily for all zones after Cloudflare sync:

```bash
# /etc/cron.d/mydns-cloudflare-sync
0 2 * * * root /usr/bin/python3 /scripts/mydns-ng-master/contrib/sync_cloudflare_records.py 2>&1 | logger -t cf-sync
```

**Note:** The Python script now automatically triggers NOTIFY, so no additional cron job needed!

### Custom Script

Trigger NOTIFY for multiple zones:

```bash
#!/bin/bash
# notify-all-zones.sh

ZONES=(
    "example.com."
    "test.zone."
    "mydomain.org."
)

for zone in "${ZONES[@]}"; do
    echo "Triggering NOTIFY for $zone..."
    mydnsnotify "$zone"
done
```

### API Integration

Call from Node.js/TypeScript:

```javascript
import { execSync } from 'child_process';

function triggerNotify(zone: string) {
  try {
    const output = execSync(`mydnsnotify ${zone}`, { encoding: 'utf-8' });
    console.log(`NOTIFY triggered for ${zone}: ${output}`);
  } catch (error) {
    console.error(`Failed to trigger NOTIFY for ${zone}:`, error.message);
  }
}

// Usage
triggerNotify('example.com.');
```

Call from Python:

```python
import subprocess

def trigger_notify(zone: str) -> bool:
    try:
        result = subprocess.run(
            ['mydnsnotify', zone],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print(f"NOTIFY triggered for {zone}")
            return True
        else:
            print(f"Failed: {result.stderr}")
            return False
    except Exception as e:
        print(f"Error: {e}")
        return False
```

## Troubleshooting

### NOTIFY Not Sent

**Problem:** "No slaves configured in also_notify field for zone example.com."

**Solution:** Add slave IPs to the `also_notify` field:

```sql
UPDATE soa SET also_notify='192.168.1.10' WHERE origin='example.com.';
```

### Zone Not Found

**Problem:** "Zone not found: example.com"

**Solution:** Ensure the zone exists in the `soa` table and the name matches exactly (including trailing dot):

```sql
SELECT origin FROM soa WHERE origin='example.com.';
```

### TSIG Signing Failed

**Problem:** "TSIG signing failed for NOTIFY to 192.168.1.10"

**Solution:** Check TSIG key configuration:

```sql
SELECT name, algorithm, secret, enabled, allow_notify FROM tsig_keys;
```

Ensure:
- `enabled = 1`
- `allow_notify = 1`
- `secret` is valid base64
- `algorithm` is supported (e.g., 'hmac-sha256')

### Binary Not Found

**Problem:** "mydnsnotify: command not found"

**Solution:** Check installation path:

```bash
which mydnsnotify
# If not found, rebuild and reinstall
cd /scripts/mydns-ng-master
make clean && ./configure && make && sudo make install
```

### Permission Denied

**Problem:** "Permission denied when accessing database"

**Solution:** Ensure the user running `mydnsnotify` has database access:

```sql
GRANT SELECT ON mydns.soa TO 'mydns_user'@'localhost';
GRANT SELECT ON mydns.tsig_keys TO 'mydns_user'@'localhost';
```

## Comparison: NOTIFY Methods

| Method | Scope | Speed | Use Case |
|--------|-------|-------|----------|
| **Server Restart** | All zones | Slow | Initial setup only |
| **mydnsnotify** | Single zone | Fast | After specific zone changes |
| **Cloudflare Sync (auto)** | Per synced zone | Automatic | After Cloudflare updates |
| **Periodic Check (slaves)** | N/A | Slow (polling interval) | Fallback mechanism |

## Technical Details

### DNS NOTIFY Packet Structure

`mydnsnotify` creates standard RFC 1996 DNS NOTIFY packets:

```
DNS Header:
  - ID: Random 16-bit identifier
  - Opcode: 4 (NOTIFY)
  - AA flag: Set (Authoritative Answer)
  - QDCOUNT: 1
  - ANCOUNT: 0
  - NSCOUNT: 0
  - ARCOUNT: 0 (or 1 if TSIG)

Question Section:
  - QNAME: Zone name (e.g., example.com.)
  - QTYPE: SOA (6)
  - QCLASS: IN (1)

Additional Section (optional):
  - TSIG record if signing enabled
```

### NOTIFY Workflow

1. Load SOA record from database
2. Parse `also_notify` field (comma-separated IPs)
3. Load TSIG key if `allow_notify=1`
4. For each slave IP:
   - Create DNS NOTIFY packet
   - Sign with TSIG if key available
   - Send via UDP to port 53
   - Log result

### Exit Codes

- `0` - Success (at least one NOTIFY sent)
- `1` - Failure (no NOTIFYs sent, zone not found, or database error)

## See Also

- `mydns(8)` - MyDNS server
- `mydnscheck(1)` - Zone consistency checker
- `mydnsimport(1)` - Zone import tool
- RFC 1996 - DNS NOTIFY
- RFC 2845 - TSIG

## Author

MyDNS-NG development team

## License

GNU General Public License v2.0
