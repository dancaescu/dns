# Advanced DNS Protocols Implementation for MyDNS
Date: 2025-11-26

## Overview

This document describes the implementation of three advanced DNS protocols for MyDNS:

1. **TSIG** (RFC 2845) - Transaction Signatures for authenticated transfers
2. **DNS UPDATE** (RFC 2136) - Dynamic DNS record updates
3. **DNSSEC-aware transfers** - Zone transfers with DNSSEC signatures

These complement the core AXFR, IXFR, and NOTIFY protocols previously implemented.

---

## 1. TSIG Authentication (RFC 2845)

**Status:** ✅ Infrastructure Complete

### Implementation Summary

**Files Created:**
- `src/lib/tsig.h` - Complete header with all function prototypes
- `src/lib/tsig.c` - Full implementation (~600 lines)
- `contrib/tsig-schema.sql` - Database schema

**Key Features:**

1. **Supported Algorithms:**
   - HMAC-MD5 (legacy)
   - HMAC-SHA1 (legacy)
   - HMAC-SHA224
   - HMAC-SHA256 (recommended)
   - HMAC-SHA384
   - HMAC-SHA512

2. **Core Functions:**
   ```c
   tsig_key_create()      // Create key from name, algorithm, secret
   tsig_sign()            // Sign DNS message
   tsig_verify()          // Verify signature
   tsig_hmac()            // Compute HMAC
   tsig_load_keys_from_db() // Load keys from database
   ```

3. **Database Schema:**
   ```sql
   CREATE TABLE tsig_keys (
       id INT PRIMARY KEY AUTO_INCREMENT,
       name VARCHAR(255) UNIQUE,
       algorithm VARCHAR(50),
       secret TEXT,  -- Base64-encoded
       allow_axfr BOOLEAN,
       allow_update BOOLEAN,
       enabled BOOLEAN
   );

   CREATE TABLE tsig_usage_log (
       id BIGINT PRIMARY KEY AUTO_INCREMENT,
       key_id INT,
       operation ENUM('AXFR', 'IXFR', 'UPDATE'),
       success BOOLEAN,
       created_at TIMESTAMP
   );
   ```

4. **Key Generation:**
   ```bash
   # Generate 256-bit key for HMAC-SHA256
   openssl rand -base64 32

   # Generate 512-bit key for HMAC-SHA512
   openssl rand -base64 64
   ```

5. **Usage Example:**
   ```sql
   -- Create TSIG key
   INSERT INTO tsig_keys (name, algorithm, secret, allow_axfr)
   VALUES ('transfer-key.example.com.', 'hmac-sha256',
           'xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==', TRUE);

   -- Associate with zone transfer
   UPDATE zone_masters
   SET tsig_key_id = (SELECT id FROM tsig_keys WHERE name = 'transfer-key.example.com.')
   WHERE zone_id = 123;
   ```

6. **BIND Configuration:**
   ```bind
   key "transfer-key.example.com." {
       algorithm hmac-sha256;
       secret "xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==";
   };

   server 10.1.1.2 {
       keys { transfer-key.example.com.; };
   };

   zone "example.com" {
       type master;
       allow-transfer { key transfer-key.example.com.; };
   };
   ```

### Security Benefits

| Aspect | Without TSIG | With TSIG |
|--------|--------------|-----------|
| Authentication | IP-based only | Cryptographic proof |
| Man-in-middle | Vulnerable | Protected |
| IP spoofing | Vulnerable | Immune |
| Key rotation | Requires firewall changes | Simple secret update |
| Audit trail | Limited | Comprehensive logging |

### Integration Points

**Pending integrations:**
1. AXFR client - Add TSIG to outgoing requests
2. AXFR server - Verify TSIG on incoming requests
3. IXFR - TSIG support for incremental transfers
4. DNS UPDATE - TSIG required for authentication
5. NOTIFY - Optional TSIG for security

---

## 2. DNS UPDATE Protocol (RFC 2136)

**Status:** ✅ API Designed, Implementation Pending

### Design Overview

**Files Created:**
- `src/lib/dnsupdate.h` - Complete API specification

**Key Components:**

1. **UPDATE Message Format:**
   ```
   +---------------------+
   | Header              | (OPCODE=5 for UPDATE)
   +---------------------+
   | Zone Section        | (1 RR - SOA, specifies zone)
   +---------------------+
   | Prerequisite Section| (Conditions that must be met)
   +---------------------+
   | Update Section      | (Changes to apply)
   +---------------------+
   | Additional Section  | (TSIG for authentication)
   +---------------------+
   ```

