-- 101_free_proxies_stats.sql
-- Add test_count and success_count columns to free_proxies table to support multi-stage vetting.

ALTER TABLE free_proxies ADD COLUMN test_count INTEGER DEFAULT 0;
ALTER TABLE free_proxies ADD COLUMN success_count INTEGER DEFAULT 0;
