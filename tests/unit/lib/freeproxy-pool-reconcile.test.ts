import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reconcile-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { reconcileFreeProxyPoolFlags } = await import("../../../src/lib/db/freeProxies.ts");

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${++seq}`;
}

/** Insert a free_proxies row with explicit tier/in_pool/pool link. */
function insertFreeProxy(fields: {
  tier: number;
  inPool: number;
  poolProxyId: string | null;
  host?: string;
}): string {
  const db = core.getDbInstance();
  const id = uid("fp");
  const host = fields.host ?? `10.0.0.${seq}`;
  db.prepare(
    `INSERT INTO free_proxies
       (id, source, host, port, type, country_code, in_pool, pool_proxy_id,
        test_count, success_count, tier, consecutive_successes, consecutive_failures,
        created_at, updated_at)
     VALUES (?, 'proxyscraper', ?, 8080, 'http', 'US', ?, ?, 5, 5, ?, 4, 0, ?, ?)`
  ).run(
    id,
    host,
    fields.inPool,
    fields.poolProxyId,
    fields.tier,
    new Date().toISOString(),
    new Date().toISOString()
  );
  return id;
}

/** Insert a proxy_registry row; optionally give it a global-pool assignment. */
function insertRegistry(opts: { assigned: boolean; scope?: string; scopeId?: string }): string {
  const db = core.getDbInstance();
  const id = uid("reg");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO proxy_registry
       (id, name, type, host, port, username, password, status, source, created_at, updated_at)
     VALUES (?, ?, 'http', ?, 8080, '', '', 'active', 'proxyscraper', ?, ?)`
  ).run(id, `reg-${id}`, `172.16.0.${seq}`, now, now);
  if (opts.assigned) {
    db.prepare(
      `INSERT INTO proxy_assignments (scope, scope_id, proxy_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(opts.scope ?? "global", opts.scopeId ?? `__global__${seq}`, id, now, now);
  }
  return id;
}

function tierOf(id: string): { tier: number; in_pool: number; pool_proxy_id: string | null } {
  return core
    .getDbInstance()
    .prepare("SELECT tier, in_pool, pool_proxy_id FROM free_proxies WHERE id = ?")
    .get(id) as { tier: number; in_pool: number; pool_proxy_id: string | null };
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  core.getDbInstance(); // runs migrations (incl. 120) on the fresh db
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("reclaims a tier=1/in_pool=1 row whose registry row has no assignment", async () => {
  const reg = insertRegistry({ assigned: false });
  const fp = insertFreeProxy({ tier: 1, inPool: 1, poolProxyId: reg });

  const res = await reconcileFreeProxyPoolFlags();

  assert.equal(res.reclaimed, 1);
  const after = tierOf(fp);
  assert.equal(after.in_pool, 0, "should be unpooled");
  assert.equal(after.tier, 1, "tier 1 stays tier 1");
  assert.equal(after.pool_proxy_id, null, "unroutable link cleared");
});

test("reclaims a tier=3/in_pool=1 row with no assignment and demotes it to tier 2", async () => {
  const reg = insertRegistry({ assigned: false });
  const fp = insertFreeProxy({ tier: 3, inPool: 1, poolProxyId: reg });

  const res = await reconcileFreeProxyPoolFlags();

  assert.equal(res.reclaimed, 1);
  const after = tierOf(fp);
  assert.equal(after.in_pool, 0);
  assert.equal(after.tier, 2, "former tier 3 demoted to verified tier 2");
  assert.equal(after.pool_proxy_id, null);
});

test("reclaims a dangling in_pool=1 row whose registry row does not exist", async () => {
  const fp = insertFreeProxy({ tier: 3, inPool: 1, poolProxyId: "does-not-exist" });

  const res = await reconcileFreeProxyPoolFlags();

  assert.equal(res.reclaimed, 1);
  const after = tierOf(fp);
  assert.equal(after.in_pool, 0);
  assert.equal(after.tier, 2);
});

test("leaves a genuinely routable global-pool proxy untouched", async () => {
  const reg = insertRegistry({ assigned: true, scope: "global", scopeId: "__global__0" });
  const fp = insertFreeProxy({ tier: 3, inPool: 1, poolProxyId: reg });

  const res = await reconcileFreeProxyPoolFlags();

  assert.equal(res.reclaimed, 0);
  assert.equal(res.relabeledToTier3, 0);
  const after = tierOf(fp);
  assert.equal(after.in_pool, 1);
  assert.equal(after.tier, 3);
  assert.equal(after.pool_proxy_id, reg);
});

test("relabels a routable but mislabeled (tier=1/in_pool=1 + assignment) row up to tier 3", async () => {
  // A proxy assigned to an account (distribute feature) but left mislabeled tier 1.
  const reg = insertRegistry({ assigned: true, scope: "account", scopeId: uid("acct") });
  const fp = insertFreeProxy({ tier: 1, inPool: 1, poolProxyId: reg });

  const res = await reconcileFreeProxyPoolFlags();

  assert.equal(res.relabeledToTier3, 1);
  assert.equal(res.reclaimed, 0);
  const after = tierOf(fp);
  assert.equal(after.in_pool, 1);
  assert.equal(after.tier, 3);
});

test("demotes a tier=3/in_pool=0 row to tier 2", async () => {
  const fp = insertFreeProxy({ tier: 3, inPool: 0, poolProxyId: null });

  const res = await reconcileFreeProxyPoolFlags();

  assert.equal(res.demotedStaleTier3, 1);
  const after = tierOf(fp);
  assert.equal(after.in_pool, 0);
  assert.equal(after.tier, 2);
});

test("is idempotent — a second run changes nothing", async () => {
  const regUnassigned = insertRegistry({ assigned: false });
  insertFreeProxy({ tier: 1, inPool: 1, poolProxyId: regUnassigned });
  const regAssigned = insertRegistry({ assigned: true });
  insertFreeProxy({ tier: 2, inPool: 1, poolProxyId: regAssigned });
  insertFreeProxy({ tier: 3, inPool: 0, poolProxyId: null });

  const first = await reconcileFreeProxyPoolFlags();
  assert.ok(first.reclaimed + first.relabeledToTier3 + first.demotedStaleTier3 > 0);

  const second = await reconcileFreeProxyPoolFlags();
  assert.deepEqual(second, { reclaimed: 0, relabeledToTier3: 0, demotedStaleTier3: 0 });
});
