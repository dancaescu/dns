# AXFR/IXFR TSIG Implementation Plan
## Date: 2025-11-26

---

## Current Status

**AXFR/IXFR TSIG**: Not yet implemented (future work)
**DNS UPDATE TSIG**: ✅ **Fully implemented and working**

**System Configuration**:
```
allow-axfr = no
allow-tcp = no
```

**Rationale for deferring**: AXFR/IXFR are currently disabled on this system and cannot be tested. The implementation is significantly more complex than DNS UPDATE due to multi-packet signing requirements.

---

## Complexity Analysis

### DNS UPDATE TSIG (Completed - ~14 hours)
- **Single request/response**: One TSIG signature per transaction
- **Stateless**: Each UPDATE is independent
- **Testing**: Simple with `nsupdate` command
- **Buffer handling**: Single response packet

### AXFR/IXFR TSIG (Future - Estimated 6-8 hours)
- **Multiple packets**: Entire zone transfer spans many TCP packets
- **Stateful**: TSIG state must be maintained across all packets
- **Testing**: Requires secondary nameserver or dig +axfr
- **Buffer handling**: Each packet in sequence needs signing
- **TCP only**: Requires TCP connection management
- **First/Middle/Last**: Different TSIG handling for first, intermediate, and final packets

---

## RFC 2845 TSIG for Zone Transfers

### TSIG Signing Rules for Multi-Packet Transfers

1. **First Packet**:
   - Include full TSIG record with request MAC
   - Sign entire message

2. **Intermediate Packets** (every N packets or at intervals):
   - Include TSIG record with previous MAC
   - Can sign every packet or at intervals (RFC allows flexibility)
   - Common practice: sign every 100 records or every packet

3. **Last Packet**:
   - MUST include full TSIG record
   - Sign with all previous MACs in the chain

### TSIG Chaining

```
Request with TSIG
    ↓
Response packet 1 (with TSIG, includes request MAC)
    ↓
Response packet 2 (with TSIG, includes packet 1 MAC)
    ↓
Response packet 3 (with TSIG, includes packet 2 MAC)
    ↓
...
    ↓
Response packet N (LAST, with TSIG, includes packet N-1 MAC)
```

---

## Implementation Plan

### Phase 1: AXFR Request Verification (~2 hours)

**File**: `src/mydns/axfr.c`

**Location**: `axfr()` function, after `axfr_get_soa()`

**Add**:
```c
/* In axfr() function */
void
axfr(TASK *t) {
  MYDNS_SOA *soa = NULL;
  tsig_key_t *tsig_key = NULL;
  unsigned char request_mac[64];
  size_t request_mac_len = 0;

  /* ... existing startup code ... */

  /* Get SOA for zone */
  soa = axfr_get_soa(t);

  if (soa) {
    /* Verify TSIG if present (reuse parse/verify from update.c) */
    tsig_key = verify_tsig_for_axfr(t, request_mac, &request_mac_len);

    if (tsig_enforce_axfr && !tsig_key) {
      dnserror(t, DNS_RCODE_REFUSED, ERR_TSIG_REQUIRED);
      axfr_reply(t);
      axfr_error(t, _("TSIG required for AXFR"));
      /* NOTREACHED */
    }

    /* Check ACL (can include TSIG key requirement) */
    if (check_axfr_acl(t, soa, tsig_key) != 0) {
      dnserror(t, DNS_RCODE_REFUSED, ERR_AXFR_DENIED);
      axfr_reply(t);
      if (tsig_key) tsig_key_free(tsig_key);
      axfr_error(t, _("AXFR denied by ACL"));
      /* NOTREACHED */
    }

    /* Transfer zone with TSIG signing if key present */
    axfr_zone_with_tsig(t, soa, tsig_key, request_mac, request_mac_len);

    if (tsig_key) tsig_key_free(tsig_key);
  }

  /* ... rest of function ... */
}
```

**New Functions to Add**:

1. **verify_tsig_for_axfr()** - Similar to verify_tsig_in_update()
   ```c
   static tsig_key_t *
   verify_tsig_for_axfr(TASK *t, unsigned char *request_mac_out, size_t *request_mac_len_out);
   ```
   - Reuse parse_tsig_record() from update.c
   - Reuse load_tsig_key_for_zone() logic
   - Log to tsig_usage_log with operation='AXFR'

