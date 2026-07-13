/**
 * freeProxyJob.ts — 3-Tier Free Proxy Management
 *
 * Three-tier proxy pool system:
 *   Tier 1 (Bottom Pool): freshly scraped proxies dumped from providers.
 *     Tested each check cycle. 5+ consecutive successes → promoted to Tier 2.
 *     Any failure → deleted (untested scraped proxy that doesn't work).
 *
 *   Tier 2 (Middle Pool): verified-working proxies.
 *     Tested each check cycle (OFTEN). 2+ consecutive failures → demoted to Tier 1.
 *     High quality + low latency → promoted to Tier 3 during sync.
 *
 *   Tier 3 (Top Pool): proxies in proxy_registry global pool slots.
 *     Used by OmniRoute for outbound requests.
 *     Any failure → demoted to Tier 2.
 *
 * Demotion chain: Tier 3 fail → Tier 2 → Tier 2 fail streak → Tier 1 → Tier 1 fail → delete
 * Promotion chain: Tier 1 → 5 consecutive successes → Tier 2 → high quality → Tier 3
 */

import { getEnabledProviders } from "@/lib/freeProxyProviders";
import { createLogger } from "@/shared/utils/logger";
import { getDbInstance } from "@/lib/db/core";
import { getSettings } from "@/lib/db/settings";
import { getRecentProxyFailures } from "@/lib/proxyLogger";
import { randomUUID } from "crypto";

const PROXY_TEST_TARGETS = [
  "https://api.openai.com/v1/models",
  "https://api.anthropic.com/v1/messages",
  "https://oidc.us-east-1.amazonaws.com/",
];

/**
 * Injectable single-target proxy probe. Defaults to the real
 * `proxyFallback.testSingleProxy`; unit tests override it via
 * {@link _setProxyProbeForTests} so tier logic can be exercised without network.
 */
type SingleProxyProbe = (
  proxyUrl: string,
  targetUrl: string,
  timeoutMs: number
) => Promise<{ ok: boolean; latencyMs: number | null }>;

let singleProxyProbe: SingleProxyProbe | null = null;

/** Test seam: override the per-target proxy probe (pass null to restore the default). */
export function _setProxyProbeForTests(fn: SingleProxyProbe | null): void {
  singleProxyProbe = fn;
}

/**
 * Multi-target liveness probe: a proxy is considered "ok" only if it can reach
 * at least one of the configured provider endpoints. Testing more than just
 * api.openai.com catches proxies that are alive but geo/CDN-blocked for the
 * providers OmniRoute actually routes traffic to (AWS/Kiro, Anthropic, etc.).
 *
 * Returns the *reachable target's own* latency — each target is timed
 * independently so a proxy that can't reach api.openai.com but reaches
 * Anthropic instantly is not penalized with the earlier target's timeout baked
 * into its latency (which would sink its quality score and block promotion).
 * `ok:false` only if every target fails. Honors the caller's per-target timeout.
 */
export async function testProxyMultiTarget(
  proxyUrl: string,
  perTargetTimeoutMs: number
): Promise<{ ok: boolean; latencyMs: number | null }> {
  const probe =
    singleProxyProbe ?? (await import("@omniroute/open-sse/utils/proxyFallback")).testSingleProxy;
  let elapsed = 0;
  for (const target of PROXY_TEST_TARGETS) {
    const start = Date.now();
    try {
      const { ok, latencyMs } = await probe(proxyUrl, target, perTargetTimeoutMs);
      if (ok) {
        return { ok: true, latencyMs: latencyMs ?? Date.now() - start };
      }
    } catch {
      // try the next target
    }
    elapsed += Date.now() - start;
  }
  return { ok: false, latencyMs: elapsed };
}

type JobSettings = Awaited<ReturnType<typeof getJobSettings>>;

/** Threshold: number of recent real-request failures (from proxyLogger) above
 *  which a Tier 1/2 proxy is auto-removed/demoted without waiting for the next
 *  full probe. Tunable via settings.freeProxyLiveFailThreshold. */
const DEFAULT_LIVE_FAIL_THRESHOLD = 3;
/** Default cap on Tier 1 proxies probed per check tick (0 = unlimited). Keeps a
 *  large intake pool from overrunning the check interval; oldest-tested first so
 *  the whole pool still rotates across successive ticks. */
const DEFAULT_TIER1_TEST_BATCH_LIMIT = 750;
/** How far back to look for real-request failures. */
const LIVE_FAIL_WINDOW_MS = 5 * 60 * 1000;
/** Minimum live Tier 3 proxies before the low-pool alert fires. */
const LOW_POOL_THRESHOLD = 3;
let lastLowPoolAlertAt = 0;
const LOW_POOL_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

const log = createLogger("free-proxy-job");

async function emitProxyAlert(
  event: "proxy.demoted" | "proxy.pool-low",
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { dispatchEvent } = await import("@/lib/webhookDispatcher");
    await dispatchEvent(event, { source: "free-proxy-job", ...payload });
  } catch (err) {
    log.warn({ err, event }, "Failed to dispatch proxy alert (non-fatal)");
  }
}

const PROXY_NAME_PREFIX = "auto-us";
const GLOBAL_POOL_SIZE = 20;

let checkTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let currentSettingsHash: string = "";
let isCheckTickRunning = false;
let isSyncTickRunning = false;

