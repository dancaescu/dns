-- Add date_created field to all tables for consistency
-- This provides a timestamp for when each record was originally created

-- Add date_created to dnsmanager tables
ALTER TABLE dnsmanager_users ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER updated_at;
ALTER TABLE dnsmanager_user_accounts ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER created_by;
ALTER TABLE dnsmanager_user_permissions ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER created_by;
ALTER TABLE dnsmanager_logins ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER is_active;
ALTER TABLE dnsmanager_logs ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER created_at;
ALTER TABLE dnsmanager_settings ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER updated_by;
ALTER TABLE dnsmanager_tokens ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER updated_at;
ALTER TABLE dnsmanager_token_usage ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER created_at;

-- Add date_created to MyDNS core tables
ALTER TABLE soa ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE rr ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Add date_created to Cloudflare tables
ALTER TABLE cloudflare_accounts ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cloudflare_zones ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cloudflare_records ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cloudflare_load_balancers ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cloudflare_pools ADD COLUMN IF NOT EXISTS date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
