--
-- MyDNS IXFR (Incremental Zone Transfer) Schema
-- Date: 2025-11-26
--
-- Additional tables required for IXFR protocol support (RFC 1995)
-- Run this script on MyDNS databases that already have axfr-slave-schema.sql applied
--
-- IXFR allows efficient incremental zone transfers by sending only the changes
-- between two zone serials, rather than the entire zone.
--

-- Zone Change Log
-- Tracks all changes to zone records for IXFR support
CREATE TABLE IF NOT EXISTS zone_changes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,

    -- Serial range
    old_serial INT UNSIGNED NOT NULL COMMENT 'Serial before this change',
    new_serial INT UNSIGNED NOT NULL COMMENT 'Serial after this change',

    -- Change type: 'ADD', 'DELETE', 'MODIFY'
    change_type ENUM('ADD', 'DELETE', 'MODIFY') NOT NULL,

    -- Record information
    record_id INT UNSIGNED NULL COMMENT 'RR table record ID (NULL for SOA changes)',
    record_name VARCHAR(255) NOT NULL,
    record_type VARCHAR(10) NOT NULL,
    record_data TEXT NOT NULL,
    record_aux INT UNSIGNED NULL,
    record_ttl INT UNSIGNED NOT NULL,

    -- For MODIFY operations, store old values
    old_data TEXT NULL,
    old_aux INT UNSIGNED NULL,
    old_ttl INT UNSIGNED NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100) NULL COMMENT 'User or system that made the change',

    -- Indexes
    INDEX idx_zone_serial (zone_id, old_serial, new_serial),
    INDEX idx_zone_id (zone_id),
    INDEX idx_new_serial (new_serial),
    INDEX idx_created_at (created_at),
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Zone change history for IXFR support';

