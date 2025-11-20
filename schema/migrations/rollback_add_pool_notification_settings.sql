-- Rollback: Remove notification settings from cloudflare_lb_pools

ALTER TABLE `cloudflare_lb_pools`
DROP COLUMN `notification_health_status`,
DROP COLUMN `notification_enabled`;
