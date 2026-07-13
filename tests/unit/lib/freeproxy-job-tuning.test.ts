import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-job-tuning-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Disable every provider so runFreeProxySyncTick runs fully offline (no scrape).
for (const p of ["1PROXY", "PROXIFLY", "IPLOCATE", "PROXYPOOL", "PROXYSCRAPER"]) {
  process.env[`FREE_PROXY_${p}_ENABLED`] = "false";
}

const core = await import("../../../src/lib/db/core.ts");
const freeProxies = await import("../../../src/lib/db/freeProxies.ts");
const job = await import("../../../src/lib/jobs/freeProxyJob.ts");

let seq = 0;

/** Minimal complete JobSettings snapshot (bypasses the DB-backed getJobSettings). */
function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    checkIntervalMs: 300000,
    syncIntervalMs: 1800000,
    countryFilter: "US",
    minQuality: 40,
    minTests: 5,
    minSuccessRate: 100,
    autoElevate: true,
    poolSize: 20,
    autoRemoveDead: true,
    tier1PromoteThreshold: 5,
    tier2PromoteThreshold: 10,
    tier2DemoteThreshold: 3,
    liveFailThreshold: 3,
    tier1TestBatchLimit: 750,
    autoDistribute: false,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function insertTier1(country: string | null, lastValidated: string): void {
  const id = `t1-${++seq}`;
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO free_proxies
         (id, source, host, port, type, country_code, in_pool, pool_proxy_id,
          test_count, success_count, tier, consecutive_successes, consecutive_failures,
          last_validated, created_at, updated_at)
       VALUES (?, 'proxyscraper', ?, 8080, 'http', ?, 0, NULL, 0, 0, 1, 0, 0, ?, ?, ?)`
    )
    .run(id, `10.1.0.${seq}`, country, lastValidated, lastValidated, lastValidated);
}

function countTier1(): number {
  return (
    core.getDbInstance().prepare("SELECT COUNT(*) n FROM free_proxies WHERE tier = 1").get() as {
      n: number;
    }
  ).n;
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  core.getDbInstance();
  seq = 0;
});

test.after(() => {
  job._setProxyProbeForTests(null);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── Finding 5: Tier 1 batch cap ────────────────────────────────────────────

test("check tick probes at most tier1TestBatchLimit Tier 1 proxies per run", async () => {
  for (let i = 0; i < 10; i++) insertTier1("US", `2026-01-01T00:00:0${i}Z`);

  let probes = 0;
  job._setProxyProbeForTests(async () => {
    probes++;
    return { ok: true, latencyMs: 50 };
  });

  await job.runFreeProxyCheckTick(settings({ tier1TestBatchLimit: 3 }));

  assert.equal(probes, 3, "only the capped number of Tier 1 proxies are probed");
});

test("check tick probes the least-recently-validated Tier 1 rows first", async () => {
  insertTier1("US", "2026-01-01T00:00:00Z"); // oldest -> should be probed
  insertTier1("US", "2026-06-01T00:00:00Z"); // newest -> should be skipped

  const probedHosts: string[] = [];
  job._setProxyProbeForTests(async (url) => {
    probedHosts.push(url);
    return { ok: true, latencyMs: 50 };
  });

  await job.runFreeProxyCheckTick(settings({ tier1TestBatchLimit: 1 }));

  assert.equal(probedHosts.length, 1);
  assert.ok(probedHosts[0].includes("10.1.0.1"), "the oldest-validated row is probed first");
});

test("tier1TestBatchLimit = 0 means unlimited (probes all)", async () => {
  for (let i = 0; i < 6; i++) insertTier1("US", `2026-01-01T00:00:0${i}Z`);

  let probes = 0;
  job._setProxyProbeForTests(async () => {
    probes++;
    return { ok: true, latencyMs: 50 };
  });

  await job.runFreeProxyCheckTick(settings({ tier1TestBatchLimit: 0 }));

  assert.equal(probes, 6);
});

// ── Finding 3: unknown/wrong-country cleanup ────────────────────────────────

test("sync tick deletes NULL-country and wrong-country Tier 1 rows under a specific filter", async () => {
  insertTier1("US", "2026-01-01T00:00:00Z"); // keep
  insertTier1(null, "2026-01-01T00:00:00Z"); // delete (unknown country)
  insertTier1("DE", "2026-01-01T00:00:00Z"); // delete (wrong country)
  assert.equal(countTier1(), 3);

  await job.runFreeProxySyncTick(settings({ countryFilter: "US" }));

  assert.equal(countTier1(), 1, "only the US row survives");
});

test("sync tick keeps NULL-country rows when the filter is ALL", async () => {
  insertTier1(null, "2026-01-01T00:00:00Z");
  insertTier1("DE", "2026-01-01T00:00:00Z");

  await job.runFreeProxySyncTick(settings({ countryFilter: "ALL" }));

  assert.equal(countTier1(), 2, "ALL filter deletes nothing by country");
});

// ── Finding 3: ingest skip ──────────────────────────────────────────────────

test("upsertFreeProxy skips unknown-country proxies under a specific filter", async () => {
  // countryFilter defaults to US (env). A null-country item must not be imported.
  const res = await freeProxies.upsertFreeProxy({
    source: "proxyscraper",
    host: "203.0.113.7",
    port: 8080,
    type: "http",
    countryCode: null,
    qualityScore: 50,
    latencyMs: 100,
    anonymity: "elite",
    lastValidated: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  assert.equal(res.action, "skipped");
  assert.equal(
    (core.getDbInstance().prepare("SELECT COUNT(*) n FROM free_proxies").get() as { n: number }).n,
    0,
    "no row is inserted"
  );
});
