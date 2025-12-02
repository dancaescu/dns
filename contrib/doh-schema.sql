-- DNS over HTTPS (DoH) Configuration Schema
-- RFC 8484 Implementation
--
-- Copyright (C) 2025 Dan Caescu <dan.caescu@multitel.net>
--
-- This schema provides configuration storage for the DNS over HTTPS server
-- integrated into MyDNS. DoH allows DNS queries over HTTPS (port 443) using
-- either GET or POST methods with application/dns-message content type.

-- Configuration table for DoH server
CREATE TABLE IF NOT EXISTS doh_config (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- Enable/disable DoH server
    enabled TINYINT(1) NOT NULL DEFAULT 0,

    -- HTTPS port (default 443)
    port INT UNSIGNED NOT NULL DEFAULT 443,

    -- URL path for DNS queries (default /dns-query)
    path VARCHAR(255) NOT NULL DEFAULT '/dns-query',

    -- TLS certificate file (PEM format)
    cert_file VARCHAR(512) NOT NULL DEFAULT '',

    -- TLS private key file (PEM format)
    key_file VARCHAR(512) NOT NULL DEFAULT '',

    -- Maximum concurrent connections
    max_connections INT UNSIGNED NOT NULL DEFAULT 100,

    -- Request timeout in seconds
    timeout_sec INT UNSIGNED NOT NULL DEFAULT 5,

    -- Require application/dns-message content type
    require_content_type TINYINT(1) NOT NULL DEFAULT 1,

    -- When this configuration was created
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- When this configuration was last modified
    date_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Configuration notes
    notes TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create index on enabled status for fast lookups
CREATE INDEX idx_doh_enabled ON doh_config (enabled);

-- Insert default configuration (disabled by default)
INSERT INTO doh_config (
    enabled,
    port,
    path,
    cert_file,
    key_file,
    max_connections,
    timeout_sec,
    require_content_type,
    notes
) VALUES (
    0,
    443,
    '/dns-query',
    '/etc/mydns/doh-cert.pem',
    '/etc/mydns/doh-key.pem',
    100,
    5,
    1,
    'Default DoH configuration. Set enabled=1 and configure valid cert_file and key_file to activate.'
) ON DUPLICATE KEY UPDATE id=id;

-- Statistics table for DoH server (optional, for monitoring)
CREATE TABLE IF NOT EXISTS doh_stats (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- Timestamp for this statistics snapshot
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Total requests received
    total_requests BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- GET method requests
    get_requests BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- POST method requests
    post_requests BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Successful DNS queries
    successful_queries BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Failed DNS queries
    failed_queries BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Invalid HTTP requests
    invalid_requests BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Denied by ACL
    acl_denials BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Total bytes sent
    bytes_sent BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Total bytes received
    bytes_received BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Server uptime in seconds
    uptime_seconds INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create index on timestamp for time-series queries
CREATE INDEX idx_doh_stats_timestamp ON doh_stats (timestamp);

-- Usage Instructions:
--
-- 1. Apply this schema to your MyDNS database:
--    mysql -u root -p your_database < doh-schema.sql
--
-- 2. Generate or obtain TLS certificates:
--    # Self-signed for testing:
--    openssl req -x509 -newkey rsa:4096 -keyout /etc/mydns/doh-key.pem \
--      -out /etc/mydns/doh-cert.pem -days 365 -nodes \
--      -subj "/CN=dns.example.com"
--
--    # Production: Use Let's Encrypt or your certificate provider
--
-- 3. Update configuration:
--    UPDATE doh_config SET
--      enabled = 1,
--      cert_file = '/path/to/your/cert.pem',
--      key_file = '/path/to/your/key.pem'
--    WHERE id = 1;
--
-- 4. Configure mydns.conf (alternative to database):
--    doh-enabled = 1
--    doh-port = 443
--    doh-path = /dns-query
--    doh-cert = /etc/mydns/doh-cert.pem
--    doh-key = /etc/mydns/doh-key.pem
--
-- 5. Restart MyDNS:
--    systemctl restart mydns
--
-- 6. Test with curl:
--    # POST method:
--    dig @localhost example.com | \
--      xxd -r -p | \
--      curl -H "Content-Type: application/dns-message" \
--           --data-binary @- \
--           https://your-server/dns-query -k | \
--      xxd -p
--
--    # GET method (with base64url encoding):
--    curl "https://your-server/dns-query?dns=AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB" -k
--
-- 7. Monitor statistics:
--    SELECT * FROM doh_stats ORDER BY timestamp DESC LIMIT 10;
--
-- Configuration Priority:
--   1. Database (doh_config table) - highest priority
--   2. Config file (mydns.conf) - medium priority
--   3. Hardcoded defaults - lowest priority
--
-- Notes:
--   - DoH requires valid TLS certificates to function
--   - Port 443 requires root/CAP_NET_BIND_SERVICE privilege
--   - Consider using port 8443 for non-root testing
--   - DoH coexists with standard DNS on port 53
--   - Statistics table is optional and can be populated by external monitoring
