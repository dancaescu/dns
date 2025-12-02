-- DNSSEC Schema for MyDNS
-- Adds DNSSEC signing capability with automatic RRSIG generation
-- Date: 2025-11-28
-- RFC 4033, 4034, 4035 (DNSSEC)

-- ============================================================================
-- 1. DNSSEC Zone Keys Table
-- ============================================================================
-- Stores cryptographic keys for DNSSEC signing
-- Private keys are stored encrypted, public keys are in DNSKEY format

CREATE TABLE IF NOT EXISTS dnssec_keys (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,

    -- Key identification
    key_tag INT UNSIGNED NOT NULL,              -- RFC 4034 Appendix B key tag
    flags INT UNSIGNED NOT NULL DEFAULT 256,    -- 256 = ZSK, 257 = KSK
    protocol INT UNSIGNED NOT NULL DEFAULT 3,   -- Always 3 per RFC 4034
    algorithm INT UNSIGNED NOT NULL DEFAULT 13, -- Algorithm: 13=ECDSAP256SHA256 (recommended)

    -- Key material
    public_key TEXT NOT NULL,                   -- Base64-encoded public key
    private_key_file VARCHAR(512),              -- Path to private key file (optional)
    private_key_encrypted TEXT,                 -- Or store encrypted private key in DB

    -- Key metadata
    key_type ENUM('KSK', 'ZSK', 'CSK') NOT NULL DEFAULT 'ZSK',
    -- KSK = Key Signing Key (signs DNSKEY RRset)
    -- ZSK = Zone Signing Key (signs all other RRsets)
    -- CSK = Combined Signing Key (does both)

    -- Key lifecycle
    status ENUM('active', 'published', 'retired', 'revoked') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publish_at TIMESTAMP NULL,                  -- When key should be published
    activate_at TIMESTAMP NULL,                 -- When key should start signing
    retire_at TIMESTAMP NULL,                   -- When key should stop signing
    remove_at TIMESTAMP NULL,                   -- When key should be removed from zone

    -- Key rollover tracking
    predecessor_id INT UNSIGNED NULL,           -- Previous key in rollover
    successor_id INT UNSIGNED NULL,             -- Next key in rollover

    -- Indexes
    INDEX idx_zone (zone_id),
    INDEX idx_key_tag (key_tag),
    INDEX idx_status (status),
    INDEX idx_type (key_type),

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE,
    FOREIGN KEY (predecessor_id) REFERENCES dnssec_keys(id) ON DELETE SET NULL,
    FOREIGN KEY (successor_id) REFERENCES dnssec_keys(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNSSEC zone signing keys';

-- ============================================================================
-- 2. DNSSEC Zone Configuration
-- ============================================================================
-- Per-zone DNSSEC settings

CREATE TABLE IF NOT EXISTS dnssec_config (
    zone_id INT UNSIGNED PRIMARY KEY,

    -- DNSSEC enablement
    dnssec_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    -- Signing policy
    nsec_mode ENUM('NSEC', 'NSEC3') NOT NULL DEFAULT 'NSEC3',
    nsec3_iterations INT UNSIGNED DEFAULT 10,   -- NSEC3 hash iterations (0-150 recommended)
    nsec3_salt_length INT UNSIGNED DEFAULT 8,   -- NSEC3 salt length in bytes
    nsec3_salt VARCHAR(64),                     -- Current NSEC3 salt (hex)

    -- Signature parameters
    signature_validity INT UNSIGNED DEFAULT 2592000,  -- 30 days in seconds
    signature_refresh INT UNSIGNED DEFAULT 604800,    -- Re-sign 7 days before expiry
    signature_jitter INT UNSIGNED DEFAULT 86400,      -- Random jitter (±1 day)

    -- Algorithm preferences
    preferred_algorithm INT UNSIGNED DEFAULT 13,  -- 13 = ECDSAP256SHA256
    -- Algorithm choices:
    -- 8  = RSASHA256 (widely supported)
    -- 10 = RSASHA512 (more secure RSA)
    -- 13 = ECDSAP256SHA256 (recommended, smaller keys)
    -- 14 = ECDSAP384SHA384 (most secure ECDSA)
    -- 15 = ED25519 (newest, fastest, smallest)
    -- 16 = ED448 (most secure EdDSA)

    -- Key rollover settings
    zsk_lifetime INT UNSIGNED DEFAULT 2592000,        -- 30 days
    ksk_lifetime INT UNSIGNED DEFAULT 31536000,       -- 365 days
    auto_rollover BOOLEAN NOT NULL DEFAULT TRUE,

    -- DS records (for parent zone)
    ds_seen_in_parent BOOLEAN NOT NULL DEFAULT FALSE,
    parent_check_time TIMESTAMP NULL,

    -- Automatic operations
    auto_sign BOOLEAN NOT NULL DEFAULT TRUE,          -- Sign zone automatically
    auto_nsec BOOLEAN NOT NULL DEFAULT TRUE,          -- Generate NSEC/NSEC3 automatically

    -- Statistics
    last_signed TIMESTAMP NULL,
    last_nsec_generated TIMESTAMP NULL,
    signature_count INT UNSIGNED DEFAULT 0,

    -- Audit
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNSSEC per-zone configuration';

-- ============================================================================
-- 3. DNSSEC Signature Cache
-- ============================================================================
-- Caches generated RRSIGs to avoid re-signing on every query
-- RRSIGs are regenerated when records change or signatures expire

CREATE TABLE IF NOT EXISTS dnssec_signatures (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    -- What's being signed
    zone_id INT UNSIGNED NOT NULL,
    rrset_name VARCHAR(255) NOT NULL,           -- Name of the RRset
    rrset_type ENUM('A','AAAA','CAA','CERT','CNAME','DNAME','DNSKEY','DS','HINFO',
                    'HTTPS','LOC','MX','NAPTR','NS','PTR','RP','SRV','SSHFP',
                    'SVCB','TLSA','TXT','URI') NOT NULL,
    rrset_class ENUM('IN') NOT NULL DEFAULT 'IN',

    -- The signature (RRSIG record)
    rrsig_data TEXT NOT NULL,                   -- Wire format RRSIG (base64)

    -- Signature metadata
    key_tag INT UNSIGNED NOT NULL,              -- Which key signed this
    algorithm INT UNSIGNED NOT NULL,
    labels INT UNSIGNED NOT NULL,               -- Number of labels in signed name
    original_ttl INT UNSIGNED NOT NULL,
    signature_expiration INT UNSIGNED NOT NULL, -- Unix timestamp
    signature_inception INT UNSIGNED NOT NULL,  -- Unix timestamp

    -- Cache management
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,              -- When to regenerate
    rrset_hash VARCHAR(64) NOT NULL,            -- Hash of RRset data to detect changes

    -- Indexes
    INDEX idx_zone (zone_id),
    INDEX idx_lookup (zone_id, rrset_name, rrset_type),
    INDEX idx_expires (expires_at),
    INDEX idx_key (key_tag),
    INDEX idx_hash (rrset_hash),

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE,
    FOREIGN KEY (key_tag) REFERENCES dnssec_keys(key_tag) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNSSEC RRSIG signature cache';

-- ============================================================================
-- 4. NSEC3 Chain Cache
-- ============================================================================
-- Pre-computed NSEC3 records for authenticated denial of existence

CREATE TABLE IF NOT EXISTS dnssec_nsec3 (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    zone_id INT UNSIGNED NOT NULL,

    -- NSEC3 record data
    hash_name VARCHAR(64) NOT NULL,             -- Base32hex of NSEC3 hash
    next_hash VARCHAR(64) NOT NULL,             -- Next hash in chain
    types_bitmap BLOB NOT NULL,                 -- Bitmap of RR types present

    -- NSEC3 parameters
    hash_algorithm INT UNSIGNED NOT NULL DEFAULT 1,  -- 1 = SHA-1
    flags INT UNSIGNED NOT NULL DEFAULT 0,
    iterations INT UNSIGNED NOT NULL,
    salt VARCHAR(64),

    -- Original owner name (for reference)
    original_name VARCHAR(255),

    -- Cache management
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMP NOT NULL,

    -- Indexes
    INDEX idx_zone (zone_id),
    INDEX idx_hash (hash_name),
    INDEX idx_valid (valid_until),
    UNIQUE KEY uk_zone_hash (zone_id, hash_name),

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNSSEC NSEC3 chain cache';

-- ============================================================================
-- 5. DNSSEC Signing Queue
-- ============================================================================
-- Tracks which zones/RRsets need signing or re-signing

CREATE TABLE IF NOT EXISTS dnssec_signing_queue (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    zone_id INT UNSIGNED NOT NULL,
    rrset_name VARCHAR(255),                    -- NULL = sign entire zone
    rrset_type VARCHAR(20),                     -- NULL = sign entire zone

    reason ENUM('new_record', 'record_updated', 'record_deleted',
                'signature_expiring', 'key_rollover', 'manual',
                'nsec_update') NOT NULL,

    priority INT NOT NULL DEFAULT 5,            -- 1=highest, 10=lowest
    status ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',

    -- Processing
    attempts INT UNSIGNED DEFAULT 0,
    last_attempt TIMESTAMP NULL,
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,

    -- Indexes
    INDEX idx_zone (zone_id),
    INDEX idx_status (status),
    INDEX idx_priority (priority, created_at),
    INDEX idx_pending (status, priority, created_at),

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNSSEC signing work queue';

-- ============================================================================
-- 6. DNSSEC Audit Log
-- ============================================================================
-- Tracks all DNSSEC operations for compliance and debugging

CREATE TABLE IF NOT EXISTS dnssec_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    zone_id INT UNSIGNED NOT NULL,
    operation ENUM('key_generated', 'key_published', 'key_activated',
                   'key_retired', 'key_deleted', 'zone_signed',
                   'rrset_signed', 'nsec_generated', 'nsec3_generated',
                   'signature_validated', 'signature_failed',
                   'rollover_started', 'rollover_completed') NOT NULL,

    -- Details
    key_tag INT UNSIGNED,
    rrset_name VARCHAR(255),
    rrset_type VARCHAR(20),

    success BOOLEAN NOT NULL DEFAULT TRUE,
    details TEXT,
    error_message TEXT,

    -- Timestamps
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_zone (zone_id),
    INDEX idx_operation (operation),
    INDEX idx_timestamp (timestamp),
    INDEX idx_success (success),

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNSSEC operations audit log';

-- ============================================================================
-- 7. Stored Procedures for DNSSEC Management
-- ============================================================================

DELIMITER //

-- Enable DNSSEC for a zone with recommended defaults
CREATE PROCEDURE IF NOT EXISTS enable_zone_dnssec(
    IN p_zone_id INT UNSIGNED,
    IN p_algorithm INT UNSIGNED,
    IN p_nsec_mode ENUM('NSEC', 'NSEC3')
)
BEGIN
    -- Insert or update config
    INSERT INTO dnssec_config (
        zone_id, dnssec_enabled, nsec_mode, preferred_algorithm,
        signature_validity, signature_refresh, auto_sign, auto_nsec
    ) VALUES (
        p_zone_id, TRUE, p_nsec_mode, p_algorithm,
        2592000, 604800, TRUE, TRUE
    ) ON DUPLICATE KEY UPDATE
        dnssec_enabled = TRUE,
        nsec_mode = p_nsec_mode,
        preferred_algorithm = p_algorithm,
        updated_at = CURRENT_TIMESTAMP;

    -- Log the operation
    INSERT INTO dnssec_log (zone_id, operation, success, details)
    VALUES (p_zone_id, 'zone_signed', TRUE,
            CONCAT('DNSSEC enabled with algorithm ', p_algorithm, ' and ', p_nsec_mode));
END //

-- Disable DNSSEC for a zone
CREATE PROCEDURE IF NOT EXISTS disable_zone_dnssec(
    IN p_zone_id INT UNSIGNED
)
BEGIN
    UPDATE dnssec_config
    SET dnssec_enabled = FALSE, updated_at = CURRENT_TIMESTAMP
    WHERE zone_id = p_zone_id;

    -- Don't delete keys - they might be needed for rollback
    -- Just mark them as retired
    UPDATE dnssec_keys
    SET status = 'retired'
    WHERE zone_id = p_zone_id AND status = 'active';

    -- Clear signature cache
    DELETE FROM dnssec_signatures WHERE zone_id = p_zone_id;
    DELETE FROM dnssec_nsec3 WHERE zone_id = p_zone_id;

    INSERT INTO dnssec_log (zone_id, operation, success, details)
    VALUES (p_zone_id, 'zone_signed', TRUE, 'DNSSEC disabled for zone');
END //

-- Queue zone for signing (called when records change)
CREATE PROCEDURE IF NOT EXISTS queue_zone_signing(
    IN p_zone_id INT UNSIGNED,
    IN p_reason VARCHAR(50),
    IN p_priority INT
)
BEGIN
    INSERT INTO dnssec_signing_queue (zone_id, reason, priority, status)
    VALUES (p_zone_id, p_reason, p_priority, 'pending')
    ON DUPLICATE KEY UPDATE
        priority = LEAST(priority, p_priority),
        status = 'pending',
        created_at = CURRENT_TIMESTAMP;
END //

-- Clean up expired signatures
CREATE PROCEDURE IF NOT EXISTS cleanup_expired_signatures()
BEGIN
    DECLARE v_deleted INT;

    -- Delete expired signatures
    DELETE FROM dnssec_signatures WHERE expires_at < NOW();
    SET v_deleted = ROW_COUNT();

    -- Delete expired NSEC3 records
    DELETE FROM dnssec_nsec3 WHERE valid_until < NOW();

    -- Clean up old completed queue entries (keep for 7 days)
    DELETE FROM dnssec_signing_queue
    WHERE status = 'completed' AND completed_at < DATE_SUB(NOW(), INTERVAL 7 DAY);

    -- Clean up old log entries (keep for 90 days)
    DELETE FROM dnssec_log WHERE timestamp < DATE_SUB(NOW(), INTERVAL 90 DAY);

    SELECT CONCAT('Cleaned up ', v_deleted, ' expired signatures') AS result;
END //

DELIMITER ;

-- ============================================================================
-- 8. Views for Easy Monitoring
-- ============================================================================

-- View of DNSSEC-enabled zones with their current status
CREATE OR REPLACE VIEW v_dnssec_status AS
SELECT
    s.id AS zone_id,
    s.origin AS zone_name,
    dc.dnssec_enabled,
    dc.nsec_mode,
    dc.preferred_algorithm,
    dc.auto_sign,
    dc.last_signed,
    COUNT(DISTINCT dk.id) AS key_count,
    COUNT(DISTINCT CASE WHEN dk.status = 'active' THEN dk.id END) AS active_keys,
    COUNT(DISTINCT CASE WHEN dk.key_type = 'KSK' AND dk.status = 'active' THEN dk.id END) AS ksk_count,
    COUNT(DISTINCT CASE WHEN dk.key_type = 'ZSK' AND dk.status = 'active' THEN dk.id END) AS zsk_count,
    dc.signature_count,
    dc.ds_seen_in_parent,
    dc.updated_at
FROM soa s
LEFT JOIN dnssec_config dc ON dc.zone_id = s.id
LEFT JOIN dnssec_keys dk ON dk.zone_id = s.id
GROUP BY s.id, s.origin, dc.dnssec_enabled, dc.nsec_mode, dc.preferred_algorithm,
         dc.auto_sign, dc.last_signed, dc.signature_count, dc.ds_seen_in_parent, dc.updated_at;

-- View of keys needing attention
CREATE OR REPLACE VIEW v_dnssec_keys_attention AS
SELECT
    dk.id,
    dk.zone_id,
    s.origin AS zone_name,
    dk.key_type,
    dk.key_tag,
    dk.algorithm,
    dk.status,
    dk.created_at,
    dk.retire_at,
    dk.remove_at,
    CASE
        WHEN dk.retire_at < NOW() THEN 'EXPIRED'
        WHEN dk.retire_at < DATE_ADD(NOW(), INTERVAL 7 DAY) THEN 'EXPIRING_SOON'
        WHEN dk.status = 'published' AND dk.activate_at < NOW() THEN 'READY_TO_ACTIVATE'
        ELSE 'OK'
    END AS attention_reason
FROM dnssec_keys dk
JOIN soa s ON s.id = dk.zone_id
WHERE dk.status IN ('active', 'published')
  AND (dk.retire_at < DATE_ADD(NOW(), INTERVAL 7 DAY)
       OR (dk.status = 'published' AND dk.activate_at < NOW()));

-- View of pending signing work
CREATE OR REPLACE VIEW v_dnssec_signing_pending AS
SELECT
    dsq.id,
    dsq.zone_id,
    s.origin AS zone_name,
    dsq.rrset_name,
    dsq.rrset_type,
    dsq.reason,
    dsq.priority,
    dsq.status,
    dsq.attempts,
    dsq.created_at,
    TIMESTAMPDIFF(SECOND, dsq.created_at, NOW()) AS age_seconds
FROM dnssec_signing_queue dsq
JOIN soa s ON s.id = dsq.zone_id
WHERE dsq.status IN ('pending', 'processing')
ORDER BY dsq.priority ASC, dsq.created_at ASC;

-- ============================================================================
-- 9. Triggers to Auto-Queue Signing
-- ============================================================================

-- Trigger when RR records are inserted
DELIMITER //
CREATE TRIGGER IF NOT EXISTS trg_rr_insert_dnssec_queue
AFTER INSERT ON rr
FOR EACH ROW
BEGIN
    -- Check if zone has DNSSEC enabled
    IF EXISTS (SELECT 1 FROM dnssec_config WHERE zone_id = NEW.zone AND dnssec_enabled = TRUE) THEN
        -- Queue the specific RRset for signing
        INSERT INTO dnssec_signing_queue (zone_id, rrset_name, rrset_type, reason, priority)
        VALUES (NEW.zone, NEW.name, NEW.type, 'new_record', 3)
        ON DUPLICATE KEY UPDATE
            priority = LEAST(priority, 3),
            status = 'pending',
            created_at = CURRENT_TIMESTAMP;
    END IF;
END //

-- Trigger when RR records are updated
CREATE TRIGGER IF NOT EXISTS trg_rr_update_dnssec_queue
AFTER UPDATE ON rr
FOR EACH ROW
BEGIN
    -- Check if zone has DNSSEC enabled
    IF EXISTS (SELECT 1 FROM dnssec_config WHERE zone_id = NEW.zone AND dnssec_enabled = TRUE) THEN
        -- Queue the specific RRset for signing
        INSERT INTO dnssec_signing_queue (zone_id, rrset_name, rrset_type, reason, priority)
        VALUES (NEW.zone, NEW.name, NEW.type, 'record_updated', 3)
        ON DUPLICATE KEY UPDATE
            priority = LEAST(priority, 3),
            status = 'pending',
            created_at = CURRENT_TIMESTAMP;

        -- Also invalidate existing signatures for this RRset
        DELETE FROM dnssec_signatures
        WHERE zone_id = NEW.zone AND rrset_name = NEW.name AND rrset_type = NEW.type;
    END IF;
END //

-- Trigger when RR records are deleted
CREATE TRIGGER IF NOT EXISTS trg_rr_delete_dnssec_queue
AFTER DELETE ON rr
FOR EACH ROW
BEGIN
    -- Check if zone has DNSSEC enabled
    IF EXISTS (SELECT 1 FROM dnssec_config WHERE zone_id = OLD.zone AND dnssec_enabled = TRUE) THEN
        -- Queue the specific RRset for signing (to remove RRSIG)
        INSERT INTO dnssec_signing_queue (zone_id, rrset_name, rrset_type, reason, priority)
        VALUES (OLD.zone, OLD.name, OLD.type, 'record_deleted', 2)
        ON DUPLICATE KEY UPDATE
            priority = LEAST(priority, 2),
            status = 'pending',
            created_at = CURRENT_TIMESTAMP;

        -- Delete existing signatures for this RRset
        DELETE FROM dnssec_signatures
        WHERE zone_id = OLD.zone AND rrset_name = OLD.name AND rrset_type = OLD.type;
    END IF;
END //

DELIMITER ;

-- ============================================================================
-- Installation Complete
-- ============================================================================
-- DNSSEC schema installed successfully.
--
-- Next steps:
-- 1. Generate keys: Call enable_zone_dnssec(zone_id, algorithm, nsec_mode)
-- 2. Compile mydns with DNSSEC support
-- 3. Configure dnssec-enabled = yes in mydns.conf
-- 4. Use signing tools to generate initial signatures
--
-- Monitor with:
--   SELECT * FROM v_dnssec_status;
--   SELECT * FROM v_dnssec_keys_attention;
--   SELECT * FROM v_dnssec_signing_pending;
