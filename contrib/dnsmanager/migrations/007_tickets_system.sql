-- Ticket System Migration
-- Creates tables for support ticket management with screenshot support

CREATE TABLE IF NOT EXISTS dnsmanager_tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  incident_date DATE NOT NULL,
  incident_hour TIME NOT NULL,
  incident_type ENUM('RR', 'SOA', 'Cloudflare', 'API', 'Other') NOT NULL DEFAULT 'Other',
  subject VARCHAR(500) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('open', 'in_progress', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  priority ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_incident_type (incident_type),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (user_id) REFERENCES dnsmanager_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ticket replies for ongoing conversation
CREATE TABLE IF NOT EXISTS dnsmanager_ticket_replies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  user_id INT NOT NULL,
  message TEXT NOT NULL,
  is_admin_reply TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticket_id (ticket_id),
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (ticket_id) REFERENCES dnsmanager_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES dnsmanager_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ticket attachments (screenshots, files, etc.)
CREATE TABLE IF NOT EXISTS dnsmanager_ticket_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  reply_id INT NULL,
  user_id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  file_data LONGBLOB NOT NULL,
  file_type VARCHAR(100) NOT NULL,
  file_size INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticket_id (ticket_id),
  INDEX idx_reply_id (reply_id),
  INDEX idx_user_id (user_id),
  FOREIGN KEY (ticket_id) REFERENCES dnsmanager_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (reply_id) REFERENCES dnsmanager_ticket_replies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES dnsmanager_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add email settings to dnsmanager_settings table
INSERT INTO dnsmanager_settings (setting_key, setting_value, is_encrypted, description) VALUES
  ('ticket_admin_email', '', 0, 'Email address to receive ticket notifications'),
  ('smtp_host', '', 0, 'SMTP server hostname'),
  ('smtp_port', '587', 0, 'SMTP server port'),
  ('smtp_user', '', 1, 'SMTP username'),
  ('smtp_pass', '', 1, 'SMTP password'),
  ('smtp_from_email', '', 0, 'From email address for outgoing tickets'),
  ('smtp_from_name', 'DNS Manager', 0, 'From name for outgoing tickets')
ON DUPLICATE KEY UPDATE setting_key=setting_key;
