-- API Tokens System Migration
-- Allows users to create API tokens for programmatic access

CREATE TABLE IF NOT EXISTS dnsadmin_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_name VARCHAR(255) NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  token_prefix VARCHAR(20) NOT NULL, -- First few chars for identification (e.g., "dnsm_abc123...")
  scopes JSON NOT NULL, -- Array of permissions: ["zones:read", "zones:write", "records:read", "records:write", "soa:read", "soa:write", "rr:read", "rr:write"]
  last_used DATETIME NULL,
  last_used_ip VARCHAR(45) NULL,
  expires_at DATETIME NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_token_hash (token_hash),
  INDEX idx_token_prefix (token_prefix),
  INDEX idx_active (active),
  FOREIGN KEY (user_id) REFERENCES dnsadmin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add API token usage logs
CREATE TABLE IF NOT EXISTS dnsadmin_token_usage (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token_id INT NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  method VARCHAR(10) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  user_agent TEXT,
  response_status INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_token_id (token_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (token_id) REFERENCES dnsadmin_tokens(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
