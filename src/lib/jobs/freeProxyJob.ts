/**
 * freeProxyJob.ts — Automatic Free Proxy Sync + Validation + USA Auto-Promotion
 *
 * Periodically:
 *  1. Syncs all enabled free proxy providers (proxifly, 1proxy, iplocate,
 *     proxyscraper, proxypool) to the `free_proxies` table.
 *  2. Validates every proxy in the `proxy_registry` via an egress probe so
 *     dead proxies are automatically marked and skipped during resolution.
 *  3. Promotes the best live USA (or filtered country) proxy from `free_proxies`
 *     into the global `proxy_registry` slot so that all outbound requests route
 *     through a fresh IP without any manual configuration.
 *
 * All env vars are optional — the job degrades gracefully when a source is
 * disabled or unreachable.
 */

import { getEnabledProviders } from "@/lib/freeProxyProviders";
import { validateProxyPool } from "@/lib/proxyEgress";
import { createLogger } from "@/shared/utils/logger";
import { getDbInstance } from "@/lib/db/core";
import { getSettings } from "@/lib/db/settings";
import { randomUUID } from "crypto";
import { resolveEgressIp } from "@/lib/proxyEgress";

const log = createLogger("free-proxy-job");

const PROXY_NAME_PREFIX = "auto-us";
const GLOBAL_POOL_SIZE = 20;

let checkTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let currentSettingsHash: string = "";

async function getJobSettings() {
  try {
    const settings = await getSettings();
    const enabled =
      settings.freeProxyAutoJobEnabled === true ||
      (settings.freeProxyAutoJobEnabled === undefined &&
        process.env.FREE_PROXY_AUTO_JOB_ENABLED !== "false");

    const checkIntervalMin = Number(settings.freeProxyCheckIntervalMin) || 15;
    const syncIntervalMin = Number(settings.freeProxySyncIntervalMin) || 60;
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
    const poolSize = Math.min(50, Math.max(5, Number(settings.freeProxyGlobalPoolSize) || GLOBAL_POOL_SIZE));
    const autoRemoveDead = settings.freeProxyAutoRemoveDead !== false;

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
    };
  } catch (err) {
    log.warn({ err }, "Failed to get settings for free proxy job, using defaults");
    return {
      enabled: process.env.FREE_PROXY_AUTO_JOB_ENABLED !== "false",
      checkIntervalMs: 15 * 60 * 1000,
      syncIntervalMs: 60 * 60 * 1000,
      countryFilter: (process.env.FREE_PROXY_COUNTRY_FILTER || "US").toUpperCase(),
      minQuality: 40,
      minTests: 5,
      minSuccessRate: 100,
      autoElevate: true,
    };
  }
}

function getSettingsHash(s: Awaited<ReturnType<typeof getJobSettings>>) {
  return `${s.enabled}:${s.checkIntervalMs}:${s.syncIntervalMs}:${s.countryFilter}:${s.minQuality}:${s.minTests}:${s.minSuccessRate}:${s.autoElevate}`;
}

// ---------------------------------------------------------------------------
// Step 1: Sync all enabled free proxy providers
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
// Step 2: Find the best live proxy from the free_proxies table
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  host: string;
  port: number;
  type: string;
  quality_score: number | null;
  latency_ms: number | null;
}

