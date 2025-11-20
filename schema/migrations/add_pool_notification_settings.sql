-- Add notification settings to cloudflare_lb_pools
-- Run date: 2025-11-20

ALTER TABLE `cloudflare_lb_pools`
ADD COLUMN `notification_enabled` tinyint(1) DEFAULT 0 AFTER `notification_email`,
ADD COLUMN `notification_health_status` varchar(16) DEFAULT 'either' AFTER `notification_enabled`;
