-- DNS Cache Configuration Tables
-- Standalone schema (no dependencies on access_control)

-- Cache configuration table
CREATE TABLE IF NOT EXISTS dns_cache_config (
    id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    cache_size_mb INT UNSIGNED NOT NULL DEFAULT 256,
    cache_ttl_min INT UNSIGNED NOT NULL DEFAULT 60,
    cache_ttl_max INT UNSIGNED NOT NULL DEFAULT 86400,
    upstream_servers TEXT NOT NULL,
    negative_cache_ttl INT UNSIGNED NOT NULL DEFAULT 300,
    max_entries INT UNSIGNED NOT NULL DEFAULT 100000,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNS caching configuration';

-- Insert default configuration
INSERT INTO dns_cache_config (enabled, cache_size_mb, cache_ttl_min, cache_ttl_max, upstream_servers)
VALUES (TRUE, 256, 60, 86400, '8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1')
ON DUPLICATE KEY UPDATE id=id;

-- Cache statistics table
CREATE TABLE IF NOT EXISTS dns_cache_stats (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    query_name VARCHAR(255) NOT NULL,
    query_type ENUM('A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'PTR', 'SOA', 'SRV', 'OTHER') NOT NULL,
    client_ip VARCHAR(45) NOT NULL,
    hit BOOLEAN NOT NULL DEFAULT FALSE,
    upstream_server VARCHAR(45),
    response_time_ms INT UNSIGNED,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created (created_at),
    INDEX idx_client (client_ip),
    INDEX idx_query (query_name, query_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DNS cache query statistics';

-- Cache performance view
CREATE OR REPLACE VIEW v_cache_performance AS
SELECT
    DATE(created_at) as date,
    COUNT(*) as total_queries,
    SUM(hit) as cache_hits,
    COUNT(*) - SUM(hit) as cache_misses,
    ROUND(100.0 * SUM(hit) / COUNT(*), 2) as hit_rate_percent,
    AVG(response_time_ms) as avg_response_ms
FROM dns_cache_stats
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Cleanup procedure for old stats
DELIMITER $$
CREATE PROCEDURE IF NOT EXISTS sp_cleanup_cache_stats()
BEGIN
    DELETE FROM dns_cache_stats WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);
END$$
DELIMITER ;
