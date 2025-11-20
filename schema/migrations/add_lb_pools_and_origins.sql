-- Add load balancer pools and origins tables for comprehensive LB management
-- Run date: 2025-11-20

CREATE TABLE IF NOT EXISTS `cloudflare_lb_pools` (
  `id` int NOT NULL AUTO_INCREMENT,
  `lb_id` int NOT NULL,
  `cf_pool_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `enabled` tinyint(1) DEFAULT 1,
  `minimum_origins` int DEFAULT 1,
  `monitor` varchar(64) DEFAULT NULL,
  `notification_email` text,
  `health_check_regions` text,
  `latitude` decimal(10, 7) DEFAULT NULL,
  `longitude` decimal(10, 7) DEFAULT NULL,
  `load_shedding_default_percent` decimal(5, 2) DEFAULT 0,
  `load_shedding_default_policy` varchar(32) DEFAULT 'random',
  `load_shedding_session_percent` decimal(5, 2) DEFAULT 0,
  `load_shedding_session_policy` varchar(32) DEFAULT 'hash',
  `origin_steering_policy` varchar(32) DEFAULT 'random',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_lb_pool` (`lb_id`,`cf_pool_id`),
  CONSTRAINT `fk_pool_lb` FOREIGN KEY (`lb_id`) REFERENCES `cloudflare_load_balancers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `cloudflare_lb_pool_origins` (
  `id` int NOT NULL AUTO_INCREMENT,
  `pool_id` int NOT NULL,
  `name` varchar(255) NOT NULL,
  `address` varchar(255) NOT NULL,
  `enabled` tinyint(1) DEFAULT 1,
  `weight` decimal(5, 3) DEFAULT 1.000,
  `port` int DEFAULT NULL,
  `header_host` varchar(255) DEFAULT NULL,
  `header_origin` varchar(255) DEFAULT NULL,
  `virtual_network_id` varchar(64) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pool` (`pool_id`),
  CONSTRAINT `fk_origin_pool` FOREIGN KEY (`pool_id`) REFERENCES `cloudflare_lb_pools` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
