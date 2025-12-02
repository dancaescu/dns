--
-- DNS UPDATE (RFC 2136) Schema for MyDNS
-- Date: 2025-11-26
--
-- Implements dynamic DNS update access control and logging
--

-- DNS UPDATE Access Control List
CREATE TABLE IF NOT EXISTS update_acl (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone VARCHAR(255) NOT NULL COMMENT 'Zone name (e.g., example.com.)',

    -- Authentication
    key_name VARCHAR(255) NULL COMMENT 'Required TSIG key name, NULL = no auth',

    -- IP-based access control
    allowed_ips TEXT NULL COMMENT 'Comma-separated list of allowed IPs, NULL = any',
    allowed_networks TEXT NULL COMMENT 'Comma-separated CIDR blocks, NULL = any',

    -- Operation permissions
    allow_add BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Allow adding records',
    allow_delete BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Allow deleting records',
    allow_update BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Allow updating records',

    -- Metadata
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_zone (zone),
    INDEX idx_enabled (enabled),
    FOREIGN KEY (key_name) REFERENCES tsig_keys(name) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNS UPDATE access control';

-- DNS UPDATE Operation Log
CREATE TABLE IF NOT EXISTS update_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- Request info
    zone VARCHAR(255) NOT NULL,
    source_ip VARCHAR(45) NOT NULL,
    key_name VARCHAR(255) NULL COMMENT 'TSIG key used, if any',

    -- Operation details
    operation_type ENUM('ADD', 'DELETE', 'DELETE_ALL', 'DELETE_NAME') NOT NULL,
    record_name VARCHAR(255) NOT NULL,
    record_type VARCHAR(10) NOT NULL,
    record_data TEXT NULL,
    ttl INT UNSIGNED NULL,

    -- Prerequisites
    had_prerequisites BOOLEAN NOT NULL DEFAULT FALSE,
    prereq_passed BOOLEAN NULL COMMENT 'NULL if no prereqs',

    -- Result
    success BOOLEAN NOT NULL,
    rcode INT NOT NULL COMMENT 'DNS UPDATE response code',
    error_message VARCHAR(255) NULL,
    new_serial INT UNSIGNED NULL COMMENT 'New SOA serial after update',

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_zone (zone),
    INDEX idx_source_ip (source_ip),
    INDEX idx_created_at (created_at),
    INDEX idx_success (success),
    INDEX idx_operation (operation_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNS UPDATE operation log';

-- View for recent UPDATE activity
CREATE OR REPLACE VIEW v_recent_updates AS
SELECT
    ul.id,
    ul.zone,
    ul.source_ip,
    ul.key_name,
    ul.operation_type,
    ul.record_name,
    ul.record_type,
    ul.record_data,
    ul.success,
    ul.rcode,
    ul.error_message,
    ul.new_serial,
    ul.created_at,
    TIMESTAMPDIFF(SECOND, ul.created_at, NOW()) AS seconds_ago
FROM update_log ul
WHERE ul.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
ORDER BY ul.created_at DESC;

-- View for UPDATE statistics by zone
CREATE OR REPLACE VIEW v_update_stats_by_zone AS
SELECT
    zone,
    COUNT(*) AS total_updates,
    SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) AS successful_updates,
    SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) AS failed_updates,
    SUM(CASE WHEN operation_type = 'ADD' THEN 1 ELSE 0 END) AS add_operations,
    SUM(CASE WHEN operation_type = 'DELETE' THEN 1 ELSE 0 END) AS delete_operations,
    MIN(created_at) AS first_update,
    MAX(created_at) AS last_update
FROM update_log
GROUP BY zone;

-- View for UPDATE ACL status
CREATE OR REPLACE VIEW v_update_acl_status AS
SELECT
    acl.id,
    acl.zone,
    acl.key_name,
    acl.allowed_ips,
    acl.allowed_networks,
    acl.allow_add,
    acl.allow_delete,
    acl.allow_update,
    acl.enabled,
    (SELECT COUNT(*) FROM update_log WHERE zone = acl.zone) AS total_updates,
    (SELECT MAX(created_at) FROM update_log WHERE zone = acl.zone) AS last_update
