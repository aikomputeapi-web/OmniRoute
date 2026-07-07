-- 119_free_proxies_tiers.sql
-- Add tier tracking columns for 3-tier proxy pool system:
--   Tier 1 (bottom): freshly scraped proxies, tested before promotion
--   Tier 2 (middle): confirmed-working proxies, tested often
--   Tier 3 (top):   high-quality proxies used by OmniRoute for outbound requests
--
-- consecutive_successes / consecutive_failures track streaks for promotion/demotion decisions.
-- tier 3 proxies live in proxy_registry (in_pool=1); tiers 1-2 live only in free_proxies.

ALTER TABLE free_proxies ADD COLUMN tier INTEGER DEFAULT 1;
ALTER TABLE free_proxies ADD COLUMN consecutive_successes INTEGER DEFAULT 0;
ALTER TABLE free_proxies ADD COLUMN consecutive_failures INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_free_proxies_tier ON free_proxies(tier);

-- Existing promoted proxies (in_pool=1) should start at Tier 3
UPDATE free_proxies SET tier = 3 WHERE in_pool = 1;

-- Existing proxies that were being tested (in_pool=0, test_count > 0) start at Tier 2
UPDATE free_proxies SET tier = 2 WHERE in_pool = 0 AND test_count > 0;
