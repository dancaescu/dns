-- ACL Extended Schema - Granular Access Control
-- Date: 2025-11-28
-- Extends ACL system with granular targets: System, Master, Slave, Cache, WebUI, DoH

-- Update access_control table with new target types
ALTER TABLE access_control
MODIFY COLUMN target ENUM(
    'system',    -- System-wide (applies to everything)
    'master',    -- Master zones only (authoritative)
    'slave',     -- Slave zones only (transferred)
    'cache',     -- DNS caching/recursive queries only
    'webui',     -- Web UI access only
    'doh'        -- DNS over HTTPS only
) NOT NULL DEFAULT 'system';

-- Add index for fast target-based lookups
ALTER TABLE access_control ADD INDEX idx_target (target);
ALTER TABLE access_control ADD INDEX idx_target_enabled (target, enabled);

-- Add description field for better management
ALTER TABLE access_control ADD COLUMN description VARCHAR(255) DEFAULT NULL AFTER value;

-- Insert default system-wide ACLs (examples)
INSERT INTO access_control (type, target, action, value, description, enabled) VALUES
('ip', 'system', 'allow', '127.0.0.1', 'Allow localhost', TRUE),
('network', 'system', 'allow', '10.0.0.0/8', 'Allow RFC1918 private network', TRUE),
('network', 'system', 'allow', '172.16.0.0/12', 'Allow RFC1918 private network', TRUE),
('network', 'system', 'allow', '192.168.0.0/16', 'Allow RFC1918 private network', TRUE)
ON DUPLICATE KEY UPDATE enabled=enabled;

