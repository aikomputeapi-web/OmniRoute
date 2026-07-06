import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-control-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Disable the background free-proxy job scheduler while exercising the service.
process.env.FREE_PROXY_AUTO_JOB_ENABLED = "false";

const core = await import("../../../src/lib/db/core.ts");
const freeProxiesDb = await import("../../../src/lib/db/freeProxies.ts");
const service = await import("../../../src/lib/api/proxyControlService.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");

// Probe whether a SQLite driver is available in this process. The OmniRoute
// test harness normally guarantees `better-sqlite3` / `node:sqlite` is loadable;
// when it isn't (some local/tsx invocations), every DB-backed test in the
// official `free-proxies-db.test.ts` suite also fails to open the database. We
// detect that once and `test.skip` the DB-dependent cases so the service's
// contract is still exercised in environments where the driver loads (CI).
let dbAvailable = false;
try {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pc-probe-"));
  process.env.DATA_DIR = probeDir;
  const probe = core.getDbInstance();
  probe.exec("CREATE TABLE IF NOT EXISTS _pc_probe (k TEXT)");
  dbAvailable = true;
  fs.rmSync(probeDir, { recursive: true, force: true });
} catch {
  dbAvailable = false;
}

async function reset() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
}

function requireDb(t: { skip: (message?: string) => void }) {
  if (!dbAvailable) {
    t.skip("SQLite driver unavailable in this environment");
    // t.skip() never returns control to the function body.
  }
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function seedTier(row: {
  source?: string;
  host: string;
  port: number;
  type?: string;
  countryCode?: string | null;
  qualityScore?: number | null;
  tier: 1 | 2 | 3;
  lastValidated?: string | null;
  latencyMs?: number | null;
}) {
  const created = await freeProxiesDb.upsertFreeProxy({
    source: (row.source ?? "1proxy") as "1proxy",
    host: row.host,
    port: row.port,
    type: row.type ?? "http",
    countryCode: row.countryCode ?? "US",
    qualityScore: row.qualityScore ?? 70,
    latencyMs: row.latencyMs ?? 150,
    anonymity: null,
    lastValidated: row.lastValidated ?? null,
  });
  if (row.tier !== 1 && created.action === "created") {
    await freeProxiesDb.setFreeProxyTier(created.id, 1); // upsert defaults tier=1
  }
  if (row.tier === 2) {
    await freeProxiesDb.setFreeProxyTier(created.id, 2);
  } else if (row.tier === 3) {
    await freeProxiesDb.setFreeProxyTier(created.id, 2);
    const newId = await freeProxiesDb.promoteFreeProxyToPool(created.id, {
      name: `[${row.source ?? "1proxy"}] ${row.host}:${row.port}`,
      type: row.type ?? "http",
      host: row.host,
      port: row.port,
      source: row.source ?? "1proxy",
    });
    assert.ok(newId, "promoteFreeProxyToPool returned a registry id");
  }
  return created.id;
}

test("buildProxyControlSnapshot returns three tiers + settings with source=omniroute", async (t) => {
  requireDb(t);
  await reset();
  await seedTier({ host: "10.0.0.1", port: 8080, tier: 1 });
  await seedTier({ host: "10.0.0.2", port: 8080, tier: 2 });
  await seedTier({ host: "10.0.0.3", port: 8080, tier: 3, qualityScore: 80 });

  const snapshot = await service.buildProxyControlSnapshot();

  assert.equal(snapshot.source, "omniroute");
  assert.equal(snapshot.counts.tier1, 1);
  assert.equal(snapshot.counts.tier2, 1);
  assert.equal(snapshot.counts.tier3, 1);
  assert.equal(snapshot.globalPoolCount, 1);
  assert.equal(snapshot.tiers.tier1.length, 1);
  assert.equal(snapshot.tiers.tier2.length, 1);
  assert.equal((snapshot.tiers.tier3 as service.GlobalPoolRowWire[]).length, 1);

  // Settings shape: ms intervals present + providers map.
  assert.ok(snapshot.settings.checkIntervalMs > 0);
  assert.ok(snapshot.settings.syncIntervalMs > 0);
  assert.equal(typeof snapshot.settings.providers, "object");
  assert.ok(Object.keys(snapshot.settings.providers).length > 0);
});

test("applyProxyControlSettings persists minute intervals as min keys + returns fresh snapshot", async (t) => {
  requireDb(t);
  await reset();

  const snapshot = await service.applyProxyControlSettings({
    enabled: true,
    checkIntervalMinutes: 7,
    syncIntervalMinutes: 25,
    countryFilter: "us",
    minQuality: 55,
    poolSize: 30,
    autoDistribute: true,
    providers: { proxyscraper: false, proxypool: true },
  });

  assert.equal(snapshot.settings.checkIntervalMs, 7 * 60_000);
  assert.equal(snapshot.settings.syncIntervalMs, 25 * 60_000);
  assert.equal(snapshot.settings.countryFilter, "US");
  assert.equal(snapshot.settings.minQuality, 55);
  assert.equal(snapshot.settings.poolSize, 30);
  assert.equal(snapshot.settings.autoDistribute, true);
  assert.equal(snapshot.settings.enabled, true);
  assert.equal(snapshot.settings.providers.proxyscraper, false);
  assert.equal(snapshot.settings.providers.proxypool, true);

  // Round-trip via getSettings to confirm persistence.
  const fresh = await settingsDb.getSettings();
  assert.equal(fresh.freeProxyCheckIntervalMin, 7);
  assert.equal(fresh.freeProxySyncIntervalMin, 25);
  assert.equal(fresh.freeProxyMinQuality, 55);
  assert.equal(fresh.freeProxyCountryFilter, "US");
  assert.equal(fresh.freeProxyProviderToggles?.proxypool, true);
});

test("applyProxyControlSettings rejects unknown top-level keys with 400", async () => {
  await reset();
  await assert.rejects(
    () => service.applyProxyControlSettings({ bogusKey: true }),
    (err: Error & { status?: number }) => err.status === 400 && /bogusKey/.test(err.message),
  );
});

test("dispatchProxyControlAction remove deletes a tier1/free row", async (t) => {
  requireDb(t);
  await reset();
  const id = await seedTier({ host: "10.0.0.9", port: 8080, tier: 1 });
  const result = await service.dispatchProxyControlAction({
    action: "remove",
    selectionKeys: [`tier1:${id}`],
    actor: "test",
  });
  assert.equal(result.success, true);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(await freeProxiesDb.getFreeProxyById(id), null);
});

test("dispatchProxyControlAction promote moves a tier2 candidate into the global pool", async (t) => {
  requireDb(t);
  await reset();
  const id = await seedTier({ host: "10.0.0.10", port: 8080, tier: 2 });
  const result = await service.dispatchProxyControlAction({
    action: "promote",
    selectionKeys: [`tier2:${id}`],
  });
  assert.equal(result.applied, 1);
  const record = await freeProxiesDb.getFreeProxyById(id);
  assert.equal(record?.tier, 3);
  assert.equal(record?.inPool, true);
  assert.ok(record?.poolProxyId);
});

test("dispatchProxyControlAction demote removes a tier3 entry from the global pool", async (t) => {
  requireDb(t);
  await reset();
  await seedTier({ host: "10.0.0.11", port: 8080, tier: 3 });
  let snapshot = await service.buildProxyControlSnapshot();
  assert.equal(snapshot.counts.tier3, 1);
  const tier3Row = (snapshot.tiers.tier3 as service.GlobalPoolRowWire[])[0];

  const result = await service.dispatchProxyControlAction({
    action: "demote",
    selectionKeys: [`tier3:${tier3Row.registryId}`],
  });
  assert.equal(result.applied, 1);
  snapshot = await service.buildProxyControlSnapshot();
  assert.equal(snapshot.counts.tier3, 0);
  assert.equal(snapshot.counts.tier2, 1);
});

test("dispatchProxyControlAction quarantine on tier3 demotes it out of the live pool", async (t) => {
  requireDb(t);
  await reset();
  await seedTier({ host: "10.0.0.12", port: 8080, tier: 3 });
  const before = await service.buildProxyControlSnapshot();
  const tier3Row = (before.tiers.tier3 as service.GlobalPoolRowWire[])[0];
  const result = await service.dispatchProxyControlAction({
    action: "quarantine",
    selectionKeys: [`tier3:${tier3Row.registryId}`],
  });
  assert.equal(result.applied, 1);
  const after = await service.buildProxyControlSnapshot();
  assert.equal(after.counts.tier3, 0);
});

test("dispatchProxyControlAction rejects unknown action with 400", async () => {
  await reset();
  await assert.rejects(
    () =>
      service.dispatchProxyControlAction({
        action: "frobnicate",
        selectionKeys: ["tier1:abc"],
      }),
    (err: Error & { status?: number }) => err.status === 400,
  );
});

test("dispatchProxyControlAction run-check accepts empty selection (global tick)", async () => {
  await reset();
  const result = await service.dispatchProxyControlAction({
    action: "run-check",
    selectionKeys: [],
  });
  assert.equal(result.success, true);
  assert.equal(result.applied, 1);
});