FROM update_acl acl;

COMMIT;

-- Example usage:

/*

-- 1. Create UPDATE ACL for a zone (no authentication)
INSERT INTO update_acl (zone, key_name, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('example.com.', NULL, '10.1.1.100,10.1.1.101', TRUE, TRUE, TRUE, TRUE);

-- 2. Create UPDATE ACL with TSIG authentication
INSERT INTO update_acl (zone, key_name, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('secure.example.com.', 'update-key.example.com.', '10.1.1.0/24', TRUE, TRUE, TRUE, TRUE);

-- 3. Create UPDATE ACL (any IP, read-only - no delete)
INSERT INTO update_acl (zone, key_name, allowed_ips, allow_add, allow_delete, allow_update, enabled)
VALUES ('public.example.com.', NULL, NULL, TRUE, FALSE, FALSE, TRUE);

-- 4. View UPDATE ACLs
SELECT
    id,
    zone,
    key_name,
    allowed_ips,
    allow_add,
    allow_delete,
    allow_update,
    enabled
FROM update_acl
WHERE enabled = TRUE
ORDER BY zone;

-- 5. View recent UPDATE operations
SELECT
    zone,
    source_ip,
    key_name,
    operation_type,
    record_name,
    record_type,
    success,
    error_message,
    created_at
FROM v_recent_updates
LIMIT 50;

-- 6. View UPDATE statistics
SELECT * FROM v_update_stats_by_zone;

-- 7. View failed UPDATE attempts
SELECT
    zone,
    source_ip,
    operation_type,
    record_name,
    rcode,
    error_message,
    created_at
FROM update_log
WHERE success = FALSE
ORDER BY created_at DESC
LIMIT 20;

-- 8. Enable/disable UPDATE for a zone
UPDATE update_acl SET enabled = FALSE WHERE zone = 'example.com.';
UPDATE update_acl SET enabled = TRUE WHERE zone = 'example.com.';

-- 9. Change UPDATE permissions
UPDATE update_acl
SET allow_add = TRUE, allow_delete = FALSE, allow_update = FALSE
WHERE zone = 'readonly.example.com.';

-- 10. Delete old UPDATE logs (cleanup)
DELETE FROM update_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

*/

-- Configuration notes:
--
-- TSIG Integration:
-- - If key_name is set, UPDATE requests MUST include valid TSIG signature
-- - If key_name is NULL, IP-based authentication only
-- - Combine TSIG + IP restrictions for maximum security
--
-- IP Access Control:
-- - allowed_ips: Exact IP matches (e.g., "10.1.1.100,10.1.1.101")
-- - allowed_networks: CIDR blocks (e.g., "10.1.1.0/24,192.168.1.0/24")
-- - NULL = any IP allowed (not recommended for production)
--
-- Operation Permissions:
-- - allow_add: Allow adding new records
-- - allow_delete: Allow deleting specific records
-- - allow_update: Allow modifying existing records
-- - Can mix permissions (e.g., add-only, delete-only)
--
-- Security Best Practices:
-- 1. Always use TSIG authentication for public-facing servers
-- 2. Restrict by IP/network when possible
-- 3. Use separate ACLs for different zones
-- 4. Regularly audit update_log for suspicious activity
-- 5. Set appropriate operation permissions (principle of least privilege)
-- 6. Monitor failed UPDATE attempts (potential attacks)
--
-- Testing with nsupdate:
--
-- Without TSIG:
-- $ nsupdate
-- > server 10.1.1.2
-- > zone example.com.
-- > update add test.example.com. 300 A 1.2.3.4
-- > send
--
-- With TSIG:
-- $ nsupdate -k /path/to/key.conf
-- > server 10.1.1.2
-- > zone secure.example.com.
-- > update add test.secure.example.com. 300 A 1.2.3.4
-- > send
--
-- Key configuration file (key.conf):
-- key "update-key.example.com." {
--     algorithm hmac-sha256;
--     secret "xQzVKjM8sP9wN3R5tL7yC2dF6hJ9kM1nQ4xW8vB0zA==";
-- };
--
