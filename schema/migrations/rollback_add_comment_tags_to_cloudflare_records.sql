-- Rollback Migration: Remove comment and tags columns from cloudflare_records table
-- Date: 2025-11-20
-- Reverts: add_comment_tags_to_cloudflare_records.sql

ALTER TABLE `cloudflare_records`
DROP COLUMN `tags`,
DROP COLUMN `comment`;
