-- DNS Statistics Tables for DNS Manager Web UI
-- Stores aggregate counters instead of individual queries
-- Date: 2025-11-25

-- Zone-level daily statistics
CREATE TABLE IF NOT EXISTS dns_zone_stats (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,
    stat_date DATE NOT NULL,
    stat_hour TINYINT UNSIGNED NULL,  -- NULL for daily rollup, 0-23 for hourly

    -- Query counters
    total_queries INT UNSIGNED DEFAULT 0,
    queries_a INT UNSIGNED DEFAULT 0,
    queries_aaaa INT UNSIGNED DEFAULT 0,
    queries_mx INT UNSIGNED DEFAULT 0,
    queries_txt INT UNSIGNED DEFAULT 0,
    queries_cname INT UNSIGNED DEFAULT 0,
    queries_ns INT UNSIGNED DEFAULT 0,
    queries_ptr INT UNSIGNED DEFAULT 0,
    queries_srv INT UNSIGNED DEFAULT 0,
    queries_caa INT UNSIGNED DEFAULT 0,
    queries_tlsa INT UNSIGNED DEFAULT 0,
    queries_other INT UNSIGNED DEFAULT 0,

    -- Response counters
    responses_noerror INT UNSIGNED DEFAULT 0,
    responses_nxdomain INT UNSIGNED DEFAULT 0,
    responses_servfail INT UNSIGNED DEFAULT 0,
    responses_refused INT UNSIGNED DEFAULT 0,

    -- Performance metrics
    avg_response_time_ms DECIMAL(10,2) DEFAULT 0,
    max_response_time_ms INT UNSIGNED DEFAULT 0,
    cache_hit_rate DECIMAL(5,2) DEFAULT 0,

    -- Security metrics
    blocked_ips INT UNSIGNED DEFAULT 0,
    tunnel_alerts INT UNSIGNED DEFAULT 0,
    flood_alerts INT UNSIGNED DEFAULT 0,

    -- Bandwidth
    bytes_sent BIGINT UNSIGNED DEFAULT 0,
    bytes_received BIGINT UNSIGNED DEFAULT 0,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY idx_zone_date_hour (zone_id, stat_date, stat_hour),
    KEY idx_zone_date (zone_id, stat_date),
    KEY idx_date (stat_date),
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Top queried records per zone (top 100 per day)
CREATE TABLE IF NOT EXISTS dns_top_queries (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,
    stat_date DATE NOT NULL,
    record_name VARCHAR(255) NOT NULL,
    record_type ENUM('A','AAAA','CAA','CERT','CNAME','DNAME','DNSKEY','DS',
                     'HINFO','HTTPS','LOC','MX','NAPTR','NS','NSEC','NSEC3',
                     'NSEC3PARAM','OPENPGPKEY','PTR','RP','RRSIG','SMIMEA',
                     'SRV','SSHFP','SVCB','TLSA','TXT','URI','OTHER') NOT NULL,
    query_count INT UNSIGNED DEFAULT 0,
    unique_ips INT UNSIGNED DEFAULT 0,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    date_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY idx_zone_date_record (zone_id, stat_date, record_name, record_type),
    KEY idx_zone_date (zone_id, stat_date),
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Geographic query distribution
CREATE TABLE IF NOT EXISTS dns_geo_stats (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,
    stat_date DATE NOT NULL,
    country_code CHAR(2) NOT NULL,
    query_count INT UNSIGNED DEFAULT 0,
    unique_ips INT UNSIGNED DEFAULT 0,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY idx_zone_date_country (zone_id, stat_date, country_code),
    KEY idx_zone_date (zone_id, stat_date),
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Security events (attacks, blocks)
CREATE TABLE IF NOT EXISTS dns_security_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NULL,  -- NULL for server-wide events
    event_type ENUM('TUNNEL_DETECTED','FLOOD_DETECTED','IP_BLOCKED','RATE_LIMITED') NOT NULL,
    source_ip VARCHAR(45) NOT NULL,
    query_name VARCHAR(255) NULL,
    details TEXT NULL,
    severity ENUM('LOW','MEDIUM','HIGH','CRITICAL') DEFAULT 'MEDIUM',

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    KEY idx_zone_date (zone_id, date_created),
    KEY idx_date (date_created),
    KEY idx_ip (source_ip),
    KEY idx_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server-wide statistics (global counters)
CREATE TABLE IF NOT EXISTS dns_server_stats (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    stat_date DATE NOT NULL,
    stat_hour TINYINT UNSIGNED NULL,

    -- Overall metrics
    total_queries INT UNSIGNED DEFAULT 0,
    queries_per_second DECIMAL(10,2) DEFAULT 0,
    unique_ips INT UNSIGNED DEFAULT 0,

    -- Cache performance
    cache_hits INT UNSIGNED DEFAULT 0,
    cache_misses INT UNSIGNED DEFAULT 0,
    cache_size_mb DECIMAL(10,2) DEFAULT 0,

    -- Database performance
    db_queries INT UNSIGNED DEFAULT 0,
    avg_db_time_ms DECIMAL(10,2) DEFAULT 0,

    -- Server health
    cpu_usage DECIMAL(5,2) DEFAULT 0,
    memory_usage_mb INT UNSIGNED DEFAULT 0,
    uptime_seconds INT UNSIGNED DEFAULT 0,

    -- Security summary
    total_blocked_ips INT UNSIGNED DEFAULT 0,
    total_attacks INT UNSIGNED DEFAULT 0,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY idx_date_hour (stat_date, stat_hour),
    KEY idx_date (stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Query pattern analysis (for detecting anomalies)
CREATE TABLE IF NOT EXISTS dns_query_patterns (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_id INT UNSIGNED NOT NULL,
    stat_date DATE NOT NULL,
    pattern_type ENUM('NORMAL','SUSPICIOUS','MALICIOUS') DEFAULT 'NORMAL',

    -- Pattern characteristics
    avg_subdomain_length DECIMAL(10,2) DEFAULT 0,
    max_subdomain_length INT UNSIGNED DEFAULT 0,
    avg_entropy DECIMAL(5,2) DEFAULT 0,
    unique_subdomains INT UNSIGNED DEFAULT 0,
    base64_patterns INT UNSIGNED DEFAULT 0,
    hex_patterns INT UNSIGNED DEFAULT 0,

    -- Sample queries (JSON array of examples)
    sample_queries JSON NULL,

    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY idx_zone_date_type (zone_id, stat_date, pattern_type),
    KEY idx_zone_date (zone_id, stat_date),
    FOREIGN KEY (zone_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Indexes for efficient querying
-- Additional composite indexes for common queries

-- Find zones with most queries
CREATE INDEX idx_zone_stats_queries ON dns_zone_stats(total_queries DESC, stat_date DESC);

-- Find recent security events
CREATE INDEX idx_security_recent ON dns_security_events(date_created DESC, severity);

-- Find top queries for a zone
CREATE INDEX idx_top_queries_count ON dns_top_queries(zone_id, stat_date, query_count DESC);