2. **check_axfr_acl()** - New ACL check for zone transfers
   ```c
   static int
   check_axfr_acl(TASK *t, MYDNS_SOA *soa, tsig_key_t *tsig_key);
   ```
   - Check update_acl table or create new axfr_acl table
   - Verify source IP, TSIG key if required
   - Can reuse some logic from check_new_update_acl()

---

### Phase 2: AXFR Response Signing (~3-4 hours)

**Challenges**:
- AXFR sends multiple packets over TCP
- Each packet needs to be signed
- Need to maintain TSIG state (previous MAC) across packets

**Approach 1: Sign Every Packet** (Simpler, more secure)
```c
/* Modified axfr_write() or axfr_send_rr() */
static int
axfr_write_with_tsig(TASK *t, tsig_key_t *tsig_key,
                     unsigned char *prev_mac, size_t *prev_mac_len,
                     char *packet, size_t packet_len, int is_last) {

  if (!tsig_key) {
    /* No TSIG, send as-is */
    return write(t->fd, packet, packet_len);
  }

  /* Allocate buffer for packet + TSIG */
  size_t max_len = packet_len + 200;
  char *signed_packet = ALLOCATE(max_len, char[]);
  memcpy(signed_packet, packet, packet_len);

  /* Sign packet with previous MAC */
  size_t new_len = 0;
  if (tsig_sign((unsigned char*)signed_packet, packet_len, max_len,
                tsig_key, prev_mac, *prev_mac_len, &new_len) == 0) {

    /* Extract MAC from signed packet for next packet */
    if (!is_last) {
      extract_tsig_mac(signed_packet, new_len, prev_mac, prev_mac_len);
    }

    /* Send signed packet */
    int result = write(t->fd, signed_packet, new_len);
    RELEASE(signed_packet);
    return result;
  }

  RELEASE(signed_packet);
  return -1;  /* Signing failed */
}
```

**Approach 2: Sign Every Nth Packet** (More efficient)
- Sign first packet
- Sign every 100 records
- Always sign last packet
- Requires packet counting logic

**Recommendation**: Start with Approach 1 (sign every packet) for simplicity and security. Optimize later if needed.

---

### Phase 3: IXFR Integration (~1-2 hours)

**File**: `src/mydns/ixfr.c`

**Similar approach**:
- Add TSIG verification in `ixfr()` function
- Add TSIG signing to IXFR responses
- IXFR is simpler than AXFR (typically fewer records)
- Can reuse all AXFR TSIG functions

**Structure**:
```c
void
ixfr(TASK *t) {
  /* ... existing code ... */

  /* Verify TSIG */
  tsig_key = verify_tsig_for_axfr(t, request_mac, &request_mac_len);  // Reuse AXFR function

  if (tsig_enforce_axfr && !tsig_key) {
    /* Refuse */
  }

  /* Check ACL */
  if (check_axfr_acl(t, soa, tsig_key) != 0) {  // Reuse AXFR function
    /* Refuse */
  }

  /* Send IXFR with TSIG signing */
  ixfr_zone_with_tsig(t, soa, tsig_key, request_mac, request_mac_len);

  /* ... cleanup ... */
}
```

---

## Database Schema Additions

### Option 1: Extend existing update_acl table
```sql
ALTER TABLE update_acl
ADD COLUMN allow_axfr BOOLEAN DEFAULT FALSE AFTER allow_update;
```

### Option 2: Create dedicated axfr_acl table (Recommended)
```sql
CREATE TABLE IF NOT EXISTS axfr_acl (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    zone VARCHAR(255) NOT NULL,
    key_name VARCHAR(255) NULL COMMENT 'Required TSIG key, NULL = no key required',
    allowed_ips TEXT NULL COMMENT 'Comma-separated IPs/CIDRs, NULL = any IP',
    allow_axfr BOOLEAN DEFAULT TRUE,
    allow_ixfr BOOLEAN DEFAULT TRUE,
    enabled BOOLEAN DEFAULT TRUE,
    priority INT DEFAULT 100,
    description VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_zone (zone),
    INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Zone transfer access control';
```