async function getJobSettings() {
  try {
    const settings = await getSettings();
    const enabled =
      settings.freeProxyAutoJobEnabled === true ||
      (settings.freeProxyAutoJobEnabled === undefined &&
        process.env.FREE_PROXY_AUTO_JOB_ENABLED !== "false");

    const checkIntervalMin = Math.max(1, Number(settings.freeProxyCheckIntervalMin) || 5);
    const syncIntervalMin = Math.max(1, Number(settings.freeProxySyncIntervalMin) || 30);
    const countryFilter = String(
      settings.freeProxyCountryFilter || process.env.FREE_PROXY_COUNTRY_FILTER || "US"
    ).toUpperCase();

    let minQuality = 40;
    if (settings.freeProxyMinQuality !== undefined) {
      minQuality = Number(settings.freeProxyMinQuality);
    } else if (process.env.FREE_PROXY_AUTO_MIN_QUALITY) {
      minQuality = Number(process.env.FREE_PROXY_AUTO_MIN_QUALITY);
    }

    const minTests =
      settings.freeProxyMinTests !== undefined ? Number(settings.freeProxyMinTests) : 5;
    const minSuccessRate =
      settings.freeProxyMinSuccessRate !== undefined
        ? Number(settings.freeProxyMinSuccessRate)
        : 100;
    const autoElevate = settings.freeProxyAutoElevate !== false;
    const poolSize = Math.min(
      50,
      Math.max(5, Number(settings.freeProxyGlobalPoolSize) || GLOBAL_POOL_SIZE)
    );
    const autoRemoveDead = settings.freeProxyAutoRemoveDead !== false;
    const tier1PromoteThreshold = Number(settings.freeProxyTier1PromoteThreshold) || 5;
    const tier2PromoteThreshold = Number(settings.freeProxyTier2PromoteThreshold) || 10;
    const tier2DemoteThreshold = Number(settings.freeProxyTier2DemoteThreshold) || 3;
    const autoDistribute =
      settings.freeProxyAutoDistribute === true ||
      process.env.FREE_PROXY_AUTO_DISTRIBUTE === "true";
    const liveFailThreshold = Math.max(
      1,
      Number(settings.freeProxyLiveFailThreshold) || DEFAULT_LIVE_FAIL_THRESHOLD
    );
    // Cap on how many Tier 1 (bottom pool) proxies are probed per check tick.
    // Tier 1 can hold thousands of freshly-scraped proxies; probing all of them
    // (3 targets × 5s each) can overrun the check interval and starve later
    // ticks. Oldest-tested rows are probed first so the whole pool still rotates
    // across ticks. 0 = unlimited (historical behaviour).
    const tier1TestBatchLimit = Math.max(
      0,
      settings.freeProxyTier1TestBatchLimit !== undefined
        ? Number(settings.freeProxyTier1TestBatchLimit)
        : DEFAULT_TIER1_TEST_BATCH_LIMIT
    );

    return {
      enabled,
      checkIntervalMs: checkIntervalMin * 60 * 1000,
      syncIntervalMs: syncIntervalMin * 60 * 1000,
      countryFilter,
      minQuality,
      minTests,
      minSuccessRate,
      autoElevate,
      poolSize,
      autoRemoveDead,
      tier1PromoteThreshold,
      tier2PromoteThreshold,
      tier2DemoteThreshold,
      liveFailThreshold,
      tier1TestBatchLimit,
      autoDistribute,
    };
  } catch (err) {
    log.warn({ err }, "Failed to get settings for free proxy job, using defaults");
    return {
      enabled: process.env.FREE_PROXY_AUTO_JOB_ENABLED !== "false",
      checkIntervalMs: 10 * 60 * 1000,
      syncIntervalMs: 30 * 60 * 1000,
      countryFilter: (process.env.FREE_PROXY_COUNTRY_FILTER || "US").toUpperCase(),
      minQuality: 40,
      minTests: 5,
      minSuccessRate: 100,
      autoElevate: true,
      poolSize: 20,
      autoRemoveDead: true,
      tier1PromoteThreshold: 5,
      tier2PromoteThreshold: 10,
      tier2DemoteThreshold: 3,
      liveFailThreshold: DEFAULT_LIVE_FAIL_THRESHOLD,
      tier1TestBatchLimit: DEFAULT_TIER1_TEST_BATCH_LIMIT,
      autoDistribute: process.env.FREE_PROXY_AUTO_DISTRIBUTE === "true",
    };
  }
}

function getSettingsHash(s: Awaited<ReturnType<typeof getJobSettings>>) {
  return `${s.enabled}:${s.checkIntervalMs}:${s.syncIntervalMs}:${s.countryFilter}:${s.minQuality}:${s.minTests}:${s.minSuccessRate}:${s.autoElevate}:${s.tier1PromoteThreshold}:${s.tier2PromoteThreshold}:${s.tier2DemoteThreshold}`;
}

// ---------------------------------------------------------------------------
// Sync all enabled free proxy providers
// ---------------------------------------------------------------------------