2. **Prerequisite Types:**
   - **YXDOMAIN** - Name must exist
   - **NXDOMAIN** - Name must not exist
   - **YXRRSET** - RRset must exist
   - **NXRRSET** - RRset must not exist
   - **YXRRSET with value** - Specific RR must exist

3. **Update Operations:**
   - **ADD** - Add RR to RRset
   - **DELETE** - Delete specific RRs
   - **DELETE ALL** - Delete all RRsets for name/type
   - **DELETE NAME** - Delete entire name

4. **Processing Flow:**
   ```
   1. Parse UPDATE message
   2. Extract TSIG (if present)
   3. Verify TSIG signature
   4. Check authorization (ACL)
   5. Check zone authority
   6. BEGIN TRANSACTION
   7. Check all prerequisites
   8. Apply all updates
   9. Increment SOA serial
   10. COMMIT TRANSACTION
   11. Send NOTIFY to slaves
   12. Send response
   ```

5. **Database Schema:**
   ```sql
   CREATE TABLE update_acl (
       id INT PRIMARY KEY AUTO_INCREMENT,
       zone VARCHAR(255),
       key_name VARCHAR(255),  -- Required TSIG key
       allowed_ips TEXT,       -- Comma-separated
       allow_add BOOLEAN,
       allow_delete BOOLEAN,
       enabled BOOLEAN
   );

   CREATE TABLE update_log (
       id BIGINT PRIMARY KEY AUTO_INCREMENT,
       zone VARCHAR(255),
       operation VARCHAR(10),
       record_name VARCHAR(255),
       record_type VARCHAR(10),
       source_ip VARCHAR(45),
       tsig_key VARCHAR(255),
       success BOOLEAN,
       error_message VARCHAR(255),
       created_at TIMESTAMP
   );
   ```

6. **Security:**
   - TSIG authentication **required** by default
   - IP-based ACL as secondary check
   - Per-zone permissions (add/delete/update)
   - Comprehensive audit logging

### Example Usage

**Client (using nsupdate):**
```bash
# Update with TSIG key
nsupdate -k Ktransfer-key.example.com.+165+12345.key <<EOF
server 10.1.1.1
zone example.com
update add newhost.example.com 3600 A 10.2.3.4
send
EOF
```

**Server Processing:**
```
1. Receive UPDATE for example.com
2. Extract TSIG: transfer-key.example.com
3. Verify HMAC signature ✓
4. Check ACL: Key has allow_add=TRUE ✓
5. Check prerequisites: None
6. Apply: INSERT INTO rr (zone, name, type, data, ttl)
         VALUES (123, 'newhost', 'A', '10.2.3.4', 3600)
7. Increment SOA: 2025112601 → 2025112602
8. Send NOTIFY to slaves
9. Response: NOERROR
```

### Use Cases

1. **Dynamic DHCP Integration:**
   - DHCP server updates DNS on lease assignment
   - Automatic A and PTR record creation
   - Cleanup on lease expiry

2. **Service Discovery:**
   - Applications register SRV records
   - Load balancers update weights
   - Health checks modify records

3. **Let's Encrypt DNS-01 Challenge:**
   - Automated TXT record creation
   - Certificate validation
   - Automatic cleanup

4. **Cloud Auto-scaling:**
   - New instances add themselves to DNS
   - Terminated instances remove records
   - Zero manual intervention

---

## 3. DNSSEC-Aware Transfers

**Status:** 📋 Specification, Implementation Pending

### Overview

DNSSEC (DNS Security Extensions) adds cryptographic signatures to DNS records to prevent cache poisoning and ensure data integrity. DNSSEC-aware zone transfers must handle additional record types:

- **DNSKEY** - Public signing keys
- **RRSIG** - RRset signatures
- **NSEC/NSEC3** - Authenticated denial of existence
- **DS** - Delegation signer records

### Design

1. **Extended Record Types:**
   ```sql
   -- Add DNSSEC-specific columns to rr table
   ALTER TABLE rr
   ADD COLUMN dnssec_signed BOOLEAN DEFAULT FALSE,
   ADD COLUMN signature_expiration TIMESTAMP NULL,
   ADD COLUMN key_tag INT UNSIGNED NULL;

   -- DNSKEY storage
   CREATE TABLE dnssec_keys (
       id INT PRIMARY KEY AUTO_INCREMENT,
       zone_id INT,
       key_tag INT UNSIGNED,
       algorithm TINYINT UNSIGNED,
       flags INT UNSIGNED,
       public_key TEXT,
       private_key TEXT ENCRYPTED,  -- Only on master
       created_at TIMESTAMP,
       expires_at TIMESTAMP
   );

   -- Signature cache
   CREATE TABLE dnssec_signatures (
       id BIGINT PRIMARY KEY AUTO_INCREMENT,
       zone_id INT,
       owner_name VARCHAR(255),
       type_covered VARCHAR(10),
       algorithm TINYINT,
       labels TINYINT,
       original_ttl INT,
       expiration TIMESTAMP,
       inception TIMESTAMP,
       key_tag INT UNSIGNED,
       signer_name VARCHAR(255),
       signature TEXT,
       INDEX idx_zone_name (zone_id, owner_name)
   );
   ```

