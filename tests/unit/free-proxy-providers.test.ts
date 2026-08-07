import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-free-providers-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// Providers read process.env at call-time, so we can set flags before import
process.env.FREE_PROXY_1PROXY_ENABLED = "true";
process.env.FREE_PROXY_PROXIFLY_ENABLED = "false";
process.env.FREE_PROXY_IPLOCATE_ENABLED = "false";

const core = await import("../../src/lib/db/core.ts");
const { getProvider, getEnabledProviders, getAllProviders } =
  await import("../../src/lib/freeProxyProviders/index.ts");

async function reset() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── Registry ─────────────────────────────────────────────────────────────────

test("getAllProviders returns the registered providers", () => {
  const providers = getAllProviders();
  const ids = providers.map((p) => p.id).sort();
  assert.equal(providers.length, 5);
  assert.deepEqual(ids, ["1proxy", "iplocate", "proxifly", "proxypool", "proxyscraper"]);
});

test("getProvider returns the correct provider by id", () => {
  const p = getProvider("1proxy");
  assert.ok(p);
  assert.equal(p.id, "1proxy");
});

test("getProvider returns undefined for unknown id", () => {
  const p = getProvider("unknown" as Parameters<typeof getProvider>[0]);
  assert.equal(p, undefined);
});

test("getEnabledProviders respects env flags", () => {
  // Only 1proxy is enabled in this test env
  const enabled = getEnabledProviders();
  const ids = enabled.map((p) => p.id);
  assert.ok(ids.includes("1proxy"));
  assert.ok(!ids.includes("proxifly"));
  assert.ok(!ids.includes("iplocate"));
});

// ── OneproxyProvider ──────────────────────────────────────────────────────────

test("OneproxyProvider.isEnabled returns false when env is 'false'", () => {
  const original = process.env.FREE_PROXY_1PROXY_ENABLED;
  process.env.FREE_PROXY_1PROXY_ENABLED = "false";
  const p = getProvider("1proxy")!;
  assert.equal(p.isEnabled(), false);
  process.env.FREE_PROXY_1PROXY_ENABLED = original;
});

test("OneproxyProvider.sync returns disabled error when not enabled", async () => {
  const original = process.env.FREE_PROXY_1PROXY_ENABLED;
  process.env.FREE_PROXY_1PROXY_ENABLED = "false";
  await reset();

  const p = getProvider("1proxy")!;
  const result = await p.sync();
  assert.equal(result.fetched, 0);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].includes("disabled"));

  process.env.FREE_PROXY_1PROXY_ENABLED = original;
});

test("OneproxyProvider.sync handles HTTP error and increments failure count", async () => {
  await reset();
  const original = process.env.FREE_PROXY_1PROXY_API_URL;

  // Point to a URL that returns non-200
  process.env.FREE_PROXY_1PROXY_ENABLED = "true";
  process.env.FREE_PROXY_1PROXY_API_URL = "http://127.0.0.1:1/nonexistent";

  const p = getProvider("1proxy")!;
  const result = await p.sync();

  assert.equal(result.fetched, 0);
  assert.ok(result.errors.length > 0);

  process.env.FREE_PROXY_1PROXY_API_URL = original ?? "";
});

test("OneproxyProvider.list delegates to listFreeProxiesBySource", async () => {
  await reset();
  process.env.FREE_PROXY_1PROXY_ENABLED = "true";

  const freeProxiesDb = await import("../../src/lib/db/freeProxies.ts");
  await freeProxiesDb.upsertFreeProxy({
    source: "1proxy",
    host: "99.0.0.1",
    port: 8080,
    type: "http",
    countryCode: "US",
    qualityScore: 70,
    latencyMs: 100,
    anonymity: null,
    lastValidated: null,
  });

  const p = getProvider("1proxy")!;
  const items = await p.list({ limit: 10 });
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 1);
  assert.equal(items[0].source, "1proxy");
});

// ── ProxiflyProvider ──────────────────────────────────────────────────────────

test("ProxiflyProvider.isEnabled returns true when not set (enabled by default)", () => {
  const original = process.env.FREE_PROXY_PROXIFLY_ENABLED;
  delete process.env.FREE_PROXY_PROXIFLY_ENABLED;
  const p = getProvider("proxifly")!;
  assert.equal(p.isEnabled(), true);
  if (original !== undefined) process.env.FREE_PROXY_PROXIFLY_ENABLED = original;
});

test("ProxiflyProvider.isEnabled returns true when explicitly set", () => {
  const original = process.env.FREE_PROXY_PROXIFLY_ENABLED;
  process.env.FREE_PROXY_PROXIFLY_ENABLED = "true";
  const p = getProvider("proxifly")!;
  assert.equal(p.isEnabled(), true);
  process.env.FREE_PROXY_PROXIFLY_ENABLED = original ?? "";
});

