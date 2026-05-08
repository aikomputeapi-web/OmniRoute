import test from "node:test";
import assert from "node:assert/strict";

const { isVisionModelId } = await import("../../src/shared/constants/visionModels.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { getCanonicalModelMetadata } = await import("../../src/lib/modelMetadataRegistry.ts");

test("vision model helper recognizes tokenized and hyphenated vision model names", () => {
  assert.equal(isVisionModelId("qwen3-vl-8b"), true);
  assert.equal(isVisionModelId("solar-docvision"), true);
  assert.equal(isVisionModelId("openai/gpt-4o"), true);
  assert.equal(isVisionModelId("vertex/gemini-2.5-pro"), true);
  assert.equal(isVisionModelId("text-only-model"), false);
});

test("resolved capabilities mark common vision models as image-capable", () => {
  assert.equal(
    getResolvedModelCapabilities({ provider: "openai", model: "gpt-4o" }).supportsVision,
    true
  );
  assert.equal(
    getResolvedModelCapabilities({ provider: "vertex", model: "gemini-2.5-pro" }).supportsVision,
    true
  );
  assert.equal(
    getResolvedModelCapabilities({ provider: "llamagate", model: "qwen3-vl-8b" }).supportsVision,
    true
  );
});

test("canonical metadata exposes image input modalities for vision models", () => {
  const metadata = getCanonicalModelMetadata({ provider: "openai", model: "gpt-4o" });
  assert.ok(metadata);
  assert.equal(metadata?.capabilities.vision, true);
  assert.deepEqual(metadata?.modalities.input, ["text", "image"]);
  assert.deepEqual(metadata?.modalities.output, ["text"]);
});
