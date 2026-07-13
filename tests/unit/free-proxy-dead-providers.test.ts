import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dead-providers-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getProvider, getEnabledProviders, setPersistedProviderToggles } =
  await import("../../src/lib/freeProxyProviders/index.ts");

const OPT_IN = [
  { id: "proxifly", env: "FREE_PROXY_PROXIFLY_ENABLED" },
  { id: "iplocate", env: "FREE_PROXY_IPLOCATE_ENABLED" },
] as const;

function clearEnv() {
  for (const p of OPT_IN) delete process.env[p.env];
}

test.beforeEach(() => {
  clearEnv();
  setPersistedProviderToggles(null); // fall back to env defaults
});

test.after(() => {
  clearEnv();
  setPersistedProviderToggles(null);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

for (const p of OPT_IN) {
  test(`${p.id} is DISABLED by default (opt-in — contributes nothing, errors every sync)`, () => {
    assert.equal(getProvider(p.id)?.isEnabled(), false);
  });

  test(`${p.id} enables when ${p.env}=true`, () => {
    process.env[p.env] = "true";
    assert.equal(getProvider(p.id)?.isEnabled(), true);
  });

  test(`${p.id} stays disabled for any non-"true" env value`, () => {
    process.env[p.env] = "1";
    assert.equal(getProvider(p.id)?.isEnabled(), false);
  });

  test(`${p.id} a persisted UI toggle of true overrides the opt-in default`, () => {
    setPersistedProviderToggles({ [p.id]: true });
    assert.equal(getProvider(p.id)?.isEnabled(), true);
  });
}

test("opt-in providers are excluded from getEnabledProviders() with no config", () => {
  const enabledIds = getEnabledProviders().map((p) => p.id);
  assert.ok(!enabledIds.includes("proxifly"), "proxifly should not be enabled by default");
  assert.ok(!enabledIds.includes("iplocate"), "iplocate should not be enabled by default");
});

test("default-ON providers stay enabled with no env flag set", () => {
  // proxypool/proxyscraper keep the historical default-ON behaviour.
  delete process.env.FREE_PROXY_PROXYPOOL_ENABLED;
  delete process.env.FREE_PROXY_PROXYSCRAPER_ENABLED;
  assert.equal(getProvider("proxypool")?.isEnabled(), true);
  assert.equal(getProvider("proxyscraper")?.isEnabled(), true);
});
