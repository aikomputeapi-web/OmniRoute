/**
 * Regression tests for the 3-tier free-proxy pool flow (freeProxyJob.ts).
 *
 * Guards the fixes that restore the documented intake → testing → live design:
 *   - Tier 3 liveness failures cascade to Tier 2 (with a pre-seeded failure
 *     head-start), NOT straight back to Tier 1 intake.
 *   - A Tier 2 proxy that strings together `tier2PromoteThreshold` consecutive
 *     successful checks is promoted to the active pool (Tier 3) on the check
 *     tick — the fast verified → live path that was previously missing.
 *   - The multi-target probe reports the reachable target's own latency, not
 *     the wall-clock sum of earlier failed targets.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getDbInstance } from "../../../src/lib/db/core.ts";
import {
  demoteTier3Proxy,
  demoteTier3ToTier1,
  testProxyMultiTarget,
  runFreeProxyCheckTick,
  _setProxyProbeForTests,
} from "../../../src/lib/jobs/freeProxyJob.ts";

const NOW = new Date().toISOString();

function clearTables() {
  const db = getDbInstance();
  db.prepare("DELETE FROM proxy_assignments").run();
  db.prepare("DELETE FROM proxy_registry").run();
  db.prepare("DELETE FROM free_proxies").run();
}

function seedFreeProxy(row: {
  id: string;
  host: string;
  port: number;
  tier: number;
  inPool?: number;
  poolProxyId?: string | null;
  country?: string | null;
  consecutiveSuccesses?: number;
  consecutiveFailures?: number;
  testCount?: number;
  successCount?: number;
}) {
  getDbInstance()
    .prepare(
      `INSERT INTO free_proxies
        (id, source, host, port, type, country_code, quality_score, latency_ms,
         anonymity, last_validated, in_pool, pool_proxy_id, test_count, success_count,
         tier, consecutive_successes, consecutive_failures, created_at, updated_at)
       VALUES (?, 'proxyscraper', ?, ?, 'http', ?, 80, 100, 'elite', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.host,
      row.port,
      row.country ?? null,
      NOW,
      row.inPool ?? 0,
      row.poolProxyId ?? null,
      row.testCount ?? 0,
      row.successCount ?? 0,
      row.tier,
      row.consecutiveSuccesses ?? 0,
      row.consecutiveFailures ?? 0,
      NOW,
      NOW
    );
}

function seedTier3Registry(regId: string, host: string, port: number, slot = 0, status = "active") {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO proxy_registry
      (id, name, type, host, port, username, password, region, notes, status, source, created_at, updated_at)
     VALUES (?, ?, 'http', ?, ?, '', '', 'US', '', ?, 'auto-us', ?, ?)`
  ).run(regId, `auto-us-${host}`, host, port, status, NOW, NOW);
  db.prepare(
    `INSERT INTO proxy_assignments (scope, scope_id, proxy_id, created_at, updated_at)
     VALUES ('global', ?, ?, ?, ?)`
  ).run(`__global__${slot}`, regId, NOW, NOW);
}

function fullSettings(overrides: Record<string, unknown> = {}) {
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
    tier2PromoteThreshold: 2,
    tier2DemoteThreshold: 3,
    liveFailThreshold: 3,
    autoDistribute: false,
    ...overrides,
  } as never;
}

describe("free-proxy 3-tier cascade", () => {
  beforeEach(() => {
    clearTables();
    _setProxyProbeForTests(null);
  });
  afterEach(() => {
    _setProxyProbeForTests(null);
  });

  it("demoteTier3Proxy sends a failing live proxy to Tier 2 with a failure head-start", async () => {
    seedFreeProxy({ id: "fp1", host: "1.1.1.1", port: 8080, tier: 3, inPool: 1, poolProxyId: "reg1" });
    seedTier3Registry("reg1", "1.1.1.1", 8080);

    await demoteTier3Proxy("reg1", "1.1.1.1", 2, 2);

    const db = getDbInstance();
    const fp = db.prepare("SELECT * FROM free_proxies WHERE id = 'fp1'").get() as Record<string, number>;
    assert.equal(fp.tier, 2, "should land in Tier 2, not Tier 1 intake");
    assert.equal(fp.in_pool, 0, "no longer live");
    assert.equal(fp.pool_proxy_id, null, "registry link cleared");
    assert.equal(fp.consecutive_failures, 2, "failure head-start pre-seeded");
    assert.equal(fp.consecutive_successes, 0);

    assert.equal(db.prepare("SELECT COUNT(*) n FROM proxy_registry").get()!.n, 0, "registry row removed");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM proxy_assignments").get()!.n, 0, "assignment removed");
  });

  it("demoteTier3ToTier1 wrapper hard-demotes to Tier 1 with counters cleared", async () => {
    seedFreeProxy({
      id: "fp2",
      host: "2.2.2.2",
      port: 8080,
      tier: 3,
      inPool: 1,
      poolProxyId: "reg2",
      consecutiveFailures: 1,
    });
    seedTier3Registry("reg2", "2.2.2.2", 8080);

    await demoteTier3ToTier1("reg2", "2.2.2.2");

    const fp = getDbInstance()
      .prepare("SELECT * FROM free_proxies WHERE id = 'fp2'")
      .get() as Record<string, number>;
    assert.equal(fp.tier, 1, "manual remove drops to intake");
    assert.equal(fp.consecutive_failures, 0, "counters cleared");
  });

  it("testProxyMultiTarget reports the reachable target's own latency, not the sum of failed targets", async () => {
    // First target fails (would burn a timeout); second target succeeds at 40ms.
    _setProxyProbeForTests(async (_proxy, target) => {
      if (target === "https://api.openai.com/v1/models") {
        return { ok: false, latencyMs: null };
      }
      return { ok: true, latencyMs: 40 };
    });

    const res = await testProxyMultiTarget("http://9.9.9.9:8080", 5000);
    assert.equal(res.ok, true);
    assert.equal(res.latencyMs, 40, "latency reflects only the successful target");
  });

  it("check tick promotes a Tier 2 proxy to Tier 3 after the consecutive-success threshold", async () => {
    // cs=1, threshold=2 → one more success promotes it.
    seedFreeProxy({
      id: "fp3",
      host: "3.3.3.3",
      port: 8080,
      tier: 2,
      country: "US",
      consecutiveSuccesses: 1,
      testCount: 4,
      successCount: 4,
    });
    _setProxyProbeForTests(async () => ({ ok: true, latencyMs: 20 }));

    await runFreeProxyCheckTick(fullSettings());

    const db = getDbInstance();
    const fp = db.prepare("SELECT * FROM free_proxies WHERE id = 'fp3'").get() as Record<string, number>;
    assert.equal(fp.tier, 3, "verified proxy promoted to the active pool");
    assert.equal(fp.in_pool, 1, "marked live");

    const inPool = db
      .prepare(
        `SELECT COUNT(*) n FROM proxy_registry pr
         JOIN proxy_assignments pa ON pa.proxy_id = pr.id
         WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%' AND pr.host = '3.3.3.3'`
      )
      .get() as { n: number };
    assert.equal(inPool.n, 1, "a global-pool registry slot was allocated");
  });

  it("check tick cascades a dead Tier 3 proxy to Tier 2 (not Tier 1)", async () => {
    // country_code NULL so the Tier 2 pass (US filter) does not re-test it in
    // the same tick, isolating the Tier 3 → Tier 2 landing.
    seedFreeProxy({
      id: "fp4",
      host: "4.4.4.4",
      port: 8080,
      tier: 3,
      inPool: 1,
      poolProxyId: "reg4",
      country: null,
    });
    seedTier3Registry("reg4", "4.4.4.4", 8080);
    _setProxyProbeForTests(async () => ({ ok: false, latencyMs: null }));

    await runFreeProxyCheckTick(fullSettings());

    const db = getDbInstance();
    const fp = db.prepare("SELECT * FROM free_proxies WHERE id = 'fp4'").get() as Record<string, number>;
    assert.equal(fp.tier, 2, "dead live proxy drops to the verified/testing tier, not intake");
    assert.equal(fp.in_pool, 0);
    assert.equal(fp.consecutive_failures, 2, "head-start = tier2DemoteThreshold - 1");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM proxy_registry").get()!.n, 0, "removed from live pool");
  });

  it("check tick refreshes registry status to active for a reachable Tier 3 proxy (single liveness authority)", async () => {
    // A prior sweep left status='error'; the multi-target probe says it's live.
    seedFreeProxy({ id: "fp5", host: "5.5.5.5", port: 8080, tier: 3, inPool: 1, poolProxyId: "reg5", country: null });
    seedTier3Registry("reg5", "5.5.5.5", 8080, 0, "error");
    _setProxyProbeForTests(async () => ({ ok: true, latencyMs: 20 }));

    await runFreeProxyCheckTick(fullSettings());

    const db = getDbInstance();
    const reg = db.prepare("SELECT * FROM proxy_registry WHERE id = 'reg5'").get() as
      | Record<string, string>
      | undefined;
    assert.ok(reg, "reachable proxy is not demoted/removed");
    assert.equal(reg!.status, "active", "status reconciled to the tier probe's verdict, not left as error");
  });

  it("check tick backfills a slot freed by a Tier 3 demotion from the best verified Tier 2 proxy", async () => {
    // Pool of 2. One live proxy goes down (freeing a slot); a verified Tier 2
    // proxy (not on a promotion streak) should backfill it in the same tick.
    seedFreeProxy({ id: "down", host: "10.0.0.1", port: 8080, tier: 3, inPool: 1, poolProxyId: "regdown", country: null });
    seedTier3Registry("regdown", "10.0.0.1", 8080, 0);
    seedFreeProxy({
      id: "cand",
      host: "10.0.0.2",
      port: 8080,
      tier: 2,
      country: "US",
      consecutiveSuccesses: 0,
      testCount: 5,
      successCount: 5,
    });
    _setProxyProbeForTests(async (proxy) => ({ ok: !proxy.includes("10.0.0.1"), latencyMs: 20 }));

    await runFreeProxyCheckTick(fullSettings({ poolSize: 2 }));

    const db = getDbInstance();
    const down = db.prepare("SELECT tier FROM free_proxies WHERE id = 'down'").get() as { tier: number };
    const cand = db.prepare("SELECT tier, in_pool FROM free_proxies WHERE id = 'cand'").get() as {
      tier: number;
      in_pool: number;
    };
    assert.equal(down.tier, 2, "dead proxy demoted out of the live pool");
    assert.equal(cand.tier, 3, "verified Tier 2 proxy backfilled the open slot same-tick");
    assert.equal(cand.in_pool, 1);
  });

  it("minSuccessRate gates Tier 2 promotion (dead setting now wired)", async () => {
    // A 90%-success proxy: promoted only when minSuccessRate <= its rate.
    const seed = () =>
      seedFreeProxy({
        id: "p90",
        host: "11.0.0.1",
        port: 8080,
        tier: 2,
        country: null, // excluded from the Tier 2 test pass; only backfill considers it
        testCount: 10,
        successCount: 9,
      });
    _setProxyProbeForTests(async () => ({ ok: true, latencyMs: 20 }));

    // country_code NULL means the US-filtered backfill query skips it; use ALL
    // so the backfill considers it and the success-rate gate is what decides.
    // High promote threshold so the consecutive-success streak path can never
    // fire — the success-rate gate in the backfill is the only way to Tier 3.
    seed();
    await runFreeProxyCheckTick(
      fullSettings({ poolSize: 1, countryFilter: "ALL", minSuccessRate: 100, tier2PromoteThreshold: 99 })
    );
    let p = getDbInstance().prepare("SELECT tier FROM free_proxies WHERE id = 'p90'").get() as { tier: number };
    assert.equal(p.tier, 2, "90% proxy stays in Tier 2 when minSuccessRate=100");

    await runFreeProxyCheckTick(
      fullSettings({ poolSize: 1, countryFilter: "ALL", minSuccessRate: 90, tier2PromoteThreshold: 99 })
    );
    p = getDbInstance().prepare("SELECT tier FROM free_proxies WHERE id = 'p90'").get() as { tier: number };
    assert.equal(p.tier, 3, "90% proxy is promotable once minSuccessRate=90");
  });
});