test("ProxiflyProvider.sync returns disabled error when not enabled", async () => {
  const original = process.env.FREE_PROXY_PROXIFLY_ENABLED;
  process.env.FREE_PROXY_PROXIFLY_ENABLED = "false";
  await reset();

  const p = getProvider("proxifly")!;
  const result = await p.sync();
  assert.equal(result.fetched, 0);
  assert.ok(result.errors.some((e) => e.includes("disabled")));

  process.env.FREE_PROXY_PROXIFLY_ENABLED = original ?? "";
});

test("ProxiflyProvider.sync fetches each protocol in API-sized batches", async () => {
  await reset();
  const originalEnabled = process.env.FREE_PROXY_PROXIFLY_ENABLED;
  const originalQuantity = process.env.FREE_PROXY_PROXIFLY_QUANTITY;
  const originalFetch = globalThis.fetch;

  // protocol -> requested batch quantities, in order
  const byProtocol = new Map<string, string[]>();
  process.env.FREE_PROXY_PROXIFLY_ENABLED = "true";
  process.env.FREE_PROXY_PROXIFLY_QUANTITY = "25";

  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    const protocol = url.searchParams.get("protocol") || "";
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(url.searchParams.get("anonymity"), "elite");
    const list = byProtocol.get(protocol) ?? [];
    list.push(url.searchParams.get("quantity") || "");
    byProtocol.set(protocol, list);

    const quantity = Number(url.searchParams.get("quantity"));
    const batchIndex = list.length - 1;
    const body = Array.from({ length: quantity }, (_, index) => ({
      // unique host per (protocol, batch, index) so nothing dedups
      ip: `42.${protocol.length}.${batchIndex}.${index + 1}`,
      port: 8000 + index,
      protocol,
      anonymity: "elite",
      score: 50 + index,
      geolocation: { country: "US" },
    }));

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const p = getProvider("proxifly")!;
    const result = await p.sync();

    // All three default protocols are fetched, each split into 20 + 5 (quantity=25).
    assert.deepEqual([...byProtocol.keys()].sort(), ["http", "https", "socks5"]);
    for (const [, quantities] of byProtocol) {
      assert.deepEqual(quantities, ["20", "5"]);
    }
    assert.deepEqual(result.errors, []);
    assert.ok(result.fetched > 0);

    const items = await p.list({ limit: 200 });
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.source === "proxifly"));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.FREE_PROXY_PROXIFLY_ENABLED = originalEnabled ?? "";
    process.env.FREE_PROXY_PROXIFLY_QUANTITY = originalQuantity ?? "";
  }
});

// ── IplocateProvider ──────────────────────────────────────────────────────────

test("IplocateProvider.isEnabled defaults to enabled (framework default: on unless '=false')", () => {
  const original = process.env.FREE_PROXY_IPLOCATE_ENABLED;
  delete process.env.FREE_PROXY_IPLOCATE_ENABLED;
  const p = getProvider("iplocate")!;
  assert.equal(p.isEnabled(), true);
  if (original !== undefined) process.env.FREE_PROXY_IPLOCATE_ENABLED = original;
});

test("IplocateProvider.sync returns disabled error when not enabled", async () => {
  const original = process.env.FREE_PROXY_IPLOCATE_ENABLED;
  process.env.FREE_PROXY_IPLOCATE_ENABLED = "false";
  await reset();

  const p = getProvider("iplocate")!;
  const result = await p.sync();
  assert.equal(result.fetched, 0);
  assert.ok(result.errors.some((e) => e.includes("disabled")));

  process.env.FREE_PROXY_IPLOCATE_ENABLED = original ?? "";
});

test("IplocateProvider.sync fetches and parses the geonode JSON proxy list", async () => {
  const original = process.env.FREE_PROXY_IPLOCATE_ENABLED;
  const originalFetch = globalThis.fetch;
  process.env.FREE_PROXY_IPLOCATE_ENABLED = "true";
  await reset();

  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seenUrls.push(String(input));
    // IPLocate now sources from geonode's JSON API (`{ data: [...] }`), not the
    // old iplocate .txt line lists.
    const body = {
      data: [
        {
          ip: "103.173.141.10",
          port: 8080,
          protocols: ["http"],
          country: "US",
          speed: 1200,
          anonymityLevel: "elite",
        },
        {
          ip: "8.211.49.86",
          port: 9028,
          protocols: ["http"],
          country: "US",
          speed: 800,
          anonymityLevel: "elite",
        },
      ],
      total: 2,
      page: 1,
      limit: 500,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const p = getProvider("iplocate")!;
    const result = await p.sync();
    assert.ok(
      seenUrls.length > 0 &&
        seenUrls.every((u) => u.startsWith("https://proxylist.geonode.com/api/proxy/list")),
      `expected geonode API URLs, got: ${seenUrls.join(", ")}`
    );
    assert.ok(result.fetched > 0, `expected proxies parsed from geonode, got ${result.fetched}`);
    const items = await p.list({ limit: 50 });
    assert.ok(
      items.some((i) => i.host === "103.173.141.10" && i.port === 8080),
      "parsed geonode proxy must be stored"
    );
    assert.ok(items.every((i) => i.source === "iplocate"));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.FREE_PROXY_IPLOCATE_ENABLED = original ?? "";
  }
});
