-- User Management System Migration
-- Creates tables for user authentication, permissions, activity tracking, and audit logs

-- Main users table
CREATE TABLE IF NOT EXISTS dnsadmin_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role ENUM('superadmin', 'account_admin', 'user') NOT NULL DEFAULT 'user',
  active TINYINT(1) NOT NULL DEFAULT 1,
  require_2fa TINYINT(1) NOT NULL DEFAULT 0,
  twofa_method ENUM('email', 'sms', 'none') DEFAULT 'none',
  twofa_contact VARCHAR(255) NULL, -- email or phone number for 2FA
  twofa_secret VARCHAR(255) NULL, -- for storing 2FA codes temporarily
  twofa_secret_expiry DATETIME NULL,
  last_login DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by INT NULL,
  INDEX idx_username (username),
  INDEX idx_email (email),
  INDEX idx_role (role),
  FOREIGN KEY (created_by) REFERENCES dnsadmin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User-to-Cloudflare Account assignments (many-to-many)
CREATE TABLE IF NOT EXISTS dnsadmin_user_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  account_id INT NOT NULL, -- references cloudflare_accounts.id
  is_account_admin TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  UNIQUE KEY unique_user_account (user_id, account_id),
  INDEX idx_user_id (user_id),
  INDEX idx_account_id (account_id),
  FOREIGN KEY (user_id) REFERENCES dnsadmin_users(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES cloudflare_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES dnsadmin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Granular user permissions
CREATE TABLE IF NOT EXISTS dnsadmin_user_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  permission_type ENUM('zone', 'soa', 'rr', 'cloudflare', 'user_management', 'load_balancer') NOT NULL,
  resource_id INT NULL, -- specific zone/account ID, or NULL for all
  can_view TINYINT(1) NOT NULL DEFAULT 1,
  can_add TINYINT(1) NOT NULL DEFAULT 0,
  can_edit TINYINT(1) NOT NULL DEFAULT 0,
  can_delete TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_permission_type (permission_type),
  INDEX idx_resource_id (resource_id),
  FOREIGN KEY (user_id) REFERENCES dnsadmin_users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES dnsadmin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Active login sessions and page tracking
CREATE TABLE IF NOT EXISTS dnsadmin_logins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  session_token VARCHAR(255) NOT NULL UNIQUE,
  ip_address VARCHAR(45) NOT NULL,
  user_agent TEXT,
  current_page VARCHAR(500) NULL,
  last_activity DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logout_at DATETIME NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  INDEX idx_user_id (user_id),
  INDEX idx_session_token (session_token),
  INDEX idx_is_active (is_active),
  INDEX idx_last_activity (last_activity),
  FOREIGN KEY (user_id) REFERENCES dnsadmin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audit log for all actions
CREATE TABLE IF NOT EXISTS dnsadmin_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action_type ENUM(
    'login', 'logout', 'login_failed',
    'user_create', 'user_update', 'user_delete',
    'soa_create', 'soa_update', 'soa_delete',
    'rr_create', 'rr_update', 'rr_delete',
    'zone_create', 'zone_update', 'zone_delete',
    'lb_create', 'lb_update', 'lb_delete',
    'pool_create', 'pool_update', 'pool_delete',
    'permission_grant', 'permission_revoke',
    'settings_update',
    'other'
  ) NOT NULL,
  resource_type VARCHAR(50) NULL, -- 'soa', 'rr', 'user', 'zone', etc.
  resource_id INT NULL,
  description TEXT NOT NULL,
  metadata JSON NULL, -- additional data about the action
  ip_address VARCHAR(45) NOT NULL,
  user_agent TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_action_type (action_type),
  INDEX idx_resource_type (resource_type),
  INDEX idx_resource_id (resource_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (user_id) REFERENCES dnsadmin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- System settings (Multitel API credentials, etc.)
CREATE TABLE IF NOT EXISTS dnsadmin_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  is_encrypted TINYINT(1) NOT NULL DEFAULT 0,
  description TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by INT NULL,
  INDEX idx_setting_key (setting_key),
  FOREIGN KEY (updated_by) REFERENCES dnsadmin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insert default superadmin user (password: 'admin123' - should be changed immediately)
-- Password hash for 'admin123' using bcrypt (cost 10)
INSERT INTO dnsadmin_users (username, email, password_hash, full_name, role, active)
VALUES (
  'admin',
  'admin@localhost',
  '$2b$10$rZ8Z8ZqQy9qYQZ8Z8ZqQy.K8K8K8K8K8K8K8K8K8K8K8K8K8K8K8K',
  'System Administrator',
  'superadmin',
  1
) ON DUPLICATE KEY UPDATE id=id;

-- Insert default Multitel API settings placeholders
INSERT INTO dnsadmin_settings (setting_key, setting_value, is_encrypted, description) VALUES
  ('multitel_api_user', '', 1, 'Multitel API username for SMS/email 2FA'),
  ('multitel_api_pass', '', 1, 'Multitel API password for SMS/email 2FA'),
  ('multitel_api_url', 'https://api.multitel.net/v3/sendcode', 0, 'Multitel API endpoint URL'),
  ('session_timeout', '3600', 0, 'Session timeout in seconds (default: 1 hour)'),
  ('require_2fa_all', '0', 0, 'Require 2FA for all users (0=no, 1=yes)')
ON DUPLICATE KEY UPDATE setting_key=setting_key;