---

## Configuration Changes

### /etc/mydns/mydns.conf

**Current**:
```ini
allow-axfr = no
allow-tcp = no
tsig-enforce-axfr = no
```

**After Implementation**:
```ini
allow-axfr = yes           # Enable AXFR zone transfers
allow-tcp = yes            # Required for AXFR (uses TCP)
tsig-enforce-axfr = no     # Set to 'yes' to mandate TSIG for all zone transfers
tsig-sign-all-axfr = yes   # Sign every AXFR packet (vs every Nth packet)
```

---

## Testing Plan

### Prerequisites
1. Enable AXFR: `allow-axfr = yes`
2. Enable TCP: `allow-tcp = yes`
3. Create TSIG key in database
4. Configure AXFR ACL

### Test 1: AXFR Without TSIG (Baseline)
```bash
dig @localhost -p 53 axfr example.com
# Should work if ACL allows
```

### Test 2: AXFR With TSIG
```bash
# Create key file
cat > /tmp/axfr-key.conf <<EOF
key "axfr-key.example.com." {
    algorithm hmac-sha256;
    secret "BASE64_SECRET_HERE";
};

server 127.0.0.1 {
    keys { axfr-key.example.com.; };
};
EOF

# Test TSIG-signed AXFR
dig @localhost -p 53 axfr example.com -k /tmp/axfr-key.conf
# Should succeed if key is valid
```

### Test 3: TSIG Required Mode
```bash
# Set tsig-enforce-axfr = yes
# Restart MyDNS

# Try without TSIG
dig @localhost axfr example.com
# Should be REFUSED

# Try with TSIG
dig @localhost axfr example.com -k /tmp/axfr-key.conf
# Should succeed
```

### Test 4: Secondary Nameserver Setup
```bash
# In BIND secondary config:
server 10.1.1.1 {  # MyDNS master
    keys { transfer-key.example.com.; };
};

zone "example.com" {
    type slave;
    masters { 10.1.1.1; };
    file "/var/cache/bind/db.example.com";
};

# Initiate transfer
rndc retransfer example.com
```

---

## Code Reuse from DNS UPDATE

### Functions that can be reused directly:
1. ✅ `parse_tsig_record()` - Parse TSIG from request
2. ✅ `load_tsig_key_for_zone()` - Load key from database
3. ✅ `tsig_sign()` - Sign response packets
4. ✅ `tsig_verify()` - Verify TSIG signatures
5. ✅ `tsig_hmac()` - Compute HMAC

### Functions that need modification:
1. `verify_tsig_in_update()` → `verify_tsig_for_axfr()`
   - Change operation type to 'AXFR' in logging
   - Check `allow_axfr` permission instead of `allow_update`

2. `check_new_update_acl()` → `check_axfr_acl()`
   - Query `axfr_acl` table instead of `update_acl`
   - Check `allow_axfr`/`allow_ixfr` permissions

### New functions needed:
1. `axfr_zone_with_tsig()` - Modified axfr_zone() with TSIG signing
2. `axfr_write_with_tsig()` - Write packet with TSIG signature
3. `extract_tsig_mac()` - Extract MAC from signed packet for chaining
4. `ixfr_zone_with_tsig()` - Modified ixfr logic with TSIG signing

---

## Estimated Effort Breakdown

| Task                              | Estimated Time |
|-----------------------------------|----------------|
| AXFR request TSIG verification    | 2 hours        |
| AXFR ACL implementation           | 1 hour         |
| AXFR response TSIG signing        | 3-4 hours      |
| IXFR TSIG integration             | 1-2 hours      |
| Testing and debugging             | 2-3 hours      |
| Documentation                     | 1 hour         |
| **Total**                         | **10-13 hours**|

**Note**: Original estimate was 6-8 hours, but with TSIG signing for every packet and proper testing, 10-13 hours is more realistic.

---

## Dependencies