2. **AXFR with DNSSEC:**
   - Transfer includes all DNSSEC records
   - Signatures validated on slave
   - Chain of trust verified
   - Expired signatures detected

3. **Key Management:**
   - Automatic key generation
   - Key rollover support
   - KSK (Key Signing Key) and ZSK (Zone Signing Key)
   - Parent DS record updates

4. **Online Signing:**
   - Sign responses on-the-fly
   - Signature caching for performance
   - Automatic re-signing before expiry

### Implementation Steps

1. **Phase 1: Storage**
   - Extend database schema for DNSSEC records
   - Support DNSKEY, RRSIG, NSEC3, DS types
   - Store in `rr` table with proper encoding

2. **Phase 2: Zone Transfer**
   - AXFR includes all DNSSEC records
   - IXFR handles DNSSEC record changes
   - Validate signatures on transfer

3. **Phase 3: Signing (Master)**
   - Load DNSKEY records
   - Generate RRSIG for each RRset
   - Create NSEC3 chain
   - Update SOA and re-sign zone

4. **Phase 4: Validation (Slave)**
   - Verify RRSIG signatures
   - Check expiration dates
   - Validate DNSKEY with DS
   - Build chain of trust to root

5. **Phase 5: Online Signing**
   - Sign query responses dynamically
   - Cache signatures for performance
   - Handle unsigned delegations

### Security Benefits

| Aspect | Without DNSSEC | With DNSSEC |
|--------|----------------|-------------|
| Cache poisoning | Vulnerable | Protected |
| Data integrity | No guarantee | Cryptographically proven |
| Authenticated denial | No | NSEC/NSEC3 |
| Man-in-middle | Possible | Detected |
| Trust | None | Chain to root |

---

## Integration Summary

### Complete Protocol Stack

```
┌─────────────────────────────────────────┐
│           Application Layer             │
├─────────────────────────────────────────┤
│ DNS UPDATE (RFC 2136) - Dynamic updates │
├─────────────────────────────────────────┤
│ TSIG (RFC 2845) - Authentication        │
├─────────────────────────────────────────┤
│ DNSSEC - Signing & Validation           │
├─────────────────────────────────────────┤
│ NOTIFY (RFC 1996) - Push notifications  │
├─────────────────────────────────────────┤
│ IXFR (RFC 1995) - Incremental transfer  │
├─────────────────────────────────────────┤
│ AXFR (RFC 1035) - Full zone transfer    │
├─────────────────────────────────────────┤
│ DNS Query/Response (RFC 1035)           │
└─────────────────────────────────────────┘
```

### Feature Matrix

| Feature | Status | Files | Database | Testing |
|---------|--------|-------|----------|---------|
| AXFR | ✅ Complete | axfr.c/h | ✅ | Pending |
| IXFR | ✅ Complete | axfr.c/h | ✅ | Pending |
| NOTIFY | ✅ Complete | axfr.c/h, xfer.c | ✅ | Pending |
| Serial Check | ✅ Complete | axfr.c | ✅ | Pending |
| Memzone | ✅ Complete | memzone.c/h | N/A | Pending |
| ACL | ✅ Complete | memzone.c/h | ✅ | Pending |
| TSIG | ✅ Infrastructure | tsig.c/h | ✅ | Pending |
| DNS UPDATE | 📋 Designed | dnsupdate.h | 📋 | Pending |
| DNSSEC | 📋 Specified | - | 📋 | Pending |

### Dependencies

```
┌──────────┐
│  OpenSSL │ ← Required for TSIG HMAC
└────┬─────┘
     │
┌────▼─────┐
│   TSIG   │
└────┬─────┘
     │
     ├────► AXFR/IXFR (Authentication)
     ├────► DNS UPDATE (Required)
     └────► NOTIFY (Optional)

┌──────────┐
│  GeoIP   │ ← Existing
└────┬─────┘
     │
┌────▼─────┐
│   ACL    │ ← Access Control
└────┬─────┘
     │
     ├────► Memzone (In-memory)
     ├────► DNS UPDATE (Authorization)
     └────► AXFR (IP-based)

┌──────────┐
│  DNSSEC  │
└────┬─────┘
     │
     ├────► AXFR (Transfer signatures)
     ├────► Query (Sign responses)
     └────► UPDATE (Sign zone)
```

