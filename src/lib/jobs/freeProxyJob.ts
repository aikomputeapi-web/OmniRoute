/**
 * freeProxyJob.ts — Automatic Free Proxy Sync + Validation + USA Auto-Promotion
 *
 * Periodically:
 *  1. Syncs all enabled free proxy providers (proxifly, 1proxy, iplocate,
 *     proxyscraper, proxypool) to the `free_proxies` table.
 *  2. Validates every proxy in the `proxy_registry` via an egress probe so
 *     dead proxies are automatically marked and skipped during resolution.
 *  3. Promotes the best live USA proxy from `free_proxies` into the global
 *     `proxy_registry` slot so that all outbound requests route through a
 *     fresh US IP without any manual configuration.
 *
 * All env vars are optional — the job degrades gracefully when a source is
 * disabled or unreachable.
 *
 * Required env for full operation:
 *   PROXY_AUTO_SELECT_ENABLED=true   — activates auto-selection at resolution time
 *   FREE_PROXY_AUTO_JOB_ENABLED=true — activates this background job (default: true)
 *   FREE_PROXY_AUTO_JOB_INTERVAL_MS  — sync interval (default: 30 min)
 *   FREE_PROXY_PROXIFLY_ENABLED      — default true (opt-out via =false)
 *   FREE_PROXY_IPLOCATE_ENABLED=true — opt-in
 *   FREE_PROXY_SCRAPER_ENABLED=true  — opt-in (requires monosans/proxy-scraper-checker output)
 *   FREE_PROXY_PROXYPOOL_ENABLED=true — opt-in
 *   ONEPROXY_ENABLED                 — default true (opt-out via =false)
 */

import { getEnabledProviders } from "@/lib/freeProxyProviders";
import { validateProxyPool } from "@/lib/proxyEgress";
import { createLogger } from "@/shared/utils/logger";
import { getDbInstance } from "@/lib/db/core";
import { randomUUID } from "crypto";

const log = createLogger("free-proxy-job");

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MIN_QUALITY = 40;
const USA_COUNTRY_CODE = "US";
const PROXY_NAME_PREFIX = "auto-us";

let timer: NodeJS.Timeout | null = null;

function isJobEnabled(): boolean {
  // Default ON — opt out with FREE_PROXY_AUTO_JOB_ENABLED=false
  return process.env.FREE_PROXY_AUTO_JOB_ENABLED !== "false";
}

function getIntervalMs(): number {
  const raw = process.env.FREE_PROXY_AUTO_JOB_INTERVAL_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_INTERVAL_MS;
}

function getMinQuality(): number {
  const raw = process.env.FREE_PROXY_AUTO_MIN_QUALITY;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULT_MIN_QUALITY;
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
// Step 2: Find the best live USA proxy from the free_proxies table
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  host: string;
  port: number;
  type: string;
  quality_score: number | null;
  latency_ms: number | null;
}

async function pickBestUsaProxy(): Promise<CandidateRow | null> {
  const db = getDbInstance();
  const minQuality = getMinQuality();

  // Prefer high quality_score, then low latency_ms; allow NULL quality as fallback
  const rows = db
    .prepare(
      `SELECT id, host, port, type, quality_score, latency_ms
       FROM free_proxies
       WHERE country_code = ?
         AND (quality_score IS NULL OR quality_score >= ?)
       ORDER BY
         CASE WHEN quality_score IS NULL THEN 1 ELSE 0 END,
         quality_score DESC,
         CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END,
         latency_ms ASC
       LIMIT 20`
    )
    .all(USA_COUNTRY_CODE, minQuality) as CandidateRow[];

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
// Step 3: Promote best USA proxy to the global proxy_registry slot
// ---------------------------------------------------------------------------

async function promoteUsaProxyToGlobal(candidate: CandidateRow): Promise<void> {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const proxyUrl = `${candidate.type}://${candidate.host}:${candidate.port}`;

  db.transaction(() => {
    // Check if an identical proxy is already the global slot
    const existing = db
      .prepare(
        `SELECT pr.id, pr.host, pr.port FROM proxy_registry pr
         JOIN proxy_assignments pa ON pa.proxy_id = pr.id
         WHERE pa.scope = 'global'
           AND pr.source = 'auto-us'
           AND pr.host = ? AND pr.port = ?
         LIMIT 1`
      )
      .get(candidate.host, candidate.port) as { id: string } | undefined;

    if (existing) {
      // Touch the updated_at so we know this proxy was re-validated
      db.prepare("UPDATE proxy_registry SET status = 'active', updated_at = ? WHERE id = ?").run(
        now,
        existing.id
      );
      return;
    }

    // Remove any previous auto-us global proxy assignment + its registry row
    const oldGlobal = db
      .prepare(
        `SELECT pr.id FROM proxy_registry pr
         JOIN proxy_assignments pa ON pa.proxy_id = pr.id
         WHERE pa.scope = 'global' AND pr.source = 'auto-us'
         LIMIT 1`
      )
      .get() as { id: string } | undefined;

    if (oldGlobal) {
      db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(oldGlobal.id);
      db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(oldGlobal.id);
    }

    // Insert new registry entry
    const newId = randomUUID();
    db.prepare(
      `INSERT INTO proxy_registry
       (id, name, type, host, port, username, password, region, notes, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', '', 'US', 'Auto-selected USA proxy', 'active', ?, ?, ?)`
    ).run(
      newId,
      `${PROXY_NAME_PREFIX}-${candidate.host}`,
      candidate.type,
      candidate.host,
      candidate.port,
      "auto-us",
      now,
      now
    );

    // Assign to global scope (upsert: remove old global assignment if it exists)
    db.prepare("DELETE FROM proxy_assignments WHERE scope = 'global' AND scope_id IS NULL").run();
    db.prepare(
      `INSERT INTO proxy_assignments (scope, scope_id, proxy_id, created_at, updated_at)
       VALUES ('global', NULL, ?, ?, ?)`
    ).run(newId, now, now);
  })();

  log.info(
    { host: candidate.host, port: candidate.port, type: candidate.type, url: proxyUrl },
    "Promoted USA proxy to global registry slot"
  );
}

// ---------------------------------------------------------------------------
// Main job tick
// ---------------------------------------------------------------------------

async function runFreeProxyJob(): Promise<void> {
  log.info("Free proxy job started");

  // Step 1: Sync sources
  await syncFreeProxySources();

  // Step 2: Validate existing pool (marks dead proxies as 'error' so they're skipped)
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

  // Step 3: Pick best USA proxy and promote to global slot
  try {
    const best = await pickBestUsaProxy();
    if (best) {
      await promoteUsaProxyToGlobal(best);
    } else {
      log.info("No live USA proxy found — global slot unchanged");
    }
  } catch (err) {
    log.warn({ err }, "USA proxy promotion failed (non-fatal)");
  }

  log.info("Free proxy job finished");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startFreeProxyJob(): NodeJS.Timeout | null {
  if (!isJobEnabled()) {
    log.info("Free proxy job is disabled (FREE_PROXY_AUTO_JOB_ENABLED=false)");
    return null;
  }
  if (timer) return timer;

  const intervalMs = getIntervalMs();

  // Run immediately on startup, then on interval
  void runFreeProxyJob().catch((err) => log.warn({ err }, "Initial free proxy job run failed"));

  timer = setInterval(() => {
    void runFreeProxyJob().catch((err) => log.warn({ err }, "Free proxy job run failed"));
  }, intervalMs);

  timer.unref?.();
  log.info({ intervalMs }, "Free proxy job scheduled");
  return timer;
}

export function stopFreeProxyJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