### Required for Implementation:
- ✅ TSIG library functions (tsig_sign, tsig_verify) - Already implemented
- ✅ TSIG key database schema - Already exists
- ✅ Configuration infrastructure - Already exists
- ❌ AXFR enabled (`allow-axfr = yes`) - Not currently enabled
- ❌ TCP enabled (`allow-tcp = yes`) - Not currently enabled
- ❌ Test environment with secondary nameserver - Not set up

### Blockers:
1. **AXFR is disabled** on this system
2. **No way to test** without enabling AXFR and setting up a secondary server
3. **TCP support** may have additional issues that need resolving

---

## Risk Assessment

### Low Risk:
- ✅ TSIG verification (reuses proven DNS UPDATE code)
- ✅ TSIG key loading (already working)
- ✅ ACL checking (similar to UPDATE ACL)

### Medium Risk:
- ⚠️ TSIG signing for multi-packet transfers (more complex state management)
- ⚠️ MAC chaining between packets (need to extract MAC from each signed packet)
- ⚠️ TCP connection handling with TSIG

### High Risk:
- 🚨 Cannot test on this system (AXFR disabled)
- 🚨 May have undiscovered issues in AXFR implementation that only surface when enabled
- 🚨 Performance impact of signing every packet (could be significant for large zones)

---

## Recommendation

**Defer AXFR/IXFR TSIG implementation until**:

1. **AXFR is needed** - Currently disabled on this system
2. **Test environment available** - Need secondary nameserver or way to test zone transfers
3. **DNS UPDATE TSIG proven in production** - Ensure current implementation is stable first

**Priority**:
- **High**: DNS UPDATE TSIG ✅ (Completed and working)
- **Medium**: AXFR/IXFR TSIG (when needed, ~10-13 hours)
- **Low**: TSIG for queries (minimal security benefit)

---

## Quick Start When Ready

When AXFR/IXFR TSIG is needed:

1. **Enable AXFR**:
   ```bash
   # Edit /etc/mydns/mydns.conf
   allow-axfr = yes
   allow-tcp = yes
   tsig-enforce-axfr = no  # Start with optional
   ```

2. **Create AXFR ACL table**:
   ```bash
   mysql -u root your_db < contrib/axfr-acl-schema.sql
   ```

3. **Implement verification** (2 hours):
   - Copy verify_tsig_in_update() to verify_tsig_for_axfr()
   - Add check_axfr_acl() function
   - Integrate into axfr() function

4. **Implement signing** (3-4 hours):
   - Create axfr_write_with_tsig()
   - Implement MAC chaining
   - Modify axfr_zone() to use new write function

5. **Test thoroughly** (2-3 hours):
   - Test with dig +axfr
   - Test with secondary nameserver
   - Test TSIG enforcement
   - Verify all records transferred correctly

---

## Alternative: Lazy Implementation

**Minimal AXFR TSIG** (if time-constrained):

1. **Verify TSIG on request only** (2 hours)
   - Check TSIG signature on AXFR request
   - Verify key allows AXFR
   - Don't sign responses

2. **Sign only first and last packet** (2 hours)
   - Sign initial packet with request MAC
   - Sign final packet with first packet MAC
   - Skip intermediate packets

**Pros**: Much faster to implement (4 hours vs 10-13 hours)
**Cons**: Less secure, intermediate packets not authenticated

---

## References

- **RFC 2845** - TSIG (Transaction Signatures)
- **RFC 5936** - DNS Zone Transfer Protocol (AXFR)
- **RFC 1995** - Incremental Zone Transfer (IXFR)
- **BIND 9 TSIG Implementation** - Good reference for multi-packet TSIG

---

## Summary

**AXFR/IXFR TSIG integration is well-planned but deferred because**:

1. ✅ DNS UPDATE TSIG is complete and working
2. ❌ AXFR is disabled on this system
3. ❌ Cannot test without secondary nameserver setup
4. ⏱️ Estimated 10-13 hours implementation + testing
5. 📋 Complete implementation plan documented here

**When AXFR is needed**, this document provides a complete roadmap for implementation.

---

**Status**: 📋 DOCUMENTED - Ready for implementation when AXFR is enabled
**Date**: 2025-11-26
**Estimated Effort**: 10-13 hours
**Dependencies**: AXFR enabled, TCP enabled, test environment
