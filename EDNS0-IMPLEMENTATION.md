# EDNS0 Support Implementation

## Date
2025-12-04

## Overview
This document describes the implementation of EDNS0 (Extension Mechanisms for DNS) support in MyDNS to enable handling of DNS responses larger than 512 bytes over UDP.

---

## The Problem: TXT Record Timeouts

### Symptom
TXT record queries to major domains (e.g., google.com) were consistently timing out:

```bash
$ dig @localhost google.com TXT +short
;; communications error to 127.0.0.1#53: end of file
;; communications error to 127.0.0.1#53: end of file
;; communications error to 127.0.0.1#53: end of file
```

Meanwhile, all other DNS record types worked perfectly:
- ✅ A records (IPv4)
- ✅ AAAA records (IPv6)
- ✅ MX records
- ✅ SOA records
- ✅ NS records
- ✅ CNAME records
- ✅ PTR records (reverse DNS)

### Why Only TXT Records Failed

TXT records often contain large amounts of data. For example, Google's TXT records include:
- SPF records (email validation)
- Domain verification tokens
- DKIM keys
- DMARC policies
- Site verification strings

When queried, Google's complete TXT response is **886 bytes** - significantly larger than other record types.

---

## Root Cause Analysis

### The 512-Byte UDP Limit

Original DNS specification (RFC 1035) imposed a hard limit:
> **"Messages carried by UDP are restricted to 512 octets (exclusive of IP or UDP headers)"**

This was sufficient for most DNS queries in the 1980s, but modern DNS usage (DNSSEC, large TXT records, etc.) requires larger messages.

### How the Failure Occurred

**Without EDNS0 support, here's what happened:**

1. **MyDNS sends query** to upstream DNS (8.8.8.8):
   ```
   DNS Header:
     ID: 25948
     ARCOUNT: 0  ← NO ADDITIONAL RECORDS (no EDNS0 OPT)
   Question:
     google.com TXT
   ```

2. **Google DNS receives the query** and sees:
   - No EDNS0 OPT record in Additional section
   - Assumes client can only handle 512-byte UDP responses
   - Google's TXT response is 886 bytes

3. **Google DNS sends truncated response**:
   ```
   DNS Header:
     ID: 25948
     TC (Truncated) flag: SET  ← RESPONSE WAS TRUNCATED!
     ANCOUNT: 0
   Answer Section:
     (empty due to truncation)
   ```

   The TC flag tells the client: "This response was too large, please retry over TCP."

4. **MyDNS receives truncated response** but doesn't properly handle:
   - No TCP fallback implemented
   - Empty answer section interpreted as no data
   - Query times out after waiting for complete response

### Actual Packet Capture Evidence

From `/tmp/dns_capture.txt` showing successful TXT query to 8.8.8.8:

```
15:19:33.449316 ens18 Out IP 169.197.174.16.51525 > 8.8.8.8.53: 25948+ [1au] TXT? google.com.
                                                                    ^^^^
                                                    [1au] = 1 Additional Record (EDNS0)

15:19:33.478742 ens18 In  IP 8.8.8.8.53 > 169.197.174.16.51525: 25948 12/0/1 TXT "..." (886)
                                                                       ^^
                                                    12 TXT records returned (886 bytes total)
```

**Key observation**: When the query includes `[1au]` (EDNS0 OPT record), Google returns the full 886-byte response successfully.

---

## The Solution: EDNS0 (RFC 2671)

### What is EDNS0?

EDNS0 (Extension Mechanisms for DNS, version 0) is a DNS protocol extension that:
- Allows UDP packets larger than 512 bytes
- Uses a pseudo-RR (OPT record) to advertise client capabilities
- Backward compatible with legacy DNS servers

### EDNS0 OPT Record Structure

The OPT record is placed in the **Additional section** of DNS queries:

```
NAME:       0x00                  (root domain ".")
TYPE:       41                    (OPT)
CLASS:      4096                  (UDP payload size - NOT DNS class!)
TTL:        0x00000000           (Extended RCODE and flags)
RDLENGTH:   0                     (no options)
RDATA:      (empty)
```

**Important**: The CLASS field is repurposed to indicate the **maximum UDP payload size** the client can receive (4096 bytes in our case).

### Wire Format (11 bytes total)

```
Offset  Size  Value       Description
------  ----  ----------  -----------
0       1     0x00        NAME: root domain (.)
1       2     0x0029      TYPE: 41 (OPT)
3       2     0x1000      CLASS: 4096 bytes (UDP payload size)
5       4     0x00000000  TTL: Extended RCODE and flags
9       2     0x0000      RDLENGTH: 0 (no options)
```

---

## Implementation Details

### Files Modified

#### `/scripts/mydns-ng-master/src/mydns/message.c`

**Function**: `dns_make_message()` (lines 33-110)

**Changes**:

1. **Line 67**: Changed ARCOUNT from 0 to 1
   ```c
   // BEFORE:
   DNS_PUT16(dest, 0);  /* ARCOUNT */

   // AFTER:
   DNS_PUT16(dest, 1);  /* ARCOUNT (1 for EDNS0 OPT record) */
   ```

