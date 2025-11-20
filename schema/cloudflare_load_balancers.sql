CREATE TABLE IF NOT EXISTS `cloudflare_load_balancers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `zone_id` int NOT NULL,
  `cf_lb_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `proxied` tinyint(1) DEFAULT NULL,
  `enabled` tinyint(1) DEFAULT NULL,
  `fallback_pool` varchar(64) DEFAULT NULL,
  `default_pools` text,
  `steering_policy` varchar(32) DEFAULT NULL,
  `data` longtext,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_zone_lb` (`zone_id`,`cf_lb_id`),
  CONSTRAINT `fk_cf_lb_zone` FOREIGN KEY (`zone_id`) REFERENCES `cloudflare_zones` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
