-- Rollback: Remove load balancer pools and origins tables
-- This will delete all pool and origin data

DROP TABLE IF EXISTS `cloudflare_lb_pool_origins`;
DROP TABLE IF EXISTS `cloudflare_lb_pools`;
