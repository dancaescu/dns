--
-- TSIG (Transaction Signatures) Schema for MyDNS
-- Date: 2025-11-26
--
-- Implements RFC 2845 - Secret Key Transaction Authentication for DNS (TSIG)
-- Provides cryptographic authentication for zone transfers and dynamic updates
--

-- TSIG Keys Table
CREATE TABLE IF NOT EXISTS tsig_keys (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL COMMENT 'Key name (e.g., transfer-key.example.com.)',
    algorithm VARCHAR(50) NOT NULL DEFAULT 'hmac-sha256' COMMENT 'HMAC algorithm',
    secret TEXT NOT NULL COMMENT 'Base64-encoded shared secret',

    -- Usage permissions
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    allow_axfr BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Allow zone transfers',
    allow_update BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Allow dynamic updates',
    allow_query BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Allow queries',

    -- Access control
    allowed_zones TEXT NULL COMMENT 'Comma-separated list of zones, NULL = all zones',
    allowed_ips TEXT NULL COMMENT 'Comma-separated list of IPs, NULL = any',

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_used TIMESTAMP NULL,
    use_count INT UNSIGNED NOT NULL DEFAULT 0,

    -- Indexes
    UNIQUE KEY unique_key_name (name),
    INDEX idx_enabled (enabled),
    INDEX idx_algorithm (algorithm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='TSIG keys for DNS authentication';

-- Link TSIG keys to zone_masters for authenticated transfers
ALTER TABLE zone_masters
ADD COLUMN IF NOT EXISTS tsig_key_id INT UNSIGNED NULL COMMENT 'TSIG key for authenticated transfers',
ADD FOREIGN KEY (tsig_key_id) REFERENCES tsig_keys(id) ON DELETE SET NULL;

-- TSIG Usage Log
CREATE TABLE IF NOT EXISTS tsig_usage_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    key_id INT UNSIGNED NOT NULL,
    key_name VARCHAR(255) NOT NULL,

    -- Request details
    operation ENUM('AXFR', 'IXFR', 'UPDATE', 'QUERY', 'NOTIFY') NOT NULL,
    zone VARCHAR(255) NULL,
    source_ip VARCHAR(45) NOT NULL,

    -- Result
    success BOOLEAN NOT NULL,
    error_code INT NULL,
    error_message VARCHAR(255) NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_key_id (key_id),
    INDEX idx_created_at (created_at),
    INDEX idx_operation (operation),
    INDEX idx_success (success),
    FOREIGN KEY (key_id) REFERENCES tsig_keys(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='TSIG authentication usage log';

-- Stored procedure to create TSIG key
DELIMITER $$

DROP PROCEDURE IF EXISTS create_tsig_key$$
CREATE PROCEDURE create_tsig_key(
    IN p_name VARCHAR(255),
    IN p_algorithm VARCHAR(50),
    IN p_secret TEXT,
    IN p_allow_axfr BOOLEAN,
    IN p_allow_update BOOLEAN
)
BEGIN
    INSERT INTO tsig_keys (name, algorithm, secret, allow_axfr, allow_update, enabled)
    VALUES (p_name, p_algorithm, p_secret, p_allow_axfr, p_allow_update, TRUE);

    SELECT LAST_INSERT_ID() AS key_id, 'TSIG key created successfully' AS message;
END$$

DELIMITER ;

-- Generate random TSIG secret (run in shell, not SQL)
-- openssl rand -base64 32

-- Example usage:
/*

-- 1. Generate a secret key (run in shell):
openssl rand -base64 32
-- Example output: xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==

-- 2. Create TSIG key for zone transfers:
CALL create_tsig_key(
    'transfer-key.example.com.',
    'hmac-sha256',
    'xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==',
    TRUE,   -- allow_axfr
    FALSE   -- allow_update
);

-- 3. Associate key with zone master:
UPDATE zone_masters
SET tsig_key_id = (SELECT id FROM tsig_keys WHERE name = 'transfer-key.example.com.')
WHERE zone_id = 123;

-- 4. View TSIG keys:
SELECT
    id,
    name,
    algorithm,
    enabled,
    allow_axfr,
    allow_update,
    use_count,
    last_used
FROM tsig_keys
WHERE enabled = TRUE;

-- 5. View TSIG usage:
SELECT
    tul.id,
    tul.key_name,
    tul.operation,
    tul.zone,
    tul.source_ip,
    tul.success,
    tul.error_message,
    tul.created_at
FROM tsig_usage_log tul
ORDER BY tul.created_at DESC
LIMIT 50;

-- 6. View authenticated zone transfers:
SELECT
    s.origin AS zone_name,
    zm.master_host,
    tk.name AS tsig_key,
    tk.algorithm,
    zm.last_transfer
FROM soa s
JOIN zone_masters zm ON zm.zone_id = s.id
LEFT JOIN tsig_keys tk ON tk.id = zm.tsig_key_id
WHERE s.slave_mode = TRUE;

-- 7. Disable a TSIG key:
UPDATE tsig_keys SET enabled = FALSE WHERE name = 'old-key.example.com.';

-- 8. Rotate TSIG key (update secret):
UPDATE tsig_keys
SET secret = 'NEW_BASE64_SECRET_HERE',
    updated_at = NOW()
WHERE name = 'transfer-key.example.com.';

*/

-- View for TSIG key status
CREATE OR REPLACE VIEW v_tsig_key_status AS
SELECT
    tk.id,
    tk.name,
    tk.algorithm,
    tk.enabled,
    tk.allow_axfr,
    tk.allow_update,
    tk.allow_query,
    tk.use_count,
    tk.last_used,
    tk.created_at,
    (SELECT COUNT(*) FROM zone_masters WHERE tsig_key_id = tk.id) AS zones_using_key,
    CASE
        WHEN tk.enabled = FALSE THEN 'DISABLED'
        WHEN tk.last_used IS NULL THEN 'NEVER_USED'
        WHEN TIMESTAMPDIFF(DAY, tk.last_used, NOW()) > 30 THEN 'INACTIVE'
        ELSE 'ACTIVE'
    END AS status
FROM tsig_keys tk;

-- View for recent TSIG activity
CREATE OR REPLACE VIEW v_recent_tsig_activity AS
SELECT
    tul.id,
    tul.key_name,
    tul.operation,
    tul.zone,
    tul.source_ip,
    tul.success,
    tul.error_message,
    tul.created_at,
    TIMESTAMPDIFF(SECOND, tul.created_at, NOW()) AS seconds_ago
FROM tsig_usage_log tul
WHERE tul.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
ORDER BY tul.created_at DESC;

COMMIT;

-- Configuration notes:
--
-- Supported algorithms (in order of preference):
-- - hmac-sha512: Most secure, 64-byte keys
-- - hmac-sha384: Very secure, 48-byte keys
-- - hmac-sha256: Secure, 32-byte keys (recommended)
-- - hmac-sha224: Secure, 28-byte keys
-- - hmac-sha1: Less secure, 20-byte keys (legacy)
-- - hmac-md5: Deprecated, 16-byte keys (legacy only)
--
-- Key generation:
-- - SHA256: openssl rand -base64 32
-- - SHA512: openssl rand -base64 64
--
-- BIND configuration example:
-- key "transfer-key.example.com." {
--     algorithm hmac-sha256;
--     secret "xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==";
-- };
--
-- server 10.1.1.2 {  /* MyDNS slave */
--     keys { transfer-key.example.com.; };
-- };
--
-- zone "example.com" {
--     type master;
--     file "/etc/bind/zones/db.example.com";
--     allow-transfer { key transfer-key.example.com.; };
-- };
--