---

## Installation

### 1. Apply Database Schemas

```bash
# Core AXFR/IXFR/NOTIFY
mysql -u root did < contrib/axfr-slave-schema.sql
mysql -u root did < contrib/axfr-ixfr-schema.sql
mysql -u root did < contrib/soa-serial-trigger.sql

# TSIG
mysql -u root did < contrib/tsig-schema.sql

# DNS UPDATE (when implemented)
mysql -u root did < contrib/dnsupdate-schema.sql

# DNSSEC (when implemented)
mysql -u root did < contrib/dnssec-schema.sql
```

### 2. Compile MyDNS

```bash
cd /scripts/mydns-ng-master
autoreconf -f
./configure --with-mysql
make clean && make
make install
```

### 3. Configure TSIG Keys

```bash
# Generate key
openssl rand -base64 32

# Add to database
mysql -u root did <<EOF
INSERT INTO tsig_keys (name, algorithm, secret, allow_axfr, enabled)
VALUES ('transfer-key.example.com.', 'hmac-sha256',
        'YOUR_BASE64_SECRET_HERE', TRUE, TRUE);
EOF
```

### 4. Start Services

```bash
# Main DNS server
systemctl restart mydns

# Transfer daemon (if separate)
mydns-xfer -d
```

---

## Performance Impact

### TSIG Overhead

| Message Type | Without TSIG | With TSIG | Overhead |
|--------------|--------------|-----------|----------|
| Query | ~50 bytes | ~150 bytes | +100 bytes |
| AXFR start | ~100 bytes | ~200 bytes | +100 bytes |
| AXFR record | ~50 bytes | ~50 bytes | 0 bytes |
| UPDATE | ~100 bytes | ~200 bytes | +100 bytes |

CPU overhead: ~0.1ms per HMAC-SHA256 signature

### DNSSEC Overhead

| Aspect | Unsigned | Signed | Impact |
|--------|----------|--------|--------|
| Zone size | 100% | ~300% | 3x storage |
| Transfer time | 1x | ~2x | Signatures |
| Query response | 100 bytes | ~400 bytes | Signatures |
| CPU per query | ~0.1ms | ~1-2ms | Signing |

---

## Security Considerations

### Threat Model

1. **IP Spoofing:** Mitigated by TSIG
2. **Man-in-Middle:** Mitigated by TSIG + DNSSEC
3. **Cache Poisoning:** Mitigated by DNSSEC
4. **Unauthorized Updates:** Mitigated by TSIG + ACL
5. **Replay Attacks:** Mitigated by TSIG timestamps

### Best Practices

1. **TSIG:**
   - Use HMAC-SHA256 or better
   - Rotate keys every 90 days
   - Use different keys per slave
   - Enable audit logging

2. **DNS UPDATE:**
   - Always require TSIG
   - Implement strict ACLs
   - Log all operations
   - Rate limit by IP/key

3. **DNSSEC:**
   - Use NSEC3 for zone walking protection
   - Automate key rollover
   - Monitor signature expiration
   - Maintain DS records at parent

---

## References

- RFC 1035: Domain Names - Implementation and Specification
- RFC 1995: Incremental Zone Transfer in DNS (IXFR)
- RFC 1996: A Mechanism for Prompt Notification of Zone Changes (NOTIFY)
- RFC 2136: Dynamic Updates in the Domain Name System (DNS UPDATE)
- RFC 2845: Secret Key Transaction Authentication for DNS (TSIG)
- RFC 4033-4035: DNS Security Introduction and Resource Records (DNSSEC)
- RFC 5155: NSEC3 for Authenticated Denial of Existence
- RFC 6781: DNSSEC Operational Practices

---

## Future Work

1. **Complete TSIG Integration:**
   - Integrate with AXFR client/server
   - Add to IXFR protocol
   - NOTIFY authentication

2. **Implement DNS UPDATE:**
   - Complete dnsupdate.c implementation
   - UDP listener in mydns daemon
   - TSIG verification
   - ACL enforcement
   - Audit logging

3. **Implement DNSSEC:**
   - Key generation and management
   - Zone signing
   - Online signing
   - Signature validation
   - NSEC3 generation

4. **Testing:**
   - Unit tests for each module
   - Integration tests
   - Interoperability with BIND, PowerDNS
   - Performance benchmarks
   - Security audit

5. **Documentation:**
   - Administrator guide
   - API documentation
   - Configuration examples
   - Troubleshooting guide
   - Migration procedures
