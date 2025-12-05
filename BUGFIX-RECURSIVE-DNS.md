# Bug Fix: Recursive DNS NULL Pointer Crash

## Date
2025-12-04

## Issue
Recursive DNS queries were causing SEGV (segmentation fault) crashes after successfully sending queries to upstream DNS servers. The crash occurred when calculating query timeouts.

## Root Cause
In `/scripts/mydns-ng-master/src/lib/conf.c` at line 609:

```c
recursion_algorithm = conf_get(&Conf, "recursive-algorithm", NULL);
```

When the `recursive-algorithm` key was missing from `mydns.conf`, `conf_get()` returned NULL, overwriting the valid default value "linear" that was initialized at conf.c:65. This caused a NULL pointer dereference in `recursive.c:221`:

```c
if (!strcasecmp(recursion_algorithm, "linear")) // CRASH: recursion_algorithm is NULL
```

## Fix Applied
Modified `/scripts/mydns-ng-master/src/lib/conf.c` lines 609-614:

```c
const char *algo_val = conf_get(&Conf, "recursive-algorithm", NULL);
if (algo_val) {
  recursion_algorithm = algo_val;
}
/* else keep the default "linear" value set at initialization */
```

This preserves the default "linear" value when the config key is missing.

## Files Modified
- `/scripts/mydns-ng-master/src/lib/conf.c` (lines 609-614)

## Testing Results
After fix:
- ✅ Recursive DNS queries work correctly for all record types
- ✅ IPv4 (A), IPv6 (AAAA), MX, SOA, NS, CNAME records all functioning
- ✅ Round-robin forwarding to upstream DNS (8.8.8.8, 8.8.4.4, 1.1.1.1, 1.0.0.1)
- ✅ Reply caching active (30 second TTL, 1024 entries)
- ✅ Authoritative zones working correctly
- ✅ Service stable, no crashes

## Current Configuration

### Active Features
- **Recursive Forwarding**: `recursive_fwd()` method with round-robin health checking
- **Reply Cache**: Enabled (30s TTL, 1024 entries)
- **Zone Cache**: Enabled (60s TTL, 1024 entries)
- **Upstream DNS**: 8.8.8.8, 8.8.4.4, 1.1.1.1, 1.0.0.1

### Advanced DNS Cache vs Traditional Recursive Forwarding

**IMPORTANT**: MyDNS implements TWO mutually exclusive recursive resolution methods:

1. **Traditional Recursive Forwarding** (`recursive =` config option)
   - Function: `recursive_fwd()` in `/src/mydns/recursive.c:1132`
   - For master servers with database backend
   - Round-robin health checking of multiple upstream DNS servers
   - Currently ACTIVE and working perfectly

2. **Advanced DNS Cache** (`dns-cache-enabled` config option)
   - Function: `dnscache_fwd()` in `/src/mydns/dnscache-resolve.c:35`
   - For MySQL-free slave servers
   - Individual TTL tracking per cached record
   - Fully implemented and ready to use

**Configuration Precedence** (resolve.c:92-106):
```c
if (forward_recursive) {
  return recursive_fwd(t);    // Takes precedence
}
else if (DnsCache) {
  return dnscache_fwd(t);      // Only if forward_recursive=0
}
```

**To use Advanced DNS Cache**:
1. Comment out `recursive = ...` in mydns.conf
2. Enable `dns-cache-enabled = 1` in mydns.conf
3. Set `enabled=1` in `dns_cache_config` database table
4. Restart mydns

**Configuration Priority**: MyDNS loads settings in this order:
1. Database (`dns_cache_config` table) - **Takes precedence**
2. Config file (`/etc/mydns/mydns.conf`)
3. Hardcoded defaults

## Known Issues
- DNS cache and recursive forwarding cannot be used simultaneously (by design)
- For production use, keep `recursive = 8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1` ENABLED

## Performance
- First query: ~70ms
- Cached query: ~50ms (reply-cache working)
- Stable operation under load

---

# Bug Fix: TXT Record Failures Due to Missing EDNS0 Support

## Date
2025-12-04 (later same day)

## Issue
After fixing the NULL pointer crash, TXT record queries were consistently timing out with "communications error" and "end of file", while all other DNS record types (A, AAAA, MX, SOA, NS, CNAME, PTR) worked perfectly.

