--
-- MyDNS AXFR Slave Schema
-- Date: 2025-11-26
--
-- Additional tables required for MyDNS to act as an AXFR slave
-- Run this script on your MyDNS database to add slave functionality
--

-- Zone Masters Configuration
-- Defines which master servers to transfer zones from
CREATE TABLE IF NOT EXISTS zone_masters (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,
    master_host VARCHAR(255) NOT NULL,
    master_port INT UNSIGNED NOT NULL DEFAULT 53,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    -- Transfer settings
    transfer_interval INT UNSIGNED NOT NULL DEFAULT 300 COMMENT 'Seconds between checks',
    retry_interval INT UNSIGNED NOT NULL DEFAULT 60 COMMENT 'Seconds between retries on failure',
    max_failures INT UNSIGNED NOT NULL DEFAULT 10 COMMENT 'Max consecutive failures before disabling',

    -- TSIG authentication (optional)
    tsig_key_name VARCHAR(255) NULL,
    tsig_key_secret VARCHAR(255) NULL,
    tsig_algorithm VARCHAR(50) NULL DEFAULT 'hmac-md5',

    -- Status tracking
    last_check TIMESTAMP NULL,
    last_transfer TIMESTAMP NULL,
    last_notify TIMESTAMP NULL COMMENT 'Last NOTIFY received from master',
    transfer_failures INT UNSIGNED NOT NULL DEFAULT 0,
    last_error TEXT NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Constraints
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE,
    INDEX idx_zone_id (zone_id),
    INDEX idx_enabled (enabled),
    INDEX idx_last_check (last_check),
    UNIQUE KEY unique_zone_master (zone_id, master_host)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Master servers for AXFR zone transfers';

-- Zone Transfer Log
-- Logs all zone transfer attempts for monitoring and troubleshooting
CREATE TABLE IF NOT EXISTS zone_transfer_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,
    master_host VARCHAR(255) NOT NULL,

    -- Transfer details
    status INT NOT NULL COMMENT '0=success, negative=error code',
    records_received INT UNSIGNED NOT NULL DEFAULT 0,
    records_added INT UNSIGNED NOT NULL DEFAULT 0,
    records_updated INT UNSIGNED NOT NULL DEFAULT 0,
    records_deleted INT UNSIGNED NOT NULL DEFAULT 0,

    -- Timing
    transfer_time BIGINT NOT NULL DEFAULT 0 COMMENT 'Transfer duration in seconds',
    transfer_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Error information
    error_message TEXT NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_zone_id (zone_id),
    INDEX idx_transfer_start (transfer_start),
    INDEX idx_status (status),
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Zone transfer activity log';

-- Add slave_mode flag to soa table (optional)
-- Indicates whether this zone should be transferred from masters
ALTER TABLE soa ADD COLUMN IF NOT EXISTS slave_mode BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'TRUE if zone is slave (transferred from master)';

ALTER TABLE soa ADD COLUMN IF NOT EXISTS master_updated TIMESTAMP NULL
    COMMENT 'Last update from master server';

-- Example: Configure a zone to be a slave
-- This tells mydns-xfer to transfer example.com from a master server

/*
-- 1. Create the zone in soa table (if it doesn't exist)
INSERT INTO soa (origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, slave_mode)
VALUES ('example.com.', 'ns1.example.com.', 'admin.example.com.', 1, 3600, 600, 86400, 3600, 3600, 'Y', TRUE);

-- 2. Configure the master server
INSERT INTO zone_masters (zone_id, master_host, master_port, enabled, transfer_interval)
SELECT id, 'master-ns.example.com', 53, TRUE, 300
FROM soa WHERE origin = 'example.com.' LIMIT 1;

-- 3. Run mydns-xfer to perform the transfer
-- $ mydns-xfer -z <zone_id>

-- 4. View transfer logs
SELECT
    ztl.id,
    s.origin AS zone_name,
    ztl.master_host,
    CASE
        WHEN ztl.status = 0 THEN 'SUCCESS'
        WHEN ztl.status = -1 THEN 'ERROR'
        WHEN ztl.status = -2 THEN 'NETWORK_ERROR'
        WHEN ztl.status = -3 THEN 'PARSE_ERROR'
        WHEN ztl.status = -4 THEN 'DATABASE_ERROR'
        WHEN ztl.status = -5 THEN 'AUTH_ERROR'
        WHEN ztl.status = -6 THEN 'TIMEOUT'
        ELSE 'UNKNOWN'
    END AS status_text,
    ztl.records_received,
    ztl.records_added,
    ztl.transfer_time,
    ztl.transfer_start,
    ztl.error_message
FROM zone_transfer_log ztl
JOIN soa s ON s.id = ztl.zone_id
ORDER BY ztl.transfer_start DESC
LIMIT 20;

-- 5. Check master configuration status
SELECT
    zm.id,
    s.origin AS zone_name,
    zm.master_host,
    zm.master_port,
    zm.enabled,
    zm.last_check,
    zm.last_transfer,
    zm.transfer_failures,
    TIMESTAMPDIFF(SECOND, zm.last_transfer, NOW()) AS seconds_since_transfer
FROM zone_masters zm
JOIN soa s ON s.id = zm.zone_id
WHERE zm.enabled = TRUE;

-- 6. Configure multiple masters for redundancy
INSERT INTO zone_masters (zone_id, master_host, master_port, enabled)
SELECT id, 'master-ns1.example.com', 53, TRUE FROM soa WHERE origin = 'example.com.' LIMIT 1;

INSERT INTO zone_masters (zone_id, master_host, master_port, enabled)
SELECT id, 'master-ns2.example.com', 53, TRUE FROM soa WHERE origin = 'example.com.' LIMIT 1;

-- 7. Configure TSIG authentication (optional)
UPDATE zone_masters
SET
    tsig_key_name = 'example-transfer-key',
    tsig_key_secret = 'base64encodedkeyhere==',
    tsig_algorithm = 'hmac-sha256'
WHERE zone_id = (SELECT id FROM soa WHERE origin = 'example.com.' LIMIT 1);
*/

-- Views for monitoring

-- Active transfer status view
CREATE OR REPLACE VIEW v_zone_transfer_status AS
SELECT
    s.id AS zone_id,
    s.origin AS zone_name,
    s.serial AS current_serial,
    s.slave_mode,
    zm.master_host,
    zm.enabled,
    zm.last_check,
    zm.last_transfer,
    zm.transfer_failures,
    TIMESTAMPDIFF(SECOND, zm.last_transfer, NOW()) AS seconds_since_last_transfer,
    CASE
        WHEN zm.enabled = FALSE THEN 'DISABLED'
        WHEN zm.transfer_failures >= zm.max_failures THEN 'FAILED'
        WHEN zm.last_transfer IS NULL THEN 'NEVER_TRANSFERRED'
        WHEN TIMESTAMPDIFF(SECOND, zm.last_transfer, NOW()) > zm.transfer_interval * 2 THEN 'OVERDUE'
        ELSE 'OK'
    END AS health_status
FROM soa s
JOIN zone_masters zm ON zm.zone_id = s.id
WHERE s.slave_mode = TRUE;

-- Recent transfer activity view
CREATE OR REPLACE VIEW v_recent_transfers AS
SELECT
    s.origin AS zone_name,
    ztl.master_host,
    CASE
        WHEN ztl.status = 0 THEN 'SUCCESS'
        WHEN ztl.status = -1 THEN 'ERROR'
        WHEN ztl.status = -2 THEN 'NETWORK_ERROR'
        WHEN ztl.status = -3 THEN 'PARSE_ERROR'
        WHEN ztl.status = -4 THEN 'DATABASE_ERROR'
        WHEN ztl.status = -5 THEN 'AUTH_ERROR'
        WHEN ztl.status = -6 THEN 'TIMEOUT'
        ELSE 'UNKNOWN'
    END AS status,
    ztl.records_received,
    ztl.records_added,
    ztl.transfer_time,
    ztl.transfer_start,
    ztl.error_message
FROM zone_transfer_log ztl
JOIN soa s ON s.id = ztl.zone_id
ORDER BY ztl.transfer_start DESC
LIMIT 100;

-- Stored procedure to add a slave zone
DELIMITER $$

CREATE PROCEDURE IF NOT EXISTS add_slave_zone(
    IN p_zone_name VARCHAR(255),
    IN p_master_host VARCHAR(255),
    IN p_master_port INT,
    IN p_ns_server VARCHAR(255),
    IN p_admin_email VARCHAR(255)
)
BEGIN
    DECLARE v_zone_id INT;

    -- Ensure zone name ends with dot
    IF RIGHT(p_zone_name, 1) != '.' THEN
        SET p_zone_name = CONCAT(p_zone_name, '.');
    END IF;

    -- Ensure NS server ends with dot
    IF RIGHT(p_ns_server, 1) != '.' THEN
        SET p_ns_server = CONCAT(p_ns_server, '.');
    END IF;

    -- Ensure admin email ends with dot
    IF RIGHT(p_admin_email, 1) != '.' THEN
        SET p_admin_email = CONCAT(p_admin_email, '.');
    END IF;

    -- Create SOA record
    INSERT INTO soa (origin, ns, mbox, serial, refresh, retry, expire, minimum, ttl, active, slave_mode)
    VALUES (p_zone_name, p_ns_server, p_admin_email, 1, 3600, 600, 86400, 3600, 3600, 'Y', TRUE);

    SET v_zone_id = LAST_INSERT_ID();

    -- Add master configuration
    INSERT INTO zone_masters (zone_id, master_host, master_port, enabled)
    VALUES (v_zone_id, p_master_host, IFNULL(p_master_port, 53), TRUE);

    SELECT v_zone_id AS zone_id, 'Slave zone created successfully' AS message;
END$$

DELIMITER ;

-- Example usage of stored procedure:
-- CALL add_slave_zone('example.com', 'master-ns.example.com', 53, 'ns1.example.com', 'admin.example.com');

-- Cleanup old transfer logs (run periodically via cron)
-- DELETE FROM zone_transfer_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);

COMMIT;
