-- 120_reconcile_free_proxy_pool_flags.sql
--
-- Reconcile drifted `free_proxies.tier` / `in_pool` bookkeeping against the
-- ground truth in `proxy_registry` + `proxy_assignments`.
--
-- Invariant (established by 119_free_proxies_tiers): a free proxy is genuinely
-- "in the pool" (Tier 3) IFF its `pool_proxy_id` references a registry row that
-- is actually routable — i.e. the registry row exists AND has at least one
-- assignment (global slot or account scope). Manual "Add to Pool" clicks and
-- migration 119 left rows flagged `in_pool = 1` whose registry row has no
-- assignment (never routed), plus rows marked `tier = 3` while `in_pool = 0`.
--
-- These UPDATEs are pure and idempotent (safe to re-run): they only touch rows
-- currently violating the invariant. They never delete registry rows or
-- assignments, so live routing is unaffected.

-- 1. Flagged pooled but NOT routable (registry row missing, or present with no
--    assignment): return to the auto-testing pipeline. A former Tier 3 row is
--    demoted to Tier 2 (it had been verified); other tiers keep their label.
UPDATE free_proxies
SET in_pool = 0,
    pool_proxy_id = NULL,
    tier = CASE WHEN tier = 3 THEN 2 ELSE tier END,
    consecutive_successes = 0,
    consecutive_failures = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE in_pool = 1
  AND NOT EXISTS (
    SELECT 1
    FROM proxy_assignments pa
    JOIN proxy_registry pr ON pr.id = pa.proxy_id
    WHERE pr.id = free_proxies.pool_proxy_id
  );

-- 2. Genuinely routable (registry row with an assignment) but mislabeled as a
--    lower tier: promote the label to Tier 3 to match reality.
UPDATE free_proxies
SET tier = 3,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE in_pool = 1
  AND tier <> 3
  AND EXISTS (
    SELECT 1
    FROM proxy_assignments pa
    JOIN proxy_registry pr ON pr.id = pa.proxy_id
    WHERE pr.id = free_proxies.pool_proxy_id
  );

-- 3. Marked Tier 3 while not in the pool: demote the label to the verified tier.
UPDATE free_proxies
SET tier = 2,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE in_pool = 0
  AND tier = 3;