async function pickBestProxy(country: string, minQuality: number): Promise<CandidateRow | null> {
  const db = getDbInstance();
  const settings = await getJobSettings();

  // ONLY pick from candidates that meet validation thresholds!
  const query =
    settings.countryFilter === "ALL"
      ? `SELECT id, host, port, type, quality_score, latency_ms
       FROM free_proxies
       WHERE test_count >= ?
         AND success_count = test_count
         AND quality_score >= ?
       ORDER BY
         quality_score DESC,
         CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END,
         latency_ms ASC
       LIMIT 20`
      : `SELECT id, host, port, type, quality_score, latency_ms
       FROM free_proxies
       WHERE UPPER(country_code) = ?
         AND test_count >= ?
         AND success_count = test_count
         AND quality_score >= ?
       ORDER BY
         quality_score DESC,
         CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END,
         latency_ms ASC
       LIMIT 20`;

  const params =
    settings.countryFilter === "ALL"
      ? [settings.minTests, minQuality]
      : [country, settings.minTests, minQuality];

  const rows = db.prepare(query).all(...params) as CandidateRow[];

  if (rows.length === 0) return null;

  // Quick liveness test — try up to 5 candidates in order
  const { testSingleProxy } = await import("@omniroute/open-sse/utils/proxyFallback");
  const TEST_URL = "https://api.openai.com/v1/models";

  for (const row of rows.slice(0, 5)) {
    const url = `${row.type}://${row.host}:${row.port}`;
    const { ok } = await testSingleProxy(url, TEST_URL, 5000);
    if (ok) return row;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Step 3: Promote up to GLOBAL_POOL_SIZE best proxies to the global pool
// Uses scope='global' with incrementing scope_id ('__global__0'..'__global__19')
// so the resolver can round-robin across the pool.
// ---------------------------------------------------------------------------

async function promoteProxyToGlobal(candidate: CandidateRow, country: string, poolSize: number = GLOBAL_POOL_SIZE): Promise<void> {
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

  // Find an empty slot in the global pool (0..GLOBAL_POOL_SIZE-1) or replace the oldest/worst
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

  log.info(
    { host: candidate.host, port: candidate.port, type: candidate.type, url: proxyUrl, slot: targetSlot },
    `Promoted ${country} proxy to global pool slot ${targetSlot}`
  );
}

// ---------------------------------------------------------------------------
// Main job ticks
// ---------------------------------------------------------------------------

export async function runFreeProxyCheckTick(): Promise<void> {
  log.info("Free proxy check tick started");
  const settings = await getJobSettings();
  try {
    const report = await validateProxyPool();
    const alive = report.filter((r) => r.alive).length;
    const dead = report.filter((r) => !r.alive).length;
    if (report.length > 0) {
      log.info({ total: report.length, alive, dead }, "Proxy pool validation complete");
    }
  } catch (err) {
    log.warn({ err }, "Proxy pool validation failed (non-fatal)");
  }

  // --- Validate Candidate Free Proxies ---
  try {
    const db = getDbInstance();
    const query =
      settings.countryFilter === "ALL"
        ? "SELECT id, type, host, port FROM free_proxies WHERE in_pool = 0"
        : "SELECT id, type, host, port FROM free_proxies WHERE in_pool = 0 AND UPPER(country_code) = ?";

    const params = settings.countryFilter === "ALL" ? [] : [settings.countryFilter];
    const candidates = db.prepare(query).all(...params) as Array<{
      id: string;
      type: string;
      host: string;
      port: number;
    }>;

    if (candidates.length > 0) {
      log.info({ count: candidates.length }, "Checking candidate free proxies in background");

      const { testSingleProxy } = await import("@omniroute/open-sse/utils/proxyFallback");
      const { incrementFreeProxyStats, deleteFreeProxy, promoteFreeProxyToPool } =
        await import("@/lib/db/freeProxies");
      const TEST_URL = "https://api.openai.com/v1/models";

      const chunk = <T>(arr: T[], size: number): T[][] =>
        Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
          arr.slice(i * size, i * size + size)
        );

      const chunks = chunk(candidates, 50);
      for (const batch of chunks) {
        await Promise.all(
          batch.map(async (item) => {
            const url = `${item.type}://${item.host}:${item.port}`;
            try {
              const { ok, latencyMs } = await testSingleProxy(url, TEST_URL, 5000);
              if (ok) {
                let quality = 60;
                if (latencyMs) {
                  const timeoutSec = latencyMs / 1000;
                  if (timeoutSec <= 0.1) quality = 95;
                  else if (timeoutSec <= 0.5) quality = 85;
                  else if (timeoutSec <= 1.0) quality = 75;
                  else if (timeoutSec <= 2.0) quality = 65;
                  else if (timeoutSec <= 5.0) quality = 50;
                  else if (timeoutSec <= 10.0) quality = 35;
                  else quality = 20;
                }
                await incrementFreeProxyStats(item.id, true, latencyMs, quality);
              } else {
                await deleteFreeProxy(item.id);
              }
            } catch (err) {
              await deleteFreeProxy(item.id);
            }
          })
        );
      }

      // --- Auto-elevation Logic ---
      if (settings.autoElevate) {
        const eligibleQuery =
          settings.countryFilter === "ALL"
            ? `SELECT id, type, host, port, source
             FROM free_proxies
             WHERE in_pool = 0
               AND test_count >= ?
               AND success_count = test_count
               AND quality_score >= ?`
            : `SELECT id, type, host, port, source
             FROM free_proxies
             WHERE in_pool = 0
               AND UPPER(country_code) = ?
               AND test_count >= ?
               AND success_count = test_count
               AND quality_score >= ?`;
        const eligibleParams =
          settings.countryFilter === "ALL"
            ? [settings.minTests, settings.minQuality]
            : [settings.countryFilter, settings.minTests, settings.minQuality];

        const eligible = db.prepare(eligibleQuery).all(...eligibleParams) as Array<{
          id: string;
          type: string;
          host: string;
          port: number;
          source: string;
        }>;

        for (const proxy of eligible) {
          log.info(
            { host: proxy.host, port: proxy.port },
            "Auto-elevating fully vetted candidate to in-use registry"
          );
          await promoteFreeProxyToPool(proxy.id, {
            name: `[${proxy.source}] ${proxy.host}:${proxy.port}`,
            type: proxy.type,
            host: proxy.host,
            port: proxy.port,
            source: proxy.source,
          });
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "Candidate proxy check loop failed (non-fatal)");
  }

  log.info("Free proxy check tick finished");
}

async function runFreeProxySyncTick(): Promise<void> {
  log.info("Free proxy sync tick started");
  const settings = await getJobSettings();

  // Step 1: Sync sources
  await syncFreeProxySources();

  // Step 2: Delete non-matching country code proxies from free_proxies database
  try {
    if (settings.countryFilter && settings.countryFilter !== "ALL") {
      const db = getDbInstance();
      const deleted = db
        .prepare(
          "DELETE FROM free_proxies WHERE country_code IS NOT NULL AND UPPER(country_code) != ?"
        )
        .run(settings.countryFilter);
      if (deleted.changes > 0) {
        log.info({ deleted: deleted.changes }, "Cleaned up non-matching country free proxies");
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to delete non-matching country free proxies (non-fatal)");
  }

  // Step 3: Pick top proxies and promote to global pool (fills GLOBAL_POOL_SIZE slots)
  try {
    const db = getDbInstance();
    const query =
      settings.countryFilter === "ALL"
        ? `SELECT id, host, port, type, quality_score, latency_ms
           FROM free_proxies
           WHERE test_count >= ?
             AND success_count = test_count
             AND quality_score >= ?
           ORDER BY quality_score DESC,
             CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END,
             latency_ms ASC
           LIMIT ?`
        : `SELECT id, host, port, type, quality_score, latency_ms
           FROM free_proxies
           WHERE UPPER(country_code) = ?
             AND test_count >= ?
             AND success_count = test_count
             AND quality_score >= ?
           ORDER BY quality_score DESC,
             CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END,
             latency_ms ASC
           LIMIT ?`;

    const candidateLimit = settings.poolSize * 2;
    const params =
      settings.countryFilter === "ALL"
        ? [settings.minTests, settings.minQuality, candidateLimit]
        : [settings.countryFilter, settings.minTests, settings.minQuality, candidateLimit];

    const candidates = db.prepare(query).all(...params) as CandidateRow[];

    if (candidates.length === 0) {
      log.info(`No live ${settings.countryFilter} proxies found — global pool unchanged`);
    } else {
      // Liveness-test candidates in parallel, promote the healthy ones
      const { testSingleProxy } = await import("@omniroute/open-sse/utils/proxyFallback");
      const TEST_URL = "https://api.openai.com/v1/models";
      const testResults = await Promise.all(
        candidates.slice(0, 30).map(async (row) => {
          const url = `${row.type}://${row.host}:${row.port}`;
          const { ok } = await testSingleProxy(url, TEST_URL, 5000);
          return { row, ok };
        })
      );

      const alive = testResults.filter((r) => r.ok).map((r) => r.row);
      log.info(
        { tested: candidates.length, alive: alive.length },
        `Liveness test complete for proxy promotion candidates`
      );

          // Clean up dead proxies from the global pool
      if (settings.autoRemoveDead) {
        const deadInPool = db
          .prepare(
            `SELECT pr.id FROM proxy_registry pr
             JOIN proxy_assignments pa ON pa.proxy_id = pr.id
             WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
               AND (pr.status IS NULL OR LOWER(pr.status) IN ('inactive','error','disabled','dead','down'))`
          )
          .all() as Array<{ id: string }>;
        for (const dead of deadInPool) {
          db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(dead.id);
          db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(dead.id);
          log.info({ id: dead.id }, "Cleaned up dead proxy from global pool");
        }
      }

      // Also clean proxies that fail egress check
      const poolProxies = db
        .prepare(
          `SELECT pr.id, pr.type, pr.host, pr.port FROM proxy_registry pr
           JOIN proxy_assignments pa ON pa.proxy_id = pr.id
           WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
             AND pr.source = 'auto-us'`
        )
        .all() as Array<{ id: string; type: string; host: string; port: number }>;

      for (const pp of poolProxies) {
        try {
          const url = `${pp.type}://${pp.host}:${pp.port}`;
          const egress = await resolveEgressIp(url, { force: true });
          if (!egress.ip || egress.error) {
            db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(pp.id);
            db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(pp.id);
            log.info({ host: pp.host }, "Removed dead proxy from global pool (egress check failed)");
          }
        } catch {
          db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(pp.id);
          db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(pp.id);
        }
      }

      // Promote alive candidates to fill pool slots
      for (const candidate of alive.slice(0, settings.poolSize)) {
        await promoteProxyToGlobal(candidate, settings.countryFilter, settings.poolSize);
      }

      log.info(
        { promoted: Math.min(alive.length, GLOBAL_POOL_SIZE) },
        `Promoted proxies to global pool`
      );
    }
  } catch (err) {
    log.warn({ err }, "Proxy promotion failed (non-fatal)");
  }

  log.info("Free proxy sync tick finished");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function reloadFreeProxyJob(
  settingsSnapshot?: Record<string, unknown>
): Promise<void> {
  const jobSettings = await getJobSettings();
  const newHash = getSettingsHash(jobSettings);
  if (newHash === currentSettingsHash) {
    return; // No changes
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
    },
    "Scheduling free proxy check & sync background jobs"
  );

  // Run validation checks immediately and on check interval (e.g. 15 minutes)
  void runFreeProxyCheckTick().catch((err) => log.warn({ err }, "Initial free proxy check failed"));
  checkTimer = setInterval(() => {
    void runFreeProxyCheckTick().catch((err) => log.warn({ err }, "Free proxy check failed"));
  }, jobSettings.checkIntervalMs);
  checkTimer.unref?.();

  // Run sync immediately and on sync interval (e.g. 1 hour)
  void runFreeProxySyncTick().catch((err) => log.warn({ err }, "Initial free proxy sync failed"));
  syncTimer = setInterval(() => {
    void runFreeProxySyncTick().catch((err) => log.warn({ err }, "Free proxy sync failed"));
  }, jobSettings.syncIntervalMs);
  syncTimer.unref?.();
}

export function startFreeProxyJob(): NodeJS.Timeout | null {
  void reloadFreeProxyJob().catch((err) => log.warn({ err }, "Failed to start free proxy job"));
  // Return null or checkTimer for API compatibility
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
}
