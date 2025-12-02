-- User Cloudflare Credentials and Zone ACL Schema
-- Copyright (C) 2025 Dan Caescu <dan.caescu@multitel.net>
--
-- This schema allows individual users to add their own Cloudflare credentials
-- and define per-zone ACLs for access control.

-- Table for user-specific Cloudflare credentials
CREATE TABLE IF NOT EXISTS dnsmanager_cloudflare_credentials (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- User who owns these credentials
    user_id INT NOT NULL,

    -- Account ID for this user (multiple accounts per user allowed)
    account_id INT NOT NULL,

    -- Cloudflare credentials
    cf_email VARCHAR(255) NOT NULL,
    cf_api_key VARCHAR(255) NOT NULL,  -- Encrypted in application
    cf_account_id VARCHAR(64) NOT NULL,  -- Cloudflare account ID

    -- Optional: specific domain to sync (leave NULL for all domains)
    cf_domain VARCHAR(255) NULL,

    -- Cloudflare API endpoint (usually default)
    cf_api_url VARCHAR(255) NOT NULL DEFAULT 'https://api.cloudflare.com/client/v4',

    -- Sync settings
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    auto_sync TINYINT(1) NOT NULL DEFAULT 1,  -- Auto-sync via cron
    sync_frequency INT NOT NULL DEFAULT 300,  -- Seconds between syncs (5 minutes)
    last_sync_at TIMESTAMP NULL,
    last_sync_status VARCHAR(50) NULL,  -- 'success', 'failed', 'partial'
    last_sync_error TEXT NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT NULL,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_account_id (account_id),
    INDEX idx_enabled (enabled),
    INDEX idx_auto_sync (auto_sync),
    INDEX idx_cf_account_id (cf_account_id),

    -- Foreign keys
    FOREIGN KEY (user_id) REFERENCES dnsmanager_users(id) ON DELETE CASCADE,

    -- Unique constraint: one credential set per user per CF account per domain
    UNIQUE KEY unique_user_cf_creds (user_id, cf_account_id, cf_domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table for zone-specific ACLs (IP-based access control per zone)
CREATE TABLE IF NOT EXISTS dnsmanager_zone_acls (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- Zone (SOA) this ACL applies to
    soa_id INT UNSIGNED NOT NULL,

    -- User who created this ACL
    user_id INT NOT NULL,

    -- Account ID for multi-tenancy
    account_id INT NOT NULL,

    -- ACL rule
    rule_name VARCHAR(255) NOT NULL,
    rule_type ENUM('allow', 'deny') NOT NULL DEFAULT 'allow',

    -- IP address or CIDR range
    ip_address VARCHAR(45) NOT NULL,  -- Supports IPv4 and IPv6
    cidr_mask INT NULL,  -- NULL for single IP, 0-32 for IPv4, 0-128 for IPv6

    -- What operations this ACL applies to
    applies_to_query TINYINT(1) NOT NULL DEFAULT 1,    -- DNS queries
    applies_to_axfr TINYINT(1) NOT NULL DEFAULT 0,     -- Zone transfers
    applies_to_notify TINYINT(1) NOT NULL DEFAULT 0,   -- DNS NOTIFY
    applies_to_update TINYINT(1) NOT NULL DEFAULT 0,   -- Dynamic updates
    applies_to_doh TINYINT(1) NOT NULL DEFAULT 1,      -- DNS over HTTPS

    -- Priority (lower number = higher priority)
    priority INT NOT NULL DEFAULT 100,

    -- Enable/disable
    enabled TINYINT(1) NOT NULL DEFAULT 1,

    -- Optional description
    description TEXT NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT NULL,

    -- Indexes
    INDEX idx_soa_id (soa_id),
    INDEX idx_user_id (user_id),
    INDEX idx_account_id (account_id),
    INDEX idx_enabled (enabled),
    INDEX idx_priority (priority),
    INDEX idx_ip_address (ip_address),
    INDEX idx_rule_type (rule_type),

    -- Foreign keys
    FOREIGN KEY (user_id) REFERENCES dnsmanager_users(id) ON DELETE CASCADE,
    FOREIGN KEY (soa_id) REFERENCES soa(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table for zone ACL statistics (tracking blocked/allowed requests)
CREATE TABLE IF NOT EXISTS dnsmanager_zone_acl_stats (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- ACL rule that was triggered
    acl_id INT UNSIGNED NOT NULL,

    -- Request details
    source_ip VARCHAR(45) NOT NULL,
    request_type ENUM('query', 'axfr', 'notify', 'update', 'doh') NOT NULL,
    action_taken ENUM('allowed', 'denied') NOT NULL,

    -- Metadata
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_acl_id (acl_id),
    INDEX idx_timestamp (timestamp),
    INDEX idx_source_ip (source_ip),
    INDEX idx_action_taken (action_taken),

    -- Foreign key
    FOREIGN KEY (acl_id) REFERENCES dnsmanager_zone_acls(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table for global ACL rules (apply to all zones for a user/account)
CREATE TABLE IF NOT EXISTS dnsmanager_global_acls (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- User who created this ACL (NULL = applies to all users in account)
    user_id INT NULL,

    -- Account ID for multi-tenancy
    account_id INT NOT NULL,

    -- ACL rule
    rule_name VARCHAR(255) NOT NULL,
    rule_type ENUM('allow', 'deny') NOT NULL DEFAULT 'allow',

    -- IP address or CIDR range
    ip_address VARCHAR(45) NOT NULL,
    cidr_mask INT NULL,

    -- What operations this ACL applies to
    applies_to_query TINYINT(1) NOT NULL DEFAULT 1,
    applies_to_axfr TINYINT(1) NOT NULL DEFAULT 0,
    applies_to_notify TINYINT(1) NOT NULL DEFAULT 0,
    applies_to_update TINYINT(1) NOT NULL DEFAULT 0,
    applies_to_doh TINYINT(1) NOT NULL DEFAULT 1,

    -- Priority (lower number = higher priority)
    priority INT NOT NULL DEFAULT 100,

    -- Enable/disable
    enabled TINYINT(1) NOT NULL DEFAULT 1,

    -- Optional description
    description TEXT NULL,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT NULL,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_account_id (account_id),
    INDEX idx_enabled (enabled),
    INDEX idx_priority (priority),
    INDEX idx_ip_address (ip_address),
    INDEX idx_rule_type (rule_type)

    -- No foreign keys to avoid constraint issues with flexible account_id
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert example data (commented out - uncomment and adjust IDs as needed)
-- INSERT INTO dnsmanager_cloudflare_credentials (
--     user_id, account_id, cf_email, cf_api_key, cf_account_id, cf_domain, enabled
-- ) VALUES (
--     1, 1,
--     'example@example.com',
--     'ENCRYPTED_API_KEY_PLACEHOLDER',
--     'example_cf_account_id',
--     NULL,
--     0
-- ) ON DUPLICATE KEY UPDATE id=id;

-- Example zone ACL: Allow only specific IP to query a zone (commented out)
-- INSERT INTO dnsmanager_zone_acls (
--     soa_id, user_id, account_id, rule_name, rule_type,
--     ip_address, cidr_mask, applies_to_query, enabled, description
-- ) VALUES (
--     1, 1, 1,
--     'Allow office network',
--     'allow',
--     '192.168.1.0',
--     24,
--     1, 0,
--     'Example ACL - Allow queries from office network'
-- ) ON DUPLICATE KEY UPDATE id=id;

-- Example global ACL: Deny queries from specific country/IP range (commented out)
-- INSERT INTO dnsmanager_global_acls (
--     user_id, account_id, rule_name, rule_type,
--     ip_address, cidr_mask, applies_to_query, enabled, description
-- ) VALUES (
--     NULL, 1,
--     'Deny known abusers',
--     'deny',
--     '10.0.0.0',
--     8,
--     1, 0,
--     'Example global ACL - Deny queries from abuse network'
-- ) ON DUPLICATE KEY UPDATE id=id;

-- View for easy ACL lookup (combines zone and global ACLs)
CREATE OR REPLACE VIEW dnsmanager_acl_lookup AS
SELECT
    'zone' AS acl_scope,
    z.id AS acl_id,
    z.soa_id,
    s.origin AS zone_name,
    z.user_id,
    z.account_id,
    z.rule_name,
    z.rule_type,
    z.ip_address,
    z.cidr_mask,
    z.applies_to_query,
    z.applies_to_axfr,
    z.applies_to_notify,
    z.applies_to_update,
    z.applies_to_doh,
    z.priority,
    z.enabled
FROM dnsmanager_zone_acls z
JOIN soa s ON z.soa_id = s.id
WHERE z.enabled = 1

UNION ALL

SELECT
    'global' AS acl_scope,
    g.id AS acl_id,
    NULL AS soa_id,
    '*' AS zone_name,
    g.user_id,
    g.account_id,
    g.rule_name,
    g.rule_type,
    g.ip_address,
    g.cidr_mask,
    g.applies_to_query,
    g.applies_to_axfr,
    g.applies_to_notify,
    g.applies_to_update,
    g.applies_to_doh,
    g.priority,
    g.enabled
FROM dnsmanager_global_acls g
WHERE g.enabled = 1

ORDER BY priority ASC, acl_scope DESC;

-- Usage Instructions:
--
-- 1. Apply this schema to your MyDNS database:
--    mysql -u root -p your_database < user-cloudflare-acl-schema.sql
--
-- 2. Users can add their Cloudflare credentials via the web UI
--
-- 3. Users can define ACLs for their zones via the web UI
--
-- 4. The sync_cloudflare_records.py script will read from both:
--    - /etc/mydns/cloudflare.ini (global/admin credentials)
--    - dnsmanager_cloudflare_credentials table (per-user credentials)
--
-- 5. MyDNS server will check ACLs before processing DNS requests
--
-- 6. ACL priority rules:
--    - Lower priority number = checked first
--    - Zone ACLs are checked before global ACLs
--    - First matching rule wins (allow or deny)
--    - If no rules match, default is to allow
--
-- 7. Encryption:
--    - cf_api_key should be encrypted in the application layer
--    - Consider using AES-256-GCM or similar
--    - Store encryption key in secure location (not in database)
--
-- 8. Performance:
--    - ACL checks should be fast (indexed on IP, priority, enabled)
--    - Consider caching ACL rules in memory
--    - Statistics table can grow large, consider partitioning by date
