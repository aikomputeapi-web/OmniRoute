import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-text-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "text-catalog-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const mappingsDb = await import("../../src/lib/db/modelComboMappings.ts");
const virtualCatalog = await import("../../src/lib/catalog/generateVirtualCatalog.ts");
const publicCatalog = await import("../../src/app/api/v1/models/catalog.ts");

const PROVIDER_ID = "openai-compatible-text-catalog";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedMixedInventory() {
  const connection = await providersDb.createProviderConnection({
    provider: PROVIDER_ID,
    authType: "apikey",
    name: "mixed-upstream",
    apiKey: "sk-test",
    isActive: true,
    providerSpecificData: {},
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER_ID, connection.id as string, [
    {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      supportedEndpoints: ["chat"],
      inputTokenLimit: 200000,
    },
    {
      id: "gpt-image-2",
      name: "Image Generator",
      supportedEndpoints: ["images"],
    },
    {
      id: "openai-whisper",
      name: "Whisper",
      supportedEndpoints: ["audio"],
    },
    {
      id: "bge-m3",
      name: "BGE Embedding",
      supportedEndpoints: ["embeddings"],
    },
    {
      id: "codex-auto-review",
      name: "Auto Review",
      supportedEndpoints: ["chat"],
    },
  ]);
}

test.beforeEach(async () => {
  await resetStorage();
  await settingsDb.updateSettings({ virtualCatalogEnabled: true });
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("virtual catalog generation only creates text-generation combos and preserves versions", async () => {
  await seedMixedInventory();

  const result = await virtualCatalog.generateVirtualCatalog();
  const entryIds = result.entries.map((entry) => entry.id);

  assert.deepEqual(entryIds, ["claude-sonnet-4-5"]);
  assert.equal(entryIds.includes("claude-sonnet-4-6"), false);
  assert.equal(entryIds.includes("gpt-image-2"), false);
  assert.equal(entryIds.includes("openai-whisper"), false);
  assert.equal(entryIds.includes("bge-m3"), false);
  assert.equal(entryIds.includes("codex-auto-review"), false);

  const quarantined = await virtualCatalog.getVirtualCatalogQuarantinedModels();
  const reasons = new Map(quarantined.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons.get(`${PROVIDER_ID}/gpt-image-2`), "not-text-generation");
  assert.equal(reasons.get(`${PROVIDER_ID}/openai-whisper`), "not-text-generation");
  assert.equal(reasons.get(`${PROVIDER_ID}/bge-m3`), "not-text-generation");
  assert.equal(reasons.get(`${PROVIDER_ID}/codex-auto-review`), "internal-or-routing-alias");
});

test("regeneration updates existing combos in place and deletes stale generated entries last", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: PROVIDER_ID,
    authType: "apikey",
    name: "mixed-upstream",
    apiKey: "sk-test",
    isActive: true,
    providerSpecificData: {},
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER_ID, connection.id as string, [
    { id: "gpt-5-4", name: "GPT 5.4", supportedEndpoints: ["chat"] },
    { id: "deepseek-v3", name: "DeepSeek V3", supportedEndpoints: ["chat"] },
  ]);

  const first = await virtualCatalog.generateVirtualCatalog();
  assert.equal(first.created, 2);
  const before = await combosDb.getCombos();
  const virtualBefore = before.find(
    (combo) =>
      Array.isArray(combo.tags) &&
      combo.tags.includes("__virtual_catalog__") &&
      combo.name === "gpt-5-4"
  );
  assert.ok(virtualBefore, "expected generated gpt-5-4 combo");

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER_ID, connection.id as string, [
    { id: "gpt-5.4", name: "GPT 5.4 alias", supportedEndpoints: ["chat"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportedEndpoints: ["chat"] },
  ]);

  const second = await virtualCatalog.generateVirtualCatalog();
  assert.equal(second.created, 1, "new exact model gets a new combo");
  assert.equal(second.updated, 1, "spelling alias updates existing combo");
  assert.equal(second.deleted, 1, "stale exact model is removed after upsert");

  const entries = await virtualCatalog.getVirtualCatalogEntries();
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ["deepseek-v4-pro", "gpt-5-4"]);

  const updated = await combosDb.getComboById(virtualBefore.id as string);
  assert.equal(updated?.name, "gpt-5-4", "combo identity is preserved across regeneration");

  const mappings = await mappingsDb.getModelComboMappings();
  const generatedPatterns = mappings
    .filter((mapping) => mapping.description === "__virtual_catalog__")
    .map((mapping) => mapping.pattern);
  assert.ok(generatedPatterns.includes("gpt-5.4"), "observed alias remains routable");
  assert.ok(generatedPatterns.includes("gpt-5-4"), "canonical alias remains routable");
  assert.equal(generatedPatterns.includes("deepseek-v3"), false, "stale mapping removed");
});

test("manual provider-target membership persists across automatic regeneration", async () => {
  await seedMixedInventory();
  await virtualCatalog.generateVirtualCatalog();
  const modelId = `${PROVIDER_ID}/claude-sonnet-4-5`;

  let inventory = await virtualCatalog.getManualCatalogInventory();
  assert.equal(inventory.find((entry) => entry.id === modelId)?.inVirtualCatalog, true);

  await virtualCatalog.setManualCatalogMembership(modelId, false);
  inventory = await virtualCatalog.getManualCatalogInventory();
  assert.equal(inventory.find((entry) => entry.id === modelId)?.inVirtualCatalog, false);
  assert.equal(inventory.find((entry) => entry.id === modelId)?.override, "excluded");

  await virtualCatalog.generateVirtualCatalog();
  inventory = await virtualCatalog.getManualCatalogInventory();
  assert.equal(
    inventory.find((entry) => entry.id === modelId)?.inVirtualCatalog,
    false,
    "scheduled regeneration must honor the manual exclusion"
  );

  await virtualCatalog.setManualCatalogMembership(modelId, true);
  inventory = await virtualCatalog.getManualCatalogInventory();
  assert.equal(inventory.find((entry) => entry.id === modelId)?.inVirtualCatalog, true);
  assert.equal(inventory.find((entry) => entry.id === modelId)?.override, "included");

  await assert.rejects(
    virtualCatalog.setManualCatalogMembership(`${PROVIDER_ID}/gpt-image-2`, true),
    /Only text-generation models can be added/
  );
});

test("public /v1/models returns only text-generation entries with virtual catalog enabled", async () => {
  await seedMixedInventory();
  await virtualCatalog.generateVirtualCatalog();

  const response = await publicCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data: Array<{ id: string; root?: string; type?: string }>;
  };
  const ids = body.data.map((model) => model.id);

  assert.ok(ids.includes("claude-sonnet-4-5"), "virtual text model is listed");
  assert.equal(ids.includes("claude-sonnet-4-6"), false, "must not invent newer versions");
  assert.equal(
    ids.some((id) => id.includes("gpt-image")),
    false
  );
  assert.equal(
    ids.some((id) => id.includes("whisper")),
    false
  );
  assert.equal(
    ids.some((id) => id.includes("bge")),
    false
  );
  assert.equal(
    ids.some((id) => id.includes("codex-auto-review")),
    false
  );
  assert.equal(
    body.data.some((model) => model.type && model.type !== "chat"),
    false
  );
});
