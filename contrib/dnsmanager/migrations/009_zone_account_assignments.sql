-- Migration: Add account_id to zones and create zone_account_assignments table
-- This enables admin to assign zones to account admins

-- Add account_id to SOA table for zone ownership
ALTER TABLE soa
  ADD COLUMN account_id INT NULL AFTER user_id,
  ADD INDEX idx_soa_account_id (account_id);

-- cloudflare_zones already has account_id column

-- Create zone_account_assignments table for many-to-many relationship
-- This allows multiple account admins to manage the same zone
CREATE TABLE IF NOT EXISTS dnsmanager_zone_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  zone_type ENUM('soa', 'cloudflare') NOT NULL,
  zone_id INT NOT NULL,
  account_id INT NOT NULL,
  assigned_by INT NOT NULL,
  can_view TINYINT(1) NOT NULL DEFAULT 1,
  can_add TINYINT(1) NOT NULL DEFAULT 0,
  can_edit TINYINT(1) NOT NULL DEFAULT 0,
  can_delete TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_zone_type_id (zone_type, zone_id),
  INDEX idx_account_id (account_id),
  INDEX idx_assigned_by (assigned_by),
  UNIQUE KEY unique_zone_account (zone_type, zone_id, account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Update dnsmanager_user_permissions to support account-level permissions
ALTER TABLE dnsmanager_user_permissions
  ADD COLUMN account_id INT NULL AFTER user_id,
  ADD COLUMN zone_type ENUM('soa', 'cloudflare') NULL AFTER permission_type,
  ADD INDEX idx_account_id (account_id),
  ADD INDEX idx_zone_type (zone_type);

-- Add API access permissions to tokens
ALTER TABLE dnsmanager_tokens
  ADD COLUMN can_use_api TINYINT(1) NOT NULL DEFAULT 0 AFTER active,
  ADD INDEX idx_can_use_api (can_use_api);
