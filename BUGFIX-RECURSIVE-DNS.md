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

### Advanced DNS Cache Feature Status
The `dns-cache-enabled` feature is currently **disabled** in the database (`dns_cache_config.enabled=0`).

Investigation revealed that while the infrastructure exists (`dns-cache.c`, `dns-cache.h`), the `dnscache_resolve()` function returns empty results. This appears to be incomplete/stub implementation.

**Database Priority**: MyDNS loads configuration with this priority:
1. Database (`dns_cache_config` table) - **Takes precedence**
2. Config file (`/etc/mydns/mydns.conf`)
3. Hardcoded defaults

Since database has `enabled=0`, the advanced cache is disabled even though config file has `dns-cache-enabled = 1`.

## Known Issues
- Advanced DNS cache (`dns-cache-enabled = 1`) returns empty results
- `dnscache_resolve()` function needs implementation

## Performance
- First query: ~70ms
- Cached query: ~50ms (reply-cache working)
- Stable operation under load

## Next Steps
1. Complete implementation of `dnscache_resolve()` function
2. Add proper DNS query forwarding to upstream servers
3. Implement cache storage and retrieval logic
4. Enable advanced cache once fully implemented
