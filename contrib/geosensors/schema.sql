-- Geographic Sensors and Access Control Schema
-- Date: 2025-11-25
--
-- This schema supports:
-- - Multi-location DNS sensors that learn Cloudflare proxy IPs
-- - Geographic-aware DNS responses
-- - IP/Network/ASN/Geo whitelist/blacklist for DNS and web UI

-- ============================================================================
-- SENSOR LOCATIONS
-- ============================================================================

-- Define geographic sensor locations
CREATE TABLE IF NOT EXISTS geo_sensors (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    location_name VARCHAR(50) NOT NULL UNIQUE,
    location_code VARCHAR(10) NOT NULL UNIQUE, -- e.g., 'eu', 'na', 'asia'
    description TEXT,
    continent VARCHAR(50),
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    api_endpoint VARCHAR(255), -- URL if sensor is remote
    last_sync TIMESTAMP NULL,
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_active (is_active),
    INDEX idx_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default sensors
INSERT INTO geo_sensors (location_name, location_code, continent, is_default, description) VALUES
('North America', 'na', 'North America', TRUE, 'Default sensor - North America'),
('Europe', 'eu', 'Europe', FALSE, 'European sensor'),
('Asia Pacific', 'apac', 'Asia', FALSE, 'Asia-Pacific sensor'),
('South America', 'sa', 'South America', FALSE, 'South American sensor'),
('Africa', 'af', 'Africa', FALSE, 'African sensor'),
('Oceania', 'oc', 'Oceania', FALSE, 'Oceania sensor')
ON DUPLICATE KEY UPDATE location_name=VALUES(location_name);

-- ============================================================================
-- CLOUDFLARE PROXY IP LEARNING
-- ============================================================================

-- Store learned IPs from Cloudflare proxied records per sensor location
CREATE TABLE IF NOT EXISTS cloudflare_proxy_ips (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id VARCHAR(50) NOT NULL, -- Cloudflare zone ID
    record_id VARCHAR(50) NOT NULL, -- Cloudflare record ID
    record_name VARCHAR(255) NOT NULL,
    record_type ENUM('A', 'AAAA', 'CNAME') NOT NULL,
    sensor_id INT UNSIGNED NOT NULL,

    -- Learned IPs from this sensor location
    learned_ips JSON NOT NULL, -- Array of IP addresses

    -- Metadata
    ttl INT UNSIGNED DEFAULT 300,
    is_proxied BOOLEAN DEFAULT TRUE,
    last_resolved TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolve_count INT UNSIGNED DEFAULT 0,
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY idx_record_sensor (record_id, sensor_id),
    KEY idx_zone (zone_id),
    KEY idx_record_name (record_name),
    KEY idx_sensor (sensor_id),
    KEY idx_last_resolved (last_resolved),

    FOREIGN KEY (sensor_id) REFERENCES geo_sensors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- GEOGRAPHIC RR RECORDS (Per-Location IPs)
-- ============================================================================

-- Store location-specific IPs for DNS records
-- Example: www.example.com -> 1.2.3.4 (Europe), 4.3.2.1 (North America)
CREATE TABLE IF NOT EXISTS geo_rr (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- Link to main RR record
    rr_id BIGINT UNSIGNED NOT NULL,
    zone_id INT UNSIGNED NOT NULL,

    -- Geographic location
    sensor_id INT UNSIGNED NOT NULL,

    -- Location-specific data
    data VARCHAR(512) NOT NULL, -- IP address or other data specific to this location

    -- Metadata
    is_active BOOLEAN DEFAULT TRUE,
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY idx_rr_sensor (rr_id, sensor_id),
    KEY idx_zone (zone_id),
    KEY idx_sensor (sensor_id),
    KEY idx_active (is_active),

    FOREIGN KEY (rr_id) REFERENCES rr(id) ON DELETE CASCADE,
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE,
    FOREIGN KEY (sensor_id) REFERENCES geo_sensors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ZONE GEOIP SETTINGS
-- ============================================================================

-- Enable GeoIP per zone (SOA table)
-- Note: Run these manually if columns already exist, or use IGNORE
ALTER TABLE soa
ADD COLUMN use_geoip BOOLEAN DEFAULT FALSE COMMENT 'Enable geographic-aware DNS responses for this zone';

ALTER TABLE soa
ADD COLUMN geoip_updated TIMESTAMP NULL;

-- Add proxy mode to cloudflare_zones table
ALTER TABLE cloudflare_zones
ADD COLUMN use_proxy_ips BOOLEAN DEFAULT FALSE COMMENT 'Serve learned Cloudflare proxy IPs instead of origin IPs';

ALTER TABLE cloudflare_zones
ADD COLUMN proxy_mode_updated TIMESTAMP NULL;

-- ============================================================================
-- GEOIP MAPPING
-- ============================================================================

-- Map GeoIP country codes to sensor locations
CREATE TABLE IF NOT EXISTS geo_country_mapping (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    country_code CHAR(2) NOT NULL UNIQUE, -- ISO 3166-1 alpha-2
    country_name VARCHAR(100) NOT NULL,
    sensor_id INT UNSIGNED NOT NULL,
    continent VARCHAR(50),
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    KEY idx_country (country_code),
    KEY idx_sensor (sensor_id),

    FOREIGN KEY (sensor_id) REFERENCES geo_sensors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Example mappings (abbreviated - full list would have all countries)
INSERT INTO geo_country_mapping (country_code, country_name, sensor_id, continent)
SELECT 'US', 'United States', id, 'North America' FROM geo_sensors WHERE location_code='na'
UNION SELECT 'CA', 'Canada', id, 'North America' FROM geo_sensors WHERE location_code='na'
UNION SELECT 'MX', 'Mexico', id, 'North America' FROM geo_sensors WHERE location_code='na'
UNION SELECT 'GB', 'United Kingdom', id, 'Europe' FROM geo_sensors WHERE location_code='eu'
UNION SELECT 'DE', 'Germany', id, 'Europe' FROM geo_sensors WHERE location_code='eu'
UNION SELECT 'FR', 'France', id, 'Europe' FROM geo_sensors WHERE location_code='eu'
UNION SELECT 'CN', 'China', id, 'Asia' FROM geo_sensors WHERE location_code='apac'
UNION SELECT 'JP', 'Japan', id, 'Asia' FROM geo_sensors WHERE location_code='apac'
UNION SELECT 'IN', 'India', id, 'Asia' FROM geo_sensors WHERE location_code='apac'
UNION SELECT 'BR', 'Brazil', id, 'South America' FROM geo_sensors WHERE location_code='sa'
UNION SELECT 'AR', 'Argentina', id, 'South America' FROM geo_sensors WHERE location_code='sa'
UNION SELECT 'ZA', 'South Africa', id, 'Africa' FROM geo_sensors WHERE location_code='af'
UNION SELECT 'AU', 'Australia', id, 'Oceania' FROM geo_sensors WHERE location_code='oc'
UNION SELECT 'NZ', 'New Zealand', id, 'Oceania' FROM geo_sensors WHERE location_code='oc'
ON DUPLICATE KEY UPDATE country_name=VALUES(country_name);

-- ============================================================================
-- ACCESS CONTROL - WHITELIST/BLACKLIST
-- ============================================================================

-- Access control rules for both DNS and Web UI
CREATE TABLE IF NOT EXISTS access_control_rules (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    rule_name VARCHAR(100) NOT NULL,
    rule_type ENUM('whitelist', 'blacklist') NOT NULL DEFAULT 'blacklist',

    -- What this rule applies to
    applies_to ENUM('dns', 'webui', 'both') NOT NULL DEFAULT 'both',

    -- Match criteria (at least one must be set)
    ip_address VARCHAR(45) NULL, -- Single IP
    ip_network VARCHAR(50) NULL, -- CIDR notation (e.g., 192.168.1.0/24)
    asn INT UNSIGNED NULL, -- Autonomous System Number
    country_code CHAR(2) NULL, -- ISO country code
    continent VARCHAR(50) NULL, -- Continent name

    -- Optional: Zone-specific (NULL = applies globally)
    zone_id INT UNSIGNED NULL,

    -- Rule metadata
    reason TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    priority INT DEFAULT 100, -- Lower number = higher priority
    hit_count INT UNSIGNED DEFAULT 0,
    last_hit TIMESTAMP NULL,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT NULL, -- User ID

    KEY idx_type_applies (rule_type, applies_to, is_active),
    KEY idx_ip (ip_address),
    KEY idx_network (ip_network),
    KEY idx_asn (asn),
    KEY idx_country (country_code),
    KEY idx_zone (zone_id),
    KEY idx_active (is_active),
    KEY idx_priority (priority),

    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES dnsmanager_user_accounts(id) ON DELETE SET NULL,

    -- Ensure at least one match criterion is set
    CHECK (ip_address IS NOT NULL OR ip_network IS NOT NULL OR asn IS NOT NULL OR country_code IS NOT NULL OR continent IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Example rules
INSERT INTO access_control_rules (rule_name, rule_type, applies_to, country_code, reason, is_active) VALUES
('Block China DNS', 'blacklist', 'dns', 'CN', 'High abuse rate', FALSE),
('Allow US Only WebUI', 'whitelist', 'webui', 'US', 'Security policy', FALSE),
('Block Tor Exit Nodes', 'blacklist', 'both', NULL, 'Abuse prevention', FALSE)
ON DUPLICATE KEY UPDATE rule_name=VALUES(rule_name);

-- ============================================================================
-- ACCESS CONTROL LOG
-- ============================================================================

-- Log blocked/allowed requests for audit
CREATE TABLE IF NOT EXISTS access_control_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    rule_id INT UNSIGNED NULL,

    -- Request details
    source_ip VARCHAR(45) NOT NULL,
    country_code CHAR(2) NULL,
    asn INT UNSIGNED NULL,

    -- What was accessed
    access_type ENUM('dns', 'webui') NOT NULL,
    zone_id INT UNSIGNED NULL,
    query_name VARCHAR(255) NULL, -- For DNS requests
    request_path VARCHAR(255) NULL, -- For web UI requests

    -- Decision
    action ENUM('allowed', 'blocked') NOT NULL,
    rule_matched VARCHAR(100) NULL,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    KEY idx_source_ip (source_ip),
    KEY idx_date (date_created),
    KEY idx_action (action),
    KEY idx_rule (rule_id),

    FOREIGN KEY (rule_id) REFERENCES access_control_rules(id) ON DELETE SET NULL,
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Partition by month for performance (optional)
-- ALTER TABLE access_control_log PARTITION BY RANGE (UNIX_TIMESTAMP(date_created)) (
--     PARTITION p202511 VALUES LESS THAN (UNIX_TIMESTAMP('2025-12-01')),
--     PARTITION p202512 VALUES LESS THAN (UNIX_TIMESTAMP('2026-01-01')),
--     ...
-- );

-- ============================================================================
-- SENSOR HEALTH MONITORING
-- ============================================================================

-- Track sensor health and sync status
CREATE TABLE IF NOT EXISTS geo_sensor_health (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sensor_id INT UNSIGNED NOT NULL,

    -- Health metrics
    is_online BOOLEAN DEFAULT TRUE,
    last_heartbeat TIMESTAMP NULL,
    records_synced INT UNSIGNED DEFAULT 0,
    sync_errors INT UNSIGNED DEFAULT 0,
    avg_resolve_time_ms DECIMAL(10,2),

    -- Status
    status ENUM('healthy', 'degraded', 'offline') DEFAULT 'healthy',
    status_message TEXT,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY idx_sensor (sensor_id),
    KEY idx_status (status),

    FOREIGN KEY (sensor_id) REFERENCES geo_sensors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initialize health records for all sensors
INSERT INTO geo_sensor_health (sensor_id, is_online, status)
SELECT id, FALSE, 'offline' FROM geo_sensors
ON DUPLICATE KEY UPDATE sensor_id=VALUES(sensor_id);

-- ============================================================================
-- VIEWS FOR EASY QUERYING
-- ============================================================================

-- View: Active sensors with health status
CREATE OR REPLACE VIEW v_active_sensors AS
SELECT
    s.id,
    s.location_name,
    s.location_code,
    s.continent,
    s.is_default,
    h.is_online,
    h.status,
    h.last_heartbeat,
    h.records_synced,
    s.last_sync
FROM geo_sensors s
LEFT JOIN geo_sensor_health h ON s.sensor_id = h.sensor_id
WHERE s.is_active = TRUE;

-- View: Proxy IP summary per zone
CREATE OR REPLACE VIEW v_proxy_ip_summary AS
SELECT
    z.zone_name,
    z.use_proxy_ips,
    COUNT(DISTINCT p.record_id) as proxied_records,
    COUNT(DISTINCT p.sensor_id) as sensor_coverage,
    MAX(p.last_resolved) as last_updated
FROM cloudflare_zones z
LEFT JOIN cloudflare_proxy_ips p ON z.zone_id = p.zone_id
WHERE z.is_active = TRUE
GROUP BY z.zone_id, z.zone_name, z.use_proxy_ips;

-- View: Access control summary
CREATE OR REPLACE VIEW v_access_control_summary AS
SELECT
    rule_type,
    applies_to,
    COUNT(*) as rule_count,
    SUM(is_active) as active_rules,
    SUM(hit_count) as total_hits
FROM access_control_rules
GROUP BY rule_type, applies_to;

-- View: Geographic RR summary
CREATE OR REPLACE VIEW v_geo_rr_summary AS
SELECT
    s.origin as zone_name,
    r.name as record_name,
    r.type as record_type,
    r.data as default_data,
    COUNT(g.id) as location_count,
    GROUP_CONCAT(CONCAT(gs.location_code, ':', g.data) SEPARATOR ', ') as location_ips
FROM rr r
JOIN soa s ON r.zone = s.id
LEFT JOIN geo_rr g ON r.id = g.rr_id AND g.is_active = TRUE
LEFT JOIN geo_sensors gs ON g.sensor_id = gs.id
WHERE s.use_geoip = TRUE
GROUP BY r.id, s.origin, r.name, r.type, r.data;

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Optimize common queries
CREATE INDEX idx_proxy_zone_sensor ON cloudflare_proxy_ips(zone_id, sensor_id, record_name);
CREATE INDEX idx_proxy_active ON cloudflare_proxy_ips(is_proxied, last_resolved);
CREATE INDEX idx_access_log_recent ON access_control_log(date_created DESC) USING BTREE;

-- ============================================================================
-- CLEANUP PROCEDURES
-- ============================================================================

DELIMITER //

-- Procedure to clean old access logs (keep 30 days)
CREATE PROCEDURE IF NOT EXISTS cleanup_access_logs()
BEGIN
    DELETE FROM access_control_log
    WHERE date_created < DATE_SUB(NOW(), INTERVAL 30 DAY);

    SELECT ROW_COUNT() as deleted_rows;
END//

-- Procedure to update sensor health
CREATE PROCEDURE IF NOT EXISTS update_sensor_health(
    IN p_sensor_id INT,
    IN p_is_online BOOLEAN,
    IN p_records_synced INT,
    IN p_errors INT
)
BEGIN
    INSERT INTO geo_sensor_health
        (sensor_id, is_online, last_heartbeat, records_synced, sync_errors, status)
    VALUES
        (p_sensor_id, p_is_online, NOW(), p_records_synced, p_errors,
         IF(p_is_online, IF(p_errors > 10, 'degraded', 'healthy'), 'offline'))
    ON DUPLICATE KEY UPDATE
        is_online = VALUES(is_online),
        last_heartbeat = VALUES(last_heartbeat),
        records_synced = records_synced + VALUES(records_synced),
        sync_errors = sync_errors + VALUES(sync_errors),
        status = VALUES(status);

    UPDATE geo_sensors SET last_sync = NOW() WHERE id = p_sensor_id;
END//

DELIMITER ;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

DELIMITER //

-- Ensure only one default sensor
CREATE TRIGGER IF NOT EXISTS enforce_single_default_sensor
BEFORE UPDATE ON geo_sensors
FOR EACH ROW
BEGIN
    IF NEW.is_default = TRUE AND OLD.is_default = FALSE THEN
        UPDATE geo_sensors SET is_default = FALSE WHERE id != NEW.id;
    END IF;
END//

-- Log access control rule hits
CREATE TRIGGER IF NOT EXISTS increment_rule_hits
AFTER INSERT ON access_control_log
FOR EACH ROW
BEGIN
    UPDATE access_control_rules
    SET hit_count = hit_count + 1, last_hit = NEW.date_created
    WHERE id = NEW.rule_id;
END//

DELIMITER ;

-- ============================================================================
-- GRANTS AND PERMISSIONS
-- ============================================================================

-- Grant permissions to dnsmanager user (adjust username as needed)
-- GRANT SELECT, INSERT, UPDATE ON did.geo_sensors TO 'dnsmanager'@'localhost';
-- GRANT SELECT, INSERT, UPDATE ON did.cloudflare_proxy_ips TO 'dnsmanager'@'localhost';
-- GRANT SELECT, INSERT ON did.access_control_log TO 'dnsmanager'@'localhost';
-- GRANT SELECT ON did.access_control_rules TO 'dnsmanager'@'localhost';

-- ============================================================================
-- NOTES
-- ============================================================================

-- Usage:
-- 1. Sensors run on multiple geographic locations
-- 2. Each sensor resolves Cloudflare proxied records and stores IPs
-- 3. When use_proxy_ips=TRUE for a zone, MyDNS serves learned IPs based on requester's GeoIP
-- 4. Access control rules can whitelist/blacklist by IP, network, ASN, country, or continent
-- 5. Rules apply to DNS queries and/or web UI access
-- 6. All access attempts are logged for audit

-- Example queries:
-- Get all learned IPs for a record across all sensors:
-- SELECT s.location_name, p.learned_ips
-- FROM cloudflare_proxy_ips p
-- JOIN geo_sensors s ON p.sensor_id = s.id
-- WHERE p.record_name = 'www.example.com';

-- Check if IP should be blocked:
-- SELECT * FROM access_control_rules
-- WHERE is_active=TRUE AND rule_type='blacklist'
--   AND (ip_address='1.2.3.4' OR '1.2.3.4' LIKE CONCAT(SUBSTRING_INDEX(ip_network, '/', 1), '%'));
