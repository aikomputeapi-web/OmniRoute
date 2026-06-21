import test from "node:test";
import assert from "node:assert/strict";

// We install a fetch spy on `globalThis.fetch` BEFORE importing proxyFetch.
// This ensures originalFetch captures our spy instead of the real native fetch.
type FetchCall = { input: unknown; init: RequestInit & { headers?: HeadersInit } };
const relayCalls: FetchCall[] = [];
const realGlobalFetch = globalThis.fetch;

const relaySink = (async (input: unknown, init: RequestInit = {}) => {
  const urlStr = String(input);
  if (urlStr.includes("metadata.google.internal")) {
    relayCalls.push({ input, init });
    return new Response("mock-gcp-jwt-token");
  }
  relayCalls.push({ input, init });
  return Response.json({ via: "gcp-relay" });
}) as unknown as typeof globalThis.fetch;

globalThis.fetch = relaySink;

// Dynamic imports so our spy is bound as originalFetch in the module context.
const proxyDispatcher = await import("../../open-sse/utils/proxyDispatcher.ts");
const proxyFetchMod = (await import("../../open-sse/utils/proxyFetch.ts")) as any;
const { proxyFetch, runWithProxyContext } = proxyFetchMod;

test.after(() => {
  globalThis.fetch = realGlobalFetch;
});

test.beforeEach(() => {
  relayCalls.length = 0;
});

// --------------------------------------------------------------------------
// GCP Serverless Relay Tests
// --------------------------------------------------------------------------

const GCP_CTX = {
  type: "gcp" as const,
  host: "us-central1-project.cloudfunctions.net/proxy-function",
};

test("proxyFetch routes a gcp-type context through the GCP function, fetching metadata token first", async () => {
  const response = await runWithProxyContext(GCP_CTX, () =>
    proxyFetch("https://api.openai.com/v1/chat/completions?x=1", {
      method: "POST",
      headers: { "x-custom-hdr": "hello", Authorization: "Bearer original-user-token" },
    })
  );

  // The canned response proves the GCP relay sink was hit
  assert.deepEqual(await response.json(), { via: "gcp-relay" });

  assert.equal(relayCalls.length, 2, "exactly two fetches: one for token, one for target");

  const [tokenCall, forwardCall] = relayCalls;

  // Verify Metadata server request
  assert.ok(String(tokenCall.input).includes("metadata.google.internal"));
  assert.ok(
    String(tokenCall.input).includes(
      "audience=https%3A%2F%2Fus-central1-project.cloudfunctions.net%2Fproxy-function"
    )
  );
  const tokenHeaders = new Headers(tokenCall.init.headers);
  assert.equal(tokenHeaders.get("Metadata-Flavor"), "Google");

  // Verify forward request to GCP function
  assert.equal(forwardCall.input, "https://us-central1-project.cloudfunctions.net/proxy-function");
  const sentHeaders = new Headers(forwardCall.init.headers);
  assert.equal(sentHeaders.get("Authorization"), "Bearer mock-gcp-jwt-token");
  assert.equal(sentHeaders.get("x-relay-auth"), "Bearer original-user-token");
  assert.equal(sentHeaders.get("x-relay-target"), "https://api.openai.com");
  assert.equal(sentHeaders.get("x-relay-path"), "/v1/chat/completions?x=1");
  assert.equal(sentHeaders.get("x-custom-hdr"), "hello");
  assert.equal(forwardCall.init.method, "POST");
  assert.equal((forwardCall.init as { duplex?: string }).duplex, "half");
});
