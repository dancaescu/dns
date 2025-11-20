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