async function syncFreeProxySources(): Promise<void> {
  const providers = getEnabledProviders();
  if (providers.length === 0) {
    log.info("No free proxy providers enabled — skipping sync");
    return;
  }

  for (const provider of providers) {
    try {
      const result = await provider.sync();
      log.info(
        {
          provider: provider.id,
          fetched: result.fetched,
          added: result.added,
          updated: result.updated,
          errors: result.errors.length,
        },
        "Provider sync complete"
      );
      if (result.errors.length > 0) {
        log.debug({ provider: provider.id, errors: result.errors }, "Provider sync had errors");
      }
    } catch (err) {
      log.warn({ err, provider: provider.id }, "Provider sync threw unexpectedly");
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: compute quality score from latency
// ---------------------------------------------------------------------------

function computeQualityScore(latencyMs: number | null): number {
  if (!latencyMs) return 60;
  const timeoutSec = latencyMs / 1000;
  if (timeoutSec <= 0.1) return 95;
  if (timeoutSec <= 0.5) return 85;
  if (timeoutSec <= 1.0) return 75;
  if (timeoutSec <= 2.0) return 65;
  if (timeoutSec <= 5.0) return 50;
  if (timeoutSec <= 10.0) return 35;
  return 20;
}

// ---------------------------------------------------------------------------
// Promote a free_proxy into the global pool (Tier 3)
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  host: string;
  port: number;
  type: string;
  quality_score: number | null;
  latency_ms: number | null;
}

async function promoteProxyToGlobal(
  candidate: CandidateRow,
  country: string,
  poolSize: number = GLOBAL_POOL_SIZE
): Promise<void> {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const proxyUrl = `${candidate.type}://${candidate.host}:${candidate.port}`;

  const existing = db
    .prepare(
      `SELECT pr.id FROM proxy_registry pr
       JOIN proxy_assignments pa ON pa.proxy_id = pr.id
       WHERE pa.scope = 'global'
         AND pr.source = 'auto-us'
         AND pr.host = ? AND pr.port = ?
       LIMIT 1`
    )
    .get(candidate.host, candidate.port) as { id: string } | undefined;

  if (existing) {
    db.prepare("UPDATE proxy_registry SET status = 'active', updated_at = ? WHERE id = ?").run(
      now,
      existing.id
    );
    db.prepare("UPDATE free_proxies SET tier = 3, in_pool = 1, updated_at = ? WHERE id = ?").run(
      now,
      candidate.id
    );
    return;
  }

  const newId = randomUUID();
  db.prepare(
    `INSERT INTO proxy_registry
     (id, name, type, host, port, username, password, region, notes, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', '', ?, ?, 'active', ?, ?, ?)`
  ).run(
    newId,
    `${PROXY_NAME_PREFIX}-${candidate.host}`,
    candidate.type,
    candidate.host,
    candidate.port,
    country,
    `Auto-selected ${country} proxy`,
    "auto-us",
    now,
    now
  );

  // Find an empty slot in the global pool (0..poolSize-1) or replace the oldest/worst
  const existingPool = db
    .prepare(
      `SELECT pa.scope_id, pr.quality_score, pr.updated_at FROM proxy_assignments pa
       JOIN proxy_registry pr ON pr.id = pa.proxy_id
       WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
       ORDER BY CAST(SUBSTR(pa.scope_id, 11) AS INTEGER) ASC`
    )
    .all() as Array<{ scope_id: string; quality_score: number | null; updated_at: string }>;

  const usedSlots = new Set<number>();
  for (const entry of existingPool) {
    const slotNum = parseInt(entry.scope_id.replace("__global__", ""), 10);
    if (!isNaN(slotNum)) usedSlots.add(slotNum);
  }

  let targetSlot = -1;
  for (let i = 0; i < poolSize; i++) {
    if (!usedSlots.has(i)) {
      targetSlot = i;
      break;
    }
  }

  if (targetSlot === -1) {
    // Pool full — replace the proxy with lowest quality score
    const worst = db
      .prepare(
        `SELECT pa.scope_id, pr.id FROM proxy_assignments pa
         JOIN proxy_registry pr ON pr.id = pa.proxy_id
         WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
         ORDER BY pr.quality_score ASC, pr.updated_at ASC
         LIMIT 1`
      )
      .get() as { scope_id: string; id: string } | undefined;

    if (worst) {
      // Demote the worst proxy back to Tier 2 instead of deleting
      const worstFreeProxy = db
        .prepare("SELECT id FROM free_proxies WHERE pool_proxy_id = ?")
        .get(worst.id) as { id?: string } | undefined;
      if (worstFreeProxy?.id) {
        db.prepare(
          "UPDATE free_proxies SET tier = 2, in_pool = 0, pool_proxy_id = NULL, consecutive_successes = 0, consecutive_failures = 0, updated_at = ? WHERE id = ?"
        ).run(now, worstFreeProxy.id);
      }
      db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(worst.id);
      db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(worst.id);
      targetSlot = parseInt(worst.scope_id.replace("__global__", ""), 10) || 0;
    }
  }

  if (targetSlot >= 0) {
    db.prepare(
      `INSERT INTO proxy_assignments (scope, scope_id, proxy_id, created_at, updated_at)
       VALUES ('global', ?, ?, ?, ?)`
    ).run(`__global__${targetSlot}`, newId, now, now);
  }

  // Mark the free_proxies record as Tier 3 and link it to the registry row
  db.prepare(
    "UPDATE free_proxies SET tier = 3, in_pool = 1, pool_proxy_id = ?, updated_at = ? WHERE id = ?"
  ).run(newId, now, candidate.id);

  log.info(
    {
      host: candidate.host,
      port: candidate.port,
      type: candidate.type,
      url: proxyUrl,
      slot: targetSlot,
    },
    `Promoted ${country} proxy to global pool (Tier 3) slot ${targetSlot}`
  );
}

// ---------------------------------------------------------------------------
// Demote a Tier 3 proxy back to Tier 1
// ---------------------------------------------------------------------------

/**
 * Demote a Tier 3 (global pool) proxy down to `targetTier` (2 or 1). The
 * registry row + all its assignments are removed (the proxy is no longer live)
 * and the linked `free_proxies` row is reset to the target tier.
 *
 * `failureHeadStart` pre-seeds `consecutive_failures` in the target tier so the
 * next failed check trips that tier's demote rule immediately. This restores the
 * documented cascade "Tier 3 fails → Tier 2; if it fails again → Tier 1": an
 * automatic liveness demotion targets Tier 2 with failureHeadStart =
 * (tier2 demote threshold − 1), so one more Tier 2 check failure drops it to
 * Tier 1 — while a *recovery* clears the counter and keeps the proxy in the
 * verified pool instead of dumping proven capacity back to intake.
 */
export async function demoteTier3Proxy(
  registryId: string,
  host: string,
  targetTier: 1 | 2,
  failureHeadStart = 0
): Promise<void> {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const freeProxy = db
    .prepare("SELECT id FROM free_proxies WHERE pool_proxy_id = ?")
    .get(registryId) as { id?: string } | undefined;

  db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(registryId);
  db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(registryId);

  if (freeProxy?.id) {
    db.prepare(
      "UPDATE free_proxies SET tier = ?, in_pool = 0, pool_proxy_id = NULL, consecutive_successes = 0, consecutive_failures = ?, updated_at = ? WHERE id = ?"
    ).run(targetTier, Math.max(0, failureHeadStart), now, freeProxy.id);
    log.info({ host, targetTier, failureHeadStart }, `Demoted Tier 3 proxy to Tier ${targetTier}`);
  } else {
    log.info({ host, registryId }, "Removed Tier 3 proxy (no free_proxies record to demote)");
  }
}

/**
 * Back-compat wrapper: hard-demote a Tier 3 proxy straight to Tier 1. Used by
 * the manual "remove selection" action in the Proxy Control Center. Automatic
 * liveness demotions use {@link demoteTier3Proxy} with `targetTier = 2`.
 */
export async function demoteTier3ToTier1(registryId: string, host: string): Promise<void> {
  await demoteTier3Proxy(registryId, host, 1, 0);
}

// ---------------------------------------------------------------------------
// Auto-distribute Tier 3 proxies across provider accounts
// Spreads live global-pool proxies so no two accounts of the same provider
// share an egress IP. Strict 1:1 — extras are left unassigned rather than shared.
// ---------------------------------------------------------------------------

export async function distributeProxiesToAccounts(): Promise<{
  providers: number;
  assigned: number;
  unassigned: number;
}> {
  const db = getDbInstance();

  // 1. Collect live Tier 3 proxy IDs from the global pool (auto-us proxies only)
  const liveProxies = db
    .prepare(
      `SELECT pr.id FROM proxy_registry pr
       JOIN proxy_assignments pa ON pa.proxy_id = pr.id
       WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
         AND pr.source = 'auto-us' AND pr.status = 'active'
       ORDER BY pr.quality_score DESC, pr.updated_at DESC`
    )
    .all() as Array<{ id: string }>;
  const liveProxyIds = liveProxies.map((p) => p.id);

  if (liveProxyIds.length === 0) {
    log.info("Auto-distribute: no live Tier 3 proxies — skipping distribution");
    return { providers: 0, assigned: 0, unassigned: 0 };
  }

  // 2. Load active provider connections grouped by provider
  const { getProviderConnections } = await import("@/lib/db/providers");
  const connections = (await getProviderConnections({ isActive: true })) as Array<{
    id: string;
    provider: string;
    name?: string;
    email?: string | null;
  }>;

  if (connections.length === 0) {
    log.info("Auto-distribute: no active provider connections — skipping distribution");
    return { providers: 0, assigned: 0, unassigned: 0 };
  }

  // 3. Group connections by provider so each provider gets its own 1:1 spread
  const byProvider = new Map<string, Array<{ id: string; account: string }>>();
  for (const c of connections) {
    const provider = c.provider || "unknown";
    const account = c.email || c.name || c.id.slice(0, 8);
    const arr = byProvider.get(provider) ?? [];
    arr.push({ id: c.id, account });
    byProvider.set(provider, arr);
  }

  // 4. For each provider, plan + apply a strict 1:1 distribution (no sharing)
  const { planProxyDistribution, applyProxyDistribution } = await import("@/lib/proxyEgress");
  let totalAssigned = 0;
  let totalUnassigned = 0;

  for (const [provider, conns] of byProvider) {
    const plan = planProxyDistribution(conns, liveProxyIds, { allowSharing: false });
    const { applied } = await applyProxyDistribution(plan);
    totalAssigned += applied;
    totalUnassigned += plan.unassigned.length;
    log.info(
      {
        provider,
        connections: conns.length,
        assigned: applied,
        unassigned: plan.unassigned.length,
      },
      plan.sharingRisk
        ? "Auto-distribute plan had sharing risk"
        : "Auto-distribute complete for provider"
    );
  }

  log.info(
    { providers: byProvider.size, assigned: totalAssigned, unassigned: totalUnassigned },
    "Auto-distribute complete — Tier 3 proxies spread across provider accounts (1:1, no same-provider sharing)"
  );

  return { providers: byProvider.size, assigned: totalAssigned, unassigned: totalUnassigned };
}

// ---------------------------------------------------------------------------
// Shared: promote the best verified Tier 2 proxies into the active pool (Tier 3)
// ---------------------------------------------------------------------------

/**
 * Select the best already-verified Tier 2 proxies (by quality/latency, gated on
 * `minTests`, `minQuality`, and `minSuccessRate`), liveness-test them, and
 * promote up to `maxToPromote` live ones into the global pool. Returns the count
 * promoted.
 *
 * Both ticks call this: the sync tick tops up / upgrades the pool on its slower
 * cadence, and the check tick calls it at the end with the number of *open*
 * slots so a proxy demoted earlier in the same tick is backfilled immediately
 * instead of leaving an account unrouted until the next sync (up to 30 min).
 */
async function promoteBestTier2ToGlobal(
  settings: JobSettings,
  maxToPromote: number
): Promise<number> {
  if (maxToPromote <= 0) return 0;
  const db = getDbInstance();

  // `success_count = test_count` (a perfect lifetime record) was previously
  // hardcoded; wiring minSuccessRate lets the operator accept, e.g., ≥95%.
  const successRateClause = "test_count > 0 AND (success_count * 100.0 / test_count) >= ?";
  const query =
    settings.countryFilter === "ALL"
      ? `SELECT id, host, port, type, quality_score, latency_ms
         FROM free_proxies
         WHERE tier = 2 AND in_pool = 0
           AND test_count >= ? AND ${successRateClause} AND quality_score >= ?
         ORDER BY quality_score DESC,
           CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END, latency_ms ASC
         LIMIT ?`
      : `SELECT id, host, port, type, quality_score, latency_ms
         FROM free_proxies
         WHERE tier = 2 AND in_pool = 0 AND UPPER(country_code) = ?
           AND test_count >= ? AND ${successRateClause} AND quality_score >= ?
         ORDER BY quality_score DESC,
           CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END, latency_ms ASC
         LIMIT ?`;

  const candidateLimit = maxToPromote * 2;
  const params =
    settings.countryFilter === "ALL"
      ? [settings.minTests, settings.minSuccessRate, settings.minQuality, candidateLimit]
      : [
          settings.countryFilter,
          settings.minTests,
          settings.minSuccessRate,
          settings.minQuality,
          candidateLimit,
        ];

  const candidates = db.prepare(query).all(...params) as CandidateRow[];
  if (candidates.length === 0) return 0;

  const testResults = await Promise.all(
    candidates.slice(0, 30).map(async (row) => {
      const url = `${row.type}://${row.host}:${row.port}`;
      const { ok } = await testProxyMultiTarget(url, 5000);
      return { row, ok };
    })
  );

  const alive = testResults.filter((r) => r.ok).map((r) => r.row);
  let promoted = 0;
  for (const candidate of alive.slice(0, maxToPromote)) {
    await promoteProxyToGlobal(candidate, settings.countryFilter, settings.poolSize);
    promoted++;
  }
  return promoted;
}

/** Current live count of auto-us proxies occupying global-pool slots. */
function countLiveGlobalPool(): number {
  const row = getDbInstance()
    .prepare(
      `SELECT COUNT(*) as n FROM proxy_registry pr
       JOIN proxy_assignments pa ON pa.proxy_id = pr.id
       WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
         AND pr.source = 'auto-us'`
    )
    .get() as { n: number };
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Main check tick — tests all tiers and handles promotion/demotion
// ---------------------------------------------------------------------------

export async function runFreeProxyCheckTick(settingsSnapshot?: JobSettings): Promise<void> {
  if (isCheckTickRunning) {
    log.warn("Free proxy check tick skipped because a previous run is still in progress");
    return;
  }

  isCheckTickRunning = true;
  try {
    log.info("Free proxy check tick started");
    const settings = settingsSnapshot ?? (await getJobSettings());

    // ================================================================
    // 0. Pull recent real-request failures from proxyLogger and
    //    fast-demote Tier 3 / Tier 2 proxies that are failing live
    //    traffic before spending time on periodic probes.
    // ================================================================
    let liveFailures: Map<string, number>;
    try {
      liveFailures = getRecentProxyFailures(LIVE_FAIL_WINDOW_MS);
      if (liveFailures.size > 0) {
        log.info(
          { failingProxies: liveFailures.size, windowMs: LIVE_FAIL_WINDOW_MS },
          "Found proxies with recent real-request failures"
        );
      }
    } catch (err) {
      liveFailures = new Map();
      log.warn({ err }, "Failed to read recent proxy failures (non-fatal)");
    }
    const liveFailThreshold = settings.liveFailThreshold;
    // A failing Tier 3 proxy cascades to Tier 2 with consecutive_failures
    // pre-seeded to (tier2 demote threshold − 1) so one more Tier 2 failure
    // drops it to Tier 1, but a recovery keeps it in the verified pool.
    const tier3DemoteHeadStart = Math.max(0, settings.tier2DemoteThreshold - 1);
    // Scale the low-pool alert to the configured pool size (floor at the
    // hardcoded minimum) so a large pool sitting mostly empty still alerts.
    const lowPoolThreshold = Math.max(LOW_POOL_THRESHOLD, Math.ceil(settings.poolSize / 4));

    // ================================================================
    // 1. Test Tier 3 (global pool proxies) — any failure = demote to Tier 2
    //    PARALLELIZED (was sequential). Tier 3 is the hot path used for
    //    real traffic; the serial loop made each tick slow and increased
    //    the chance of the overlap guard kicking in.
    // ================================================================
    try {
      const db = getDbInstance();
      const poolProxies = db
        .prepare(
          `SELECT pr.id, pr.type, pr.host, pr.port FROM proxy_registry pr
         JOIN proxy_assignments pa ON pa.proxy_id = pr.id
         WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
           AND pr.source = 'auto-us'`
        )
        .all() as Array<{ id: string; type: string; host: string; port: number }>;

      if (poolProxies.length > 0) {
        log.info({ count: poolProxies.length }, "Testing Tier 3 (global pool) proxies");

        const chunk = <T>(arr: T[], size: number): T[][] =>
          Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
            arr.slice(i * size, i * size + size)
          );

        const chunks = chunk(poolProxies, 50);
        for (const batch of chunks) {
          await Promise.all(
            batch.map(async (pp) => {
              // Fast-path demote on accumulated real-request failures (no probe needed).
              const key = `${pp.host}:${pp.port}`;
              if ((liveFailures.get(key) ?? 0) >= liveFailThreshold) {
                await demoteTier3Proxy(pp.id, pp.host, 2, tier3DemoteHeadStart);
                await emitProxyAlert("proxy.demoted", {
                  tier: 3,
                  host: pp.host,
                  port: pp.port,
                  reason: "live-request-failures",
                  failures: liveFailures.get(key),
                });
                return;
              }
              try {
                const url = `${pp.type}://${pp.host}:${pp.port}`;
                const { ok } = await testProxyMultiTarget(url, 5000);
                if (!ok) {
                  await demoteTier3Proxy(pp.id, pp.host, 2, tier3DemoteHeadStart);
                  await emitProxyAlert("proxy.demoted", {
                    tier: 3,
                    host: pp.host,
                    port: pp.port,
                    reason: "liveness-failed",
                  });
                } else {
                  // Single source of truth: the multi-target probe that governs
                  // tiering also governs routing. Refresh status to 'active' so a
                  // stale 'error' left by another sweep (egress/ipify or the
                  // registry-wide proxyHealth scheduler) can't keep a proven live
                  // proxy out of PROXY_ALIVE_PREDICATE rotation.
                  db.prepare(
                    "UPDATE proxy_registry SET status = 'active', updated_at = ? WHERE id = ? AND status IS NOT 'active'"
                  ).run(new Date().toISOString(), pp.id);
                }
              } catch {
                await demoteTier3Proxy(pp.id, pp.host, 2, tier3DemoteHeadStart);
              }
            })
          );
        }

        // Low-live-pool alert (rate-limited).
        const remaining = db
          .prepare(
            `SELECT COUNT(*) as n FROM proxy_registry pr
           JOIN proxy_assignments pa ON pa.proxy_id = pr.id
           WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
             AND pr.source = 'auto-us'`
          )
          .get() as { n: number };
        const liveCount = Number(remaining?.n ?? 0);
        if (
          liveCount < lowPoolThreshold &&
          Date.now() - lastLowPoolAlertAt > LOW_POOL_ALERT_COOLDOWN_MS
        ) {
          lastLowPoolAlertAt = Date.now();
          log.warn({ liveCount, threshold: lowPoolThreshold }, "Live proxy pool below threshold");
          await emitProxyAlert("proxy.pool-low", { liveCount, threshold: lowPoolThreshold });
        }
      }
    } catch (err) {
      log.warn({ err }, "Tier 3 validation failed (non-fatal)");
    }

    // NOTE: the tier logic above is now the single liveness authority for the
    // auto-us pool — it both tiers proxies and refreshes proxy_registry.status
    // from the same multi-target probe. The previous validateProxyPool() call
    // here re-probed the whole registry with a *different* definition (ipify
    // egress echo) and could flip a proxy the tier system just confirmed live
    // to status='error', silently pulling it from routing. Registry-wide
    // liveness for user-configured proxies is owned by proxyHealth/scheduler.ts
    // (conservative, tri-state, #6246), so this redundant conflicting sweep is
    // removed rather than reconciled.

    // ================================================================
    // 2. Test Tier 2 (middle pool) — demote to Tier 1 on failure streak
    // ================================================================
    try {
      const db = getDbInstance();
      const query =
        settings.countryFilter === "ALL"
          ? "SELECT id, type, host, port, country_code, consecutive_successes, consecutive_failures FROM free_proxies WHERE tier = 2 AND in_pool = 0"
          : "SELECT id, type, host, port, country_code, consecutive_successes, consecutive_failures FROM free_proxies WHERE tier = 2 AND in_pool = 0 AND UPPER(country_code) = ?";

      const params = settings.countryFilter === "ALL" ? [] : [settings.countryFilter];
      const tier2Proxies = db.prepare(query).all(...params) as Array<{
        id: string;
        type: string;
        host: string;
        port: number;
        country_code: string | null;
        consecutive_successes: number;
        consecutive_failures: number;
      }>;

      if (tier2Proxies.length > 0) {
        log.info({ count: tier2Proxies.length }, "Testing Tier 2 (middle pool) proxies");

        const { recordFreeProxyTestResult, setFreeProxyTier, resetFreeProxyConsecutiveCounters } =
          await import("@/lib/db/freeProxies");

        // Tier 2 proxies that reached the consecutive-success threshold on this
        // tick, queued for promotion to the active pool (Tier 3). Collected then
        // promoted sequentially after the batch to avoid concurrent global-slot
        // races inside promoteProxyToGlobal.
        const promotionQueue: Array<CandidateRow & { country: string }> = [];

        const chunk = <T>(arr: T[], size: number): T[][] =>
          Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
            arr.slice(i * size, i * size + size)
          );

        const chunks = chunk(tier2Proxies, 50);
        for (const batch of chunks) {
          await Promise.all(
            batch.map(async (item) => {
              // Fast-demote on accumulated real-request failures (no probe needed).
              const key = `${item.host}:${item.port}`;
              if ((liveFailures.get(key) ?? 0) >= liveFailThreshold) {
                await setFreeProxyTier(item.id, 1);
                await resetFreeProxyConsecutiveCounters(item.id);
                log.info(
                  { host: item.host },
                  "Tier 2 proxy demoted to Tier 1 (live-request failures)"
                );
                await emitProxyAlert("proxy.demoted", {
                  tier: 2,
                  host: item.host,
                  port: item.port,
                  reason: "live-request-failures",
                });
                return;
              }
              const url = `${item.type}://${item.host}:${item.port}`;
              try {
                const { ok, latencyMs } = await testProxyMultiTarget(url, 5000);
                const quality = computeQualityScore(latencyMs);
                if (ok) {
                  await recordFreeProxyTestResult(item.id, true, latencyMs, quality);
                  // Verified → live: a Tier 2 proxy that strings together
                  // `tier2PromoteThreshold` consecutive successful checks has
                  // proven itself and is promoted to the active pool (Tier 3).
                  // This is the primary every-tick path that keeps Tier 3
                  // topped up; the slower sync-tick promotion is a backstop.
                  if (
                    settings.autoElevate &&
                    item.consecutive_successes + 1 >= settings.tier2PromoteThreshold
                  ) {
                    promotionQueue.push({
                      id: item.id,
                      host: item.host,
                      port: item.port,
                      type: item.type,
                      quality_score: quality,
                      latency_ms: latencyMs,
                      country: item.country_code || settings.countryFilter,
                    });
                  }
                } else {
                  const newFailCount = item.consecutive_failures + 1;
                  await recordFreeProxyTestResult(item.id, false, latencyMs, quality);
                  if (newFailCount >= settings.tier2DemoteThreshold) {
                    await setFreeProxyTier(item.id, 1);
                    await resetFreeProxyConsecutiveCounters(item.id);
                    log.info(
                      { host: item.host },
                      "Tier 2 proxy demoted to Tier 1 (failure streak)"
                    );
                  }
                }
              } catch (err) {
                await recordFreeProxyTestResult(item.id, false, null, 0);
                const newFailCount = item.consecutive_failures + 1;
                if (newFailCount >= settings.tier2DemoteThreshold) {
                  await setFreeProxyTier(item.id, 1);
                  await resetFreeProxyConsecutiveCounters(item.id);
                  log.info({ host: item.host }, "Tier 2 proxy demoted to Tier 1 (error streak)");
                }
              }
            })
          );
        }

        // Promote the accumulated Tier 2 winners to the active global pool
        // (Tier 3), sequentially and capped at poolSize so a large backlog can't
        // overflow the pool in one tick.
        const maxPromotions = Math.min(promotionQueue.length, Math.max(1, settings.poolSize));
        let promoted = 0;
        for (let i = 0; i < maxPromotions; i++) {
          const candidate = promotionQueue[i];
          try {
            await promoteProxyToGlobal(candidate, candidate.country, settings.poolSize);
            await resetFreeProxyConsecutiveCounters(candidate.id);
            promoted++;
            log.info(
              { host: candidate.host, port: candidate.port },
              "Tier 2 proxy promoted to Tier 3 (consecutive-success streak)"
            );
          } catch (err) {
            log.warn({ err, host: candidate.host }, "Tier 2 → Tier 3 promotion failed (non-fatal)");
          }
        }
        if (promotionQueue.length > 0) {
          log.info(
            { eligible: promotionQueue.length, promoted },
            "Tier 2 → Tier 3 fast-promotion pass complete"
          );
        }
      }
    } catch (err) {
      log.warn({ err }, "Tier 2 proxy testing failed (non-fatal)");
    }

    // ================================================================
    // 3. Test Tier 1 (bottom pool) — promote to Tier 2 on success streak,
    //    delete on 5 consecutive failures
    // ================================================================
    try {
      const db = getDbInstance();
      // Probe the least-recently-validated rows first so the intake pool rotates
      // evenly across ticks; cap the batch (unless unlimited) to keep a large
      // Tier 1 from overrunning the check interval. NULLs (never validated) sort
      // first under ASC, so brand-new scrapes are still probed promptly.
      const orderClause = " ORDER BY last_validated ASC";
      const limitClause = settings.tier1TestBatchLimit > 0 ? " LIMIT ?" : "";
      const baseWhere =
        settings.countryFilter === "ALL"
          ? "SELECT id, type, host, port, consecutive_successes, consecutive_failures FROM free_proxies WHERE tier = 1 AND in_pool = 0"
          : "SELECT id, type, host, port, consecutive_successes, consecutive_failures FROM free_proxies WHERE tier = 1 AND in_pool = 0 AND UPPER(country_code) = ?";
      const query = baseWhere + orderClause + limitClause;

      const params: Array<string | number> =
        settings.countryFilter === "ALL" ? [] : [settings.countryFilter];
      if (settings.tier1TestBatchLimit > 0) params.push(settings.tier1TestBatchLimit);
      const tier1Proxies = db.prepare(query).all(...params) as Array<{
        id: string;
        type: string;
        host: string;
        port: number;
        consecutive_successes: number;
        consecutive_failures: number;
      }>;

      if (tier1Proxies.length > 0) {
        log.info({ count: tier1Proxies.length }, "Testing Tier 1 (bottom pool) proxies");

        const {
          recordFreeProxyTestResult,
          setFreeProxyTier,
          deleteFreeProxy,
          resetFreeProxyConsecutiveCounters,
        } = await import("@/lib/db/freeProxies");

        const chunk = <T>(arr: T[], size: number): T[][] =>
          Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
            arr.slice(i * size, i * size + size)
          );

        const chunks = chunk(tier1Proxies, 50);
        for (const batch of chunks) {
          await Promise.all(
            batch.map(async (item) => {
              // Fast-delete on accumulated real-request failures (no probe
              // needed) — only when the operator allows dead-proxy removal.
              const key = `${item.host}:${item.port}`;
              if ((liveFailures.get(key) ?? 0) >= liveFailThreshold) {
                if (settings.autoRemoveDead) {
                  await deleteFreeProxy(item.id);
                  log.info({ host: item.host }, "Tier 1 proxy removed (live-request failures)");
                }
                return;
              }
              const url = `${item.type}://${item.host}:${item.port}`;
              try {
                const { ok, latencyMs } = await testProxyMultiTarget(url, 5000);
                const quality = computeQualityScore(latencyMs);
                if (ok) {
                  await recordFreeProxyTestResult(item.id, true, latencyMs, quality);
                  const newSuccessCount = item.consecutive_successes + 1;
                  if (newSuccessCount >= settings.tier1PromoteThreshold) {
                    await setFreeProxyTier(item.id, 2);
                    await resetFreeProxyConsecutiveCounters(item.id);
                    log.info(
                      { host: item.host },
                      "Tier 1 proxy promoted to Tier 2 (success streak)"
                    );
                  }
                } else {
                  await recordFreeProxyTestResult(item.id, false, latencyMs, quality);
                  const newFailCount = item.consecutive_failures + 1;
                  if (settings.autoRemoveDead && newFailCount >= 5) {
                    await deleteFreeProxy(item.id);
                    log.info({ host: item.host }, "Tier 1 proxy deleted (5 consecutive failures)");
                  }
                }
              } catch (err) {
                await recordFreeProxyTestResult(item.id, false, null, 0);
                const newFailCount = item.consecutive_failures + 1;
                if (settings.autoRemoveDead && newFailCount >= 5) {
                  await deleteFreeProxy(item.id);
                  log.info({ host: item.host }, "Tier 1 proxy deleted (5 consecutive failures)");
                }
              }
            })
          );
        }
      }
    } catch (err) {
      log.warn({ err }, "Tier 1 proxy testing failed (non-fatal)");
    }

    // ================================================================
    // 4. Instant backfill — fill any global-pool slots freed by demotions
    //    this tick from the best verified Tier 2 proxies, so a demoted live
    //    proxy does not leave an account unrouted until the next sync tick.
    // ================================================================
    if (settings.autoElevate) {
      try {
        const openSlots = settings.poolSize - countLiveGlobalPool();
        if (openSlots > 0) {
          const filled = await promoteBestTier2ToGlobal(settings, openSlots);
          if (filled > 0) {
            log.info({ openSlots, filled }, "Backfilled open global-pool slots from Tier 2");
          }
        }
      } catch (err) {
        log.warn({ err }, "Global-pool backfill failed (non-fatal)");
      }
    }

    log.info("Free proxy check tick finished");
  } finally {
    isCheckTickRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Main sync tick — syncs providers, promotes Tier 2 → Tier 3
// ---------------------------------------------------------------------------

export async function runFreeProxySyncTick(settingsSnapshot?: JobSettings): Promise<void> {
  if (isSyncTickRunning) {
    log.warn("Free proxy sync tick skipped because a previous run is still in progress");
    return;
  }

  isSyncTickRunning = true;
  try {
    log.info("Free proxy sync tick started");
    const settings = settingsSnapshot ?? (await getJobSettings());

    // Step 1: Sync sources
    await syncFreeProxySources();

    // Step 2: Delete free proxies that can never match the active country filter.
    // Under a specific (non-ALL) filter, the tier test/promote queries all gate
    // on `UPPER(country_code) = filter`, so both wrong-country AND unknown-country
    // (NULL) rows are permanently untestable, unpromotable dead weight — e.g. the
    // 1proxy source imports thousands of rows with no country. Previously only
    // wrong-country rows were pruned; NULL-country rows accumulated forever. Pooled
    // rows (in_pool = 1) are always spared so an in-use proxy is never disturbed.
    try {
      if (settings.countryFilter && settings.countryFilter !== "ALL") {
        const db = getDbInstance();
        const deleted = db
          .prepare(
            "DELETE FROM free_proxies WHERE in_pool = 0 AND (country_code IS NULL OR UPPER(country_code) != ?)"
          )
          .run(settings.countryFilter);
        if (deleted.changes > 0) {
          log.info(
            { deleted: deleted.changes },
            "Cleaned up non-matching / unknown-country free proxies"
          );
        }
      }
    } catch (err) {
      log.warn({ err }, "Failed to delete non-matching country free proxies (non-fatal)");
    }

    // Step 3: Promote best Tier 2 proxies to Tier 3 (global pool)
    try {
      const promoted = await promoteBestTier2ToGlobal(settings, settings.poolSize);
      if (promoted > 0) {
        log.info({ promoted }, "Promoted Tier 2 proxies to Tier 3 (global pool)");
      } else {
        log.info("No eligible Tier 2 proxies found for promotion — global pool unchanged");
      }
    } catch (err) {
      log.warn({ err }, "Tier 2 → Tier 3 promotion failed (non-fatal)");
    }

    // Step 4: Auto-distribute Tier 3 proxies across provider accounts (1:1, no sharing)
    if (settings.autoDistribute) {
      try {
        await distributeProxiesToAccounts();
      } catch (err) {
        log.warn({ err }, "Auto-distribute Tier 3 proxies failed (non-fatal)");
      }
    }

    log.info("Free proxy sync tick finished");
  } finally {
    isSyncTickRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let reloadInFlight: Promise<void> | null = null;

export async function reloadFreeProxyJob(
  settingsSnapshot?: Record<string, unknown>
): Promise<void> {
  if (reloadInFlight) {
    return reloadInFlight;
  }

  reloadInFlight = (async () => {
    // Ensure persisted provider toggles are hydrated before any tick reads
    // getEnabledProviders(); no-op once already loaded / pushed by applyRuntimeSettings.
    try {
      const { loadPersistedProviderToggles } = await import("@/lib/freeProxyProviders");
      await loadPersistedProviderToggles();
    } catch {
      // Non-fatal: env-derived enable state remains active.
    }

    const jobSettings = await getJobSettings();
    const newHash = getSettingsHash(jobSettings);
    if (newHash === currentSettingsHash) {
      return;
    }
    currentSettingsHash = newHash;

    stopFreeProxyJob();

    if (!jobSettings.enabled) {
      log.info("Free proxy background job is disabled");
      return;
    }

    log.info(
      {
        checkIntervalMs: jobSettings.checkIntervalMs,
        syncIntervalMs: jobSettings.syncIntervalMs,
        countryFilter: jobSettings.countryFilter,
        minQuality: jobSettings.minQuality,
        tier1PromoteThreshold: jobSettings.tier1PromoteThreshold,
        tier2DemoteThreshold: jobSettings.tier2DemoteThreshold,
      },
      "Scheduling 3-tier proxy check & sync background jobs"
    );

    void runFreeProxyCheckTick(jobSettings).catch((err) =>
      log.warn({ err }, "Initial free proxy check failed")
    );
    checkTimer = setInterval(() => {
      // Re-read settings each scheduled tick so config changes apply between reloads
      // without requiring a hot-reload trigger; falls back to the snapshot on error.
      void runFreeProxyCheckTick().catch((err) => log.warn({ err }, "Free proxy check failed"));
    }, jobSettings.checkIntervalMs);
    checkTimer.unref?.();

    void runFreeProxySyncTick(jobSettings).catch((err) =>
      log.warn({ err }, "Initial free proxy sync failed")
    );
    syncTimer = setInterval(() => {
      void runFreeProxySyncTick().catch((err) => log.warn({ err }, "Free proxy sync failed"));
    }, jobSettings.syncIntervalMs);
    syncTimer.unref?.();
  })().finally(() => {
    reloadInFlight = null;
  });

  return reloadInFlight;
}

export function startFreeProxyJob(): NodeJS.Timeout | null {
  void reloadFreeProxyJob().catch((err) => log.warn({ err }, "Failed to start free proxy job"));
  return null;
}

export function stopFreeProxyJob(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  isCheckTickRunning = false;
  isSyncTickRunning = false;
}
