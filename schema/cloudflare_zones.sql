CREATE TABLE IF NOT EXISTS `cloudflare_zones` (
  `id` int NOT NULL AUTO_INCREMENT,
  `account_id` int NOT NULL,
  `cf_zone_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `status` varchar(32) DEFAULT NULL,
  `paused` tinyint(1) DEFAULT '0',
  `zone_type` varchar(32) DEFAULT NULL,
  `plan_name` varchar(128) DEFAULT NULL,
  `favorite` tinyint(1) NOT NULL DEFAULT '0',
  `last_synced` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cf_zone_id` (`cf_zone_id`),
  KEY `fk_cf_zones_account` (`account_id`),
  CONSTRAINT `fk_cf_zones_account` FOREIGN KEY (`account_id`) REFERENCES `cloudflare_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
