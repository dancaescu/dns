-- Migration: Add comment and tags columns to cloudflare_records table
-- Date: 2025-11-20

ALTER TABLE `cloudflare_records`
ADD COLUMN `comment` varchar(500) DEFAULT NULL AFTER `modified_on`,
ADD COLUMN `tags` varchar(500) DEFAULT NULL AFTER `comment`;