## Root Cause
In `/scripts/mydns-ng-master/src/mydns/message.c`, the `dns_make_message()` function was not advertising EDNS0 support:

**Line 67**: ARCOUNT was set to 0 (no Additional records)
```c
DNS_PUT16(dest, 0);  /* ARCOUNT */
```

**After QCLASS (line 98)**: No EDNS0 OPT record was added

### The Problem Sequence:
1. MyDNS sends query to 8.8.8.8 with ARCOUNT=0 (no EDNS0)
2. Google DNS assumes MyDNS can only handle 512-byte UDP responses (RFC 1035 limit)
3. Google's TXT response is 886 bytes (contains SPF, DKIM, domain verification tokens)
4. Google sends truncated 512-byte response with TC (truncated) flag set
5. MyDNS doesn't handle truncation properly → query times out

### Evidence from Packet Capture
```
# Query to 8.8.8.8 for google.com TXT (successful):
15:19:33.449316 Out IP 169.197.174.16 > 8.8.8.8: 25948+ [1au] TXT? google.com.
                                                            ^^^^
                                        [1au] = 1 Additional Record (EDNS0 OPT)

15:19:33.478742 In  IP 8.8.8.8 > 169.197.174.16: 25948 12/0/1 TXT "..." (886)
                                                        ^^
                                            12 TXT records (886 bytes total)
```

## Fix Applied
Modified `/scripts/mydns-ng-master/src/mydns/message.c`:

**Line 67**: Changed ARCOUNT to 1
```c
DNS_PUT16(dest, 1);  /* ARCOUNT (1 for EDNS0 OPT record) */
```

**Lines 100-105**: Added EDNS0 OPT record after QCLASS
```c
/* Add EDNS0 OPT record (RFC 2671) to support UDP packets larger than 512 bytes */
*dest++ = 0;                           /* NAME: root domain (.) */
DNS_PUT16(dest, 41);                   /* TYPE: OPT (41) */
DNS_PUT16(dest, DNS_MAXPACKETLEN_UDP); /* CLASS: UDP payload size (4096) */
DNS_PUT32(dest, 0);                    /* TTL: Extended RCODE and flags */
DNS_PUT16(dest, 0);                    /* RDLENGTH: 0 (no options) */
```

This advertises that MyDNS can receive UDP responses up to 4096 bytes (the value of DNS_MAXPACKETLEN_UDP set in mydns.h).

## Files Modified
- `/scripts/mydns-ng-master/src/mydns/message.c` (lines 67, 100-105)
- `/scripts/mydns-ng-master/src/lib/mydns.h` (line 232, previously changed from 512 to 4096)

## Testing Results
After EDNS0 implementation:
- ✅ TXT records now work correctly
- ✅ All 12 Google TXT records received (886 bytes)
- ✅ No truncated responses
- ✅ All other record types continue to work
- ✅ Query overhead: +11 bytes per query (EDNS0 OPT record)

## EDNS0 Wire Format (11 bytes)
```
Offset  Size  Value       Description
------  ----  ----------  -----------
0       1     0x00        NAME: root domain (.)
1       2     0x0029      TYPE: 41 (OPT)
3       2     0x1000      CLASS: 4096 bytes (UDP payload size)
5       4     0x00000000  TTL: Extended RCODE and flags
9       2     0x0000      RDLENGTH: 0 (no options)
```

## Standards Compliance
- **RFC 1035** (1987): Original DNS (512-byte UDP limit)
- **RFC 2671** (1999): EDNS0 specification (superseded)
- **RFC 6891** (2013): Current EDNS0 specification

## Documentation
See `EDNS0-IMPLEMENTATION.md` for complete technical details, examples of truncated responses, and packet captures.

---

## Next Steps
1. ✅ COMPLETED: Both `recursive_fwd()` and `dnscache_fwd()` are fully implemented
2. ✅ COMPLETED: DNS query forwarding to upstream servers working perfectly
3. ✅ COMPLETED: Cache storage and retrieval logic complete
4. ✅ COMPLETED: EDNS0 support implemented - TXT records working
5. Production server should use `recursive =` setting (currently active)
6. Advanced DNS cache (`dns-cache-enabled`) is only for MySQL-free slave deployments
