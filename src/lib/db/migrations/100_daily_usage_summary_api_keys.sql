-- 077_daily_usage_summary_api_keys.sql
-- Add api_key_id and api_key_name to daily_usage_summary for key-level analytics beyond retention period

-- 1. Add columns with safe defaults (SQLite allows NOT NULL with DEFAULT for ALTER TABLE)
ALTER TABLE daily_usage_summary ADD COLUMN api_key_id TEXT NOT NULL DEFAULT '';
ALTER TABLE daily_usage_summary ADD COLUMN api_key_name TEXT NOT NULL DEFAULT '';

-- 2. Drop old unique constraint index that was restricted to provider, model, date
DROP INDEX IF EXISTS idx_daily_usage_unique;

-- 3. Re-create unique index including the key identifiers
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_usage_unique
  ON daily_usage_summary(provider, model, date, api_key_id, api_key_name);

-- 4. Create an index for querying by api_key_id
CREATE INDEX IF NOT EXISTS idx_daily_usage_api_key_id
  ON daily_usage_summary(api_key_id);