-- IXFR Configuration
-- Controls IXFR behavior per zone
CREATE TABLE IF NOT EXISTS zone_ixfr_config (
    zone_id INT UNSIGNED NOT NULL PRIMARY KEY,

    -- IXFR settings
    ixfr_enabled BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Enable IXFR for this zone',
    max_journal_size INT UNSIGNED NOT NULL DEFAULT 10000 COMMENT 'Max changes to keep',
    journal_retention_days INT UNSIGNED NOT NULL DEFAULT 30 COMMENT 'Days to keep changes',

    -- Statistics
    total_changes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_cleanup TIMESTAMP NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='IXFR configuration per zone';

-- IXFR Transfer Log
-- Logs IXFR-specific transfer attempts
CREATE TABLE IF NOT EXISTS zone_ixfr_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,
    master_host VARCHAR(255) NOT NULL,

    -- Transfer details
    old_serial INT UNSIGNED NOT NULL,
    new_serial INT UNSIGNED NOT NULL,
    transfer_type ENUM('IXFR', 'AXFR_FALLBACK') NOT NULL,

    -- Results
    status INT NOT NULL COMMENT '0=success, negative=error code',
    changes_received INT UNSIGNED NOT NULL DEFAULT 0,
    changes_applied INT UNSIGNED NOT NULL DEFAULT 0,
    transfer_time BIGINT NOT NULL DEFAULT 0 COMMENT 'Transfer duration in seconds',

    -- Error information
    error_message TEXT NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_zone_id (zone_id),
    INDEX idx_created_at (created_at),
    INDEX idx_transfer_type (transfer_type),
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='IXFR transfer activity log';

-- Triggers to automatically log changes to rr table
DELIMITER $$

-- Log INSERT operations
DROP TRIGGER IF EXISTS log_rr_insert_for_ixfr$$
CREATE TRIGGER log_rr_insert_for_ixfr
AFTER INSERT ON rr
FOR EACH ROW
BEGIN
    DECLARE v_old_serial INT UNSIGNED;
    DECLARE v_new_serial INT UNSIGNED;
    DECLARE v_ixfr_enabled BOOLEAN;

    -- Check if IXFR is enabled for this zone
    SELECT ixfr_enabled INTO v_ixfr_enabled
    FROM zone_ixfr_config
    WHERE zone_id = NEW.zone
    LIMIT 1;

    -- Only log if IXFR is enabled
    IF v_ixfr_enabled = TRUE THEN
        -- Get old and new serial from SOA
        SELECT serial INTO v_new_serial FROM soa WHERE id = NEW.zone;

        -- Calculate old serial (new_serial - 1, handling date-based format)
        -- For date-based serials (YYYYMMDDNN), decrement revision
        IF MOD(v_new_serial, 100) > 1 THEN
            SET v_old_serial = v_new_serial - 1;
        ELSE
            -- If revision is 01, old serial is from previous day
            -- This is approximate - proper implementation would need date calculation
            SET v_old_serial = v_new_serial - 1;
        END IF;

        -- Log the change
        INSERT INTO zone_changes (
            zone_id, old_serial, new_serial, change_type,
            record_id, record_name, record_type, record_data, record_aux, record_ttl,
            created_by
        ) VALUES (
            NEW.zone, v_old_serial, v_new_serial, 'ADD',
            NEW.id, NEW.name, NEW.type, NEW.data, NEW.aux, NEW.ttl,
            USER()
        );

        -- Update statistics
        UPDATE zone_ixfr_config
        SET total_changes = total_changes + 1
        WHERE zone_id = NEW.zone;
    END IF;
END$$

-- Log UPDATE operations
DROP TRIGGER IF EXISTS log_rr_update_for_ixfr$$
CREATE TRIGGER log_rr_update_for_ixfr
AFTER UPDATE ON rr
FOR EACH ROW
BEGIN
    DECLARE v_old_serial INT UNSIGNED;
    DECLARE v_new_serial INT UNSIGNED;
    DECLARE v_ixfr_enabled BOOLEAN;

    SELECT ixfr_enabled INTO v_ixfr_enabled
    FROM zone_ixfr_config
    WHERE zone_id = NEW.zone
    LIMIT 1;

    IF v_ixfr_enabled = TRUE THEN
        SELECT serial INTO v_new_serial FROM soa WHERE id = NEW.zone;

        IF MOD(v_new_serial, 100) > 1 THEN
            SET v_old_serial = v_new_serial - 1;
        ELSE
            SET v_old_serial = v_new_serial - 1;
        END IF;

        INSERT INTO zone_changes (
            zone_id, old_serial, new_serial, change_type,
            record_id, record_name, record_type, record_data, record_aux, record_ttl,
            old_data, old_aux, old_ttl,
            created_by
        ) VALUES (
            NEW.zone, v_old_serial, v_new_serial, 'MODIFY',
            NEW.id, NEW.name, NEW.type, NEW.data, NEW.aux, NEW.ttl,
            OLD.data, OLD.aux, OLD.ttl,
            USER()
        );

        UPDATE zone_ixfr_config
        SET total_changes = total_changes + 1
        WHERE zone_id = NEW.zone;
    END IF;
END$$

-- Log DELETE operations
DROP TRIGGER IF EXISTS log_rr_delete_for_ixfr$$
CREATE TRIGGER log_rr_delete_for_ixfr
AFTER DELETE ON rr
FOR EACH ROW
BEGIN
    DECLARE v_old_serial INT UNSIGNED;
    DECLARE v_new_serial INT UNSIGNED;
    DECLARE v_ixfr_enabled BOOLEAN;

    SELECT ixfr_enabled INTO v_ixfr_enabled
    FROM zone_ixfr_config
    WHERE zone_id = OLD.zone
    LIMIT 1;

    IF v_ixfr_enabled = TRUE THEN
        SELECT serial INTO v_new_serial FROM soa WHERE id = OLD.zone;

        IF MOD(v_new_serial, 100) > 1 THEN
            SET v_old_serial = v_new_serial - 1;
        ELSE
            SET v_old_serial = v_new_serial - 1;
        END IF;

        INSERT INTO zone_changes (
            zone_id, old_serial, new_serial, change_type,
            record_id, record_name, record_type, record_data, record_aux, record_ttl,
            created_by
        ) VALUES (
            OLD.zone, v_old_serial, v_new_serial, 'DELETE',
            OLD.id, OLD.name, OLD.type, OLD.data, OLD.aux, OLD.ttl,
            USER()
        );

        UPDATE zone_ixfr_config
        SET total_changes = total_changes + 1
        WHERE zone_id = OLD.zone;
    END IF;
END$$

DELIMITER ;

-- Stored procedure to enable IXFR for a zone
DROP PROCEDURE IF EXISTS enable_zone_ixfr;
DELIMITER $$
CREATE PROCEDURE enable_zone_ixfr(
    IN p_zone_id INT,
    IN p_max_journal_size INT,
    IN p_retention_days INT
)
BEGIN
    INSERT INTO zone_ixfr_config (zone_id, ixfr_enabled, max_journal_size, journal_retention_days)
    VALUES (p_zone_id, TRUE, IFNULL(p_max_journal_size, 10000), IFNULL(p_retention_days, 30))
    ON DUPLICATE KEY UPDATE
        ixfr_enabled = TRUE,
        max_journal_size = IFNULL(p_max_journal_size, max_journal_size),
        journal_retention_days = IFNULL(p_retention_days, journal_retention_days);

    SELECT 'IXFR enabled for zone' AS message, p_zone_id AS zone_id;
END$$
DELIMITER ;

-- Stored procedure to cleanup old changes
DROP PROCEDURE IF EXISTS cleanup_zone_changes;
DELIMITER $$
CREATE PROCEDURE cleanup_zone_changes(IN p_zone_id INT)
BEGIN
    DECLARE v_retention_days INT;
    DECLARE v_max_journal_size INT;
    DECLARE v_current_count INT;
    DECLARE v_delete_before TIMESTAMP;

    -- Get configuration
    SELECT journal_retention_days, max_journal_size
    INTO v_retention_days, v_max_journal_size
    FROM zone_ixfr_config
    WHERE zone_id = p_zone_id;

    -- Delete by date
    SET v_delete_before = DATE_SUB(NOW(), INTERVAL v_retention_days DAY);
    DELETE FROM zone_changes
    WHERE zone_id = p_zone_id AND created_at < v_delete_before;

    -- Check if still over size limit
    SELECT COUNT(*) INTO v_current_count
    FROM zone_changes
    WHERE zone_id = p_zone_id;

    -- Delete oldest if over limit
    IF v_current_count > v_max_journal_size THEN
        SET @delete_count = v_current_count - v_max_journal_size;
        SET @sql_stmt = CONCAT(
            'DELETE FROM zone_changes WHERE zone_id = ', p_zone_id,
            ' ORDER BY id ASC LIMIT ', @delete_count
        );
        PREPARE stmt FROM @sql_stmt;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;

    -- Update last cleanup time
    UPDATE zone_ixfr_config
    SET last_cleanup = NOW()
    WHERE zone_id = p_zone_id;
END$$
DELIMITER ;

-- Views for monitoring IXFR
CREATE OR REPLACE VIEW v_ixfr_status AS
SELECT
    s.id AS zone_id,
    s.origin AS zone_name,
    s.serial AS current_serial,
    zic.ixfr_enabled,
    zic.total_changes,
    zic.max_journal_size,
    zic.journal_retention_days,
    zic.last_cleanup,
    (SELECT COUNT(*) FROM zone_changes WHERE zone_id = s.id) AS current_journal_size,
    (SELECT MIN(new_serial) FROM zone_changes WHERE zone_id = s.id) AS oldest_serial_in_journal,
    (SELECT MAX(new_serial) FROM zone_changes WHERE zone_id = s.id) AS newest_serial_in_journal
FROM soa s
LEFT JOIN zone_ixfr_config zic ON zic.zone_id = s.id;

-- Example usage:
/*
-- 1. Enable IXFR for a zone
CALL enable_zone_ixfr(123, 10000, 30);

-- 2. View IXFR status
SELECT * FROM v_ixfr_status WHERE zone_name = 'example.com.';

-- 3. View recent changes
SELECT
    zc.id,
    zc.change_type,
    zc.old_serial,
    zc.new_serial,
    zc.record_name,
    zc.record_type,
    zc.record_data,
    zc.created_at
FROM zone_changes zc
JOIN soa s ON s.id = zc.zone_id
WHERE s.origin = 'example.com.'
ORDER BY zc.id DESC
LIMIT 50;

-- 4. Cleanup old changes
CALL cleanup_zone_changes(123);

-- 5. Disable IXFR for a zone
UPDATE zone_ixfr_config SET ixfr_enabled = FALSE WHERE zone_id = 123;
*/

COMMIT;