2. **Lines 100-105**: Added EDNS0 OPT record after QCLASS
   ```c
   DNS_PUT16(dest, (uint16_t)qtype);      /* QTYPE */
   DNS_PUT16(dest, DNS_CLASS_IN);         /* QCLASS */

   /* Add EDNS0 OPT record (RFC 2671) to support UDP packets larger than 512 bytes */
   *dest++ = 0;                           /* NAME: root domain (.) */
   DNS_PUT16(dest, 41);                   /* TYPE: OPT (41) */
   DNS_PUT16(dest, DNS_MAXPACKETLEN_UDP); /* CLASS: UDP payload size (4096) */
   DNS_PUT32(dest, 0);                    /* TTL: Extended RCODE and flags */
   DNS_PUT16(dest, 0);                    /* RDLENGTH: 0 (no options) */
   ```

#### `/scripts/mydns-ng-master/src/lib/mydns.h`

**Line 232**: Previously increased buffer size (prerequisite for EDNS0)
```c
// BEFORE:
#define DNS_MAXPACKETLEN_UDP   512

// AFTER:
#define DNS_MAXPACKETLEN_UDP   4096   /* EDNS0: Support larger UDP responses */
```

### How It Works Now

**With EDNS0 support:**

1. **MyDNS sends query** with EDNS0 OPT record:
   ```
   DNS Header:
     ID: 25948
     ARCOUNT: 1  ← ONE ADDITIONAL RECORD (EDNS0 OPT)
   Question:
     google.com TXT
   Additional Section:
     OPT record (UDP size: 4096 bytes)
   ```

2. **Google DNS receives the query** and sees:
   - EDNS0 OPT record advertising 4096-byte UDP support
   - Can safely send full 886-byte response

3. **Google DNS sends complete response**:
   ```
   DNS Header:
     ID: 25948
     TC flag: NOT SET  ← RESPONSE NOT TRUNCATED
     ANCOUNT: 12       ← 12 TXT records
   Answer Section:
     TXT "MS=E4A68B9AB2BB9670BCE15412F62916164C0B20BB"
     TXT "google-site-verification=..."
     TXT "v=spf1 include:_spf.google.com ~all"
     ... (9 more records)
   ```

4. **MyDNS receives complete response**:
   - All 12 TXT records received (886 bytes total)
   - Query completes successfully

---

## Testing Evidence

### Before EDNS0 Implementation

```bash
$ dig @localhost google.com TXT +short
;; communications error to 127.0.0.1#53: end of file
;; communications error to 127.0.0.1#53: end of file
;; communications error to 127.0.0.1#53: end of file

$ echo $?
9  # Query failed
```

### After EDNS0 Implementation

```bash
$ dig @localhost google.com TXT +short
"MS=E4A68B9AB2BB9670BCE15412F62916164C0B20BB"
"google-site-verification=4ibFUgB-wXLQ_S7vsXVomSTVamuOXBiVAzpR5IZ87D0"
"google-site-verification=wD8N7i1JTNTkezJ49swvWW48f8_9xveREV4oB-0Hf5o"
"docusign=1b0a6754-49b1-4db5-8540-d2c12664b289"
"facebook-domain-verification=22rm551cu4k0ab0bxsw536tlds4h95"
... (7 more records)

$ echo $?
0  # Query succeeded
```

---

## Performance Impact

### Query Size Increase

**Before EDNS0**:
- Query size: ~40 bytes (Header + Question only)

**After EDNS0**:
- Query size: ~51 bytes (Header + Question + OPT record)
- **Overhead**: +11 bytes per query (+27%)

### Benefits

1. **Eliminates truncated responses** for large records (TXT, DNSKEY, etc.)
2. **No TCP fallback needed** - faster query resolution
3. **Standards compliant** - RFC 2671 (1999), RFC 6891 (2013)
4. **Future-proof** - supports DNSSEC and other modern DNS features

### Compatibility

- ✅ **Forward compatible**: All modern DNS servers support EDNS0
- ✅ **Backward compatible**: Legacy servers ignore OPT records gracefully
- ✅ **No configuration needed**: Works automatically for all queries

---

## Related RFCs

- **RFC 1035** (1987): Original DNS specification (512-byte UDP limit)
- **RFC 2671** (1999): EDNS0 specification (superseded by RFC 6891)
- **RFC 6891** (2013): Current EDNS0 specification

---

## Verification Commands

### Check EDNS0 in Query

```bash
# Query with EDNS0 debug output
dig @localhost google.com TXT +edns=4096

# Output shows:
; EDNS: version: 0, flags:; udp: 4096
```

### Capture EDNS0 Traffic

```bash
# Capture DNS traffic
tcpdump -i any -n -s0 -v port 53

# Look for:
# [1au] = 1 Additional Record (EDNS0 OPT)
```

### Test All Record Types

```bash
# Run comprehensive test
/tmp/test_dns.sh

# All record types should now work including TXT
```

---

## Summary

**Problem**: TXT records timing out due to 512-byte UDP truncation

**Root Cause**: MyDNS not advertising EDNS0 support, causing upstream servers to truncate responses

**Solution**: Implemented EDNS0 OPT record in `dns_make_message()` function

**Result**: TXT records (and all large DNS responses) now work correctly

**Impact**: +11 bytes per query, eliminates TCP fallback, improves performance

---

## Next Steps

1. ✅ EDNS0 support implemented
2. ✅ Buffer size increased to 4096 bytes
3. ✅ All DNS record types working (including TXT)
4. 🔄 Consider implementing TCP fallback for responses > 4096 bytes (future enhancement)
5. 🔄 Consider implementing DNSSEC validation (requires EDNS0)

---

## References

- MyDNS source: `/scripts/mydns-ng-master/`
- Modified files: `src/mydns/message.c`, `src/lib/mydns.h`
- Test script: `/tmp/test_dns.sh`
- Previous bugfix: `BUGFIX-RECURSIVE-DNS.md`
