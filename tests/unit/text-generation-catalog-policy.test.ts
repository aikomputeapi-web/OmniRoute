import test from "node:test";
import assert from "node:assert/strict";

import {
  getCanonicalTextGenerationModelId,
  getTextGenerationCatalogExclusionReason,
  isTextGenerationCatalogModel,
  sanitizeTextGenerationCatalogId,
} from "../../src/lib/catalog/textGenerationCatalogPolicy.ts";

test("policy keeps multimodal and text-only generation models", () => {
  for (const model of [
    { id: "gpt-5-4", output_modalities: ["text"] },
    { id: "cm/claude-sonnet-4-6", root: "claude-sonnet-4-6", input_modalities: ["text", "image"] },
    { id: "gemini-3-1-pro", supported_endpoints: ["chat"] },
    { id: "llama-4-scout", api_format: "chat-completions" },
  ]) {
    assert.equal(isTextGenerationCatalogModel(model), true, JSON.stringify(model));
    assert.equal(getTextGenerationCatalogExclusionReason(model), null);
  }
});

test("policy quarantines specialty and non-generation models", () => {
  const cases: Array<Record<string, unknown>> = [
    { id: "cf-openai-whisper", root: "whisper" },
    { id: "cf-baai-bge-m3", root: "bge-m3" },
    { id: "gpt-image-2", root: "gpt-image-2" },
    { id: "flux-2-dev", root: "flux-2-dev" },
    { id: "embed-1", type: "embedding" },
    { id: "image-1", type: "image" },
    { id: "audio-1", supported_endpoints: ["audio"] },
    { id: "video-1", output_modalities: ["video"] },
  ];

  for (const model of cases) {
    assert.equal(isTextGenerationCatalogModel(model), false, JSON.stringify(model));
    assert.ok(getTextGenerationCatalogExclusionReason(model), JSON.stringify(model));
  }
});

test("policy hides operational aliases and blocked provider prefixes", () => {
  assert.equal(
    getTextGenerationCatalogExclusionReason({ id: "auto", root: "auto" }),
    "internal-or-routing-alias"
  );
  assert.equal(
    getTextGenerationCatalogExclusionReason({
      id: "codex-auto-review",
      root: "codex-auto-review",
    }),
    "internal-or-routing-alias"
  );
  assert.equal(
    getTextGenerationCatalogExclusionReason({ id: "tllm/gpt-5", root: "gpt-5" }),
    "blocked-provider-prefix"
  );
});

test("canonicalization preserves distinct versions and normalizes exact spelling aliases only", () => {
  assert.equal(getCanonicalTextGenerationModelId("gpt-5.4"), "gpt-5-4");
  assert.equal(getCanonicalTextGenerationModelId("claude-sonnet-4.6"), "claude-sonnet-4-6");
  assert.equal(getCanonicalTextGenerationModelId("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(getCanonicalTextGenerationModelId("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(getCanonicalTextGenerationModelId("deepseek-v3"), "deepseek-v3");
});

test("catalog IDs are sanitized for combo names without inventing model identities", () => {
  assert.equal(
    sanitizeTextGenerationCatalogId("deepseek-ai/deepseek-v4-pro"),
    "deepseek-ai-deepseek-v4-pro"
  );
});