-- Create ACL statistics table
CREATE TABLE IF NOT EXISTS access_control_stats (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    target ENUM('system', 'master', 'slave', 'cache', 'webui', 'doh') NOT NULL,
    action ENUM('allow', 'deny') NOT NULL,
    rule_id INT UNSIGNED,
    client_ip VARCHAR(45) NOT NULL,
    country_code CHAR(2),
    requests INT UNSIGNED DEFAULT 1,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_target_ip (target, client_ip, DATE(last_seen)),
    KEY idx_target (target),
    KEY idx_rule_id (rule_id),
    KEY idx_last_seen (last_seen),

    FOREIGN KEY (rule_id) REFERENCES access_control(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create DNS caching configuration table
CREATE TABLE IF NOT EXISTS dns_cache_config (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    cache_size_mb INT UNSIGNED NOT NULL DEFAULT 256 COMMENT 'Cache size in megabytes',
    cache_ttl_min INT UNSIGNED NOT NULL DEFAULT 60 COMMENT 'Minimum TTL (seconds)',
    cache_ttl_max INT UNSIGNED NOT NULL DEFAULT 86400 COMMENT 'Maximum TTL (seconds)',
    upstream_servers TEXT NOT NULL COMMENT 'Comma-separated list of upstream DNS servers',
    allow_recursion BOOLEAN NOT NULL DEFAULT TRUE,
    forward_only BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Only forward, do not recurse',
    dnssec_validation BOOLEAN NOT NULL DEFAULT FALSE,
    rate_limit INT UNSIGNED DEFAULT 100 COMMENT 'Queries per second per client',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default caching configuration
INSERT INTO dns_cache_config (
    enabled, cache_size_mb, cache_ttl_min, cache_ttl_max,
    upstream_servers, allow_recursion, forward_only
) VALUES (
    TRUE, 256, 60, 86400,
    '8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1',  -- Google DNS and Cloudflare
    TRUE, FALSE
) ON DUPLICATE KEY UPDATE enabled=enabled;

-- Create DNS cache statistics table
CREATE TABLE IF NOT EXISTS dns_cache_stats (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    date DATE NOT NULL,
    hour TINYINT UNSIGNED NOT NULL,
    queries_total INT UNSIGNED DEFAULT 0,
    cache_hits INT UNSIGNED DEFAULT 0,
    cache_misses INT UNSIGNED DEFAULT 0,
    upstream_queries INT UNSIGNED DEFAULT 0,
    avg_response_time_ms DECIMAL(10,2) DEFAULT 0,

    UNIQUE KEY uk_date_hour (date, hour),
    KEY idx_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create DoH (DNS over HTTPS) configuration table
CREATE TABLE IF NOT EXISTS doh_config (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    listen_port INT UNSIGNED NOT NULL DEFAULT 443,
    tls_cert_path VARCHAR(512) NOT NULL,
    tls_key_path VARCHAR(512) NOT NULL,
    endpoint_path VARCHAR(255) NOT NULL DEFAULT '/dns-query',
    require_authentication BOOLEAN NOT NULL DEFAULT FALSE,
    max_concurrent_streams INT UNSIGNED NOT NULL DEFAULT 100,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default DoH configuration
INSERT INTO doh_config (
    enabled, listen_port, tls_cert_path, tls_key_path, endpoint_path
) VALUES (
    FALSE, 443, '/etc/mydns/certs/server.crt', '/etc/mydns/certs/server.key', '/dns-query'
) ON DUPLICATE KEY UPDATE enabled=enabled;

-- Create view for ACL summary by target
CREATE OR REPLACE VIEW v_acl_summary AS
SELECT
    target,
    action,
    COUNT(*) as rule_count,
    SUM(CASE WHEN enabled THEN 1 ELSE 0 END) as enabled_count
FROM access_control
GROUP BY target, action;

-- Create view for top blocked IPs
CREATE OR REPLACE VIEW v_acl_top_blocked AS
SELECT
    s.target,
    s.client_ip,
    s.country_code,
    SUM(s.requests) as total_blocked,
    MAX(s.last_seen) as last_blocked,
    a.value as matched_rule
FROM access_control_stats s
LEFT JOIN access_control a ON s.rule_id = a.id
WHERE s.action = 'deny'
GROUP BY s.target, s.client_ip, s.country_code, a.value
ORDER BY total_blocked DESC
LIMIT 100;

-- Create stored procedure to cleanup old ACL stats
DELIMITER $$
CREATE PROCEDURE sp_cleanup_acl_stats(IN days_to_keep INT)
BEGIN
    DELETE FROM access_control_stats
    WHERE last_seen < DATE_SUB(NOW(), INTERVAL days_to_keep DAY);

    DELETE FROM dns_cache_stats
    WHERE date < DATE_SUB(CURDATE(), INTERVAL days_to_keep DAY);

    SELECT ROW_COUNT() as rows_deleted;
END$$
DELIMITER ;

-- Create trigger to update ACL statistics
DELIMITER $$
CREATE TRIGGER tr_acl_stats_update
BEFORE INSERT ON access_control_stats
FOR EACH ROW
BEGIN
    -- Check if record exists for today
    IF EXISTS (
        SELECT 1 FROM access_control_stats
        WHERE target = NEW.target
        AND client_ip = NEW.client_ip
        AND DATE(last_seen) = CURDATE()
    ) THEN
        -- Update existing record
        UPDATE access_control_stats
        SET requests = requests + 1,
            last_seen = CURRENT_TIMESTAMP
        WHERE target = NEW.target
        AND client_ip = NEW.client_ip
        AND DATE(last_seen) = CURDATE();

        -- Prevent insert
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Record updated instead';
    END IF;
END$$
DELIMITER ;

-- Grant permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON access_control TO 'mydns'@'localhost';
-- GRANT SELECT, INSERT, UPDATE ON access_control_stats TO 'mydns'@'localhost';
-- GRANT SELECT ON v_acl_summary TO 'mydns'@'localhost';
-- GRANT EXECUTE ON PROCEDURE sp_cleanup_acl_stats TO 'mydns'@'localhost';

-- Display current ACL configuration
SELECT 'ACL Rules by Target:' as info;
SELECT * FROM v_acl_summary;

SELECT 'DNS Cache Configuration:' as info;
SELECT * FROM dns_cache_config;

SELECT 'DoH Configuration:' as info;
SELECT * FROM doh_config;
