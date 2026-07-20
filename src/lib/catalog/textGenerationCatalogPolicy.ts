/**
 * Customer text-generation catalog policy.
 *
 * The public /v1/models response is intentionally limited to models that can
 * serve text generation through the chat/responses APIs. Specialty models stay
 * available to their dedicated API routes but are not advertised to chat-only
 * clients.
 */

export type CatalogModelLike = {
  id?: unknown;
  root?: unknown;
  type?: unknown;
  api_format?: unknown;
  apiFormat?: unknown;
  supported_endpoints?: unknown;
  supportedEndpoints?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
};

export type CatalogExclusionReason =
  | "not-text-generation"
  | "non-chat-endpoint"
  | "internal-or-routing-alias"
  | "blocked-provider-prefix";

const NON_TEXT_MODEL_TYPES = new Set([
  "audio",
  "embedding",
  "image",
  "moderation",
  "music",
  "rerank",
  "video",
]);

const TEXT_GENERATION_ENDPOINTS = new Set(["chat", "chat-completions", "responses"]);

const NON_TEXT_ENDPOINTS = new Set([
  "audio",
  "embeddings",
  "images",
  "moderations",
  "music",
  "rerank",
  "transcriptions",
  "video",
]);

const HIDDEN_PROVIDER_PREFIXES = new Set([
  "chipotle",
  "ddgw",
  "duckduckgo-web",
  "oc",
  "pepper",
  "theoldllm",
  "tllm",
  "veo-free",
  "veoaifree-web",
]);

const EXACTLY_EXCLUDED_MODEL_IDS = new Set([
  "auto",
  "big-pickle",
  "codex-auto-review",
  "gemini-pro-agent",
  "gpt-5.2",
  "gpt-5-2",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "nc-15-codex-auto-review",
  "nc-codex-auto-review",
  "nemotron-3-super-free",
  "pepper-1",
  "trinity-large-preview-free",
]);

const EXCLUDED_ID_FRAGMENTS = [
  "codex-auto-review",
  "codex_auto",
  "-embedding",
  "bge-",
  "distilbert",
  "reranker",
  "resnet",
  "m2m100",
  "indictrans",
  "whisper",
  "deepgram",
  "melotts",
  "aura-",
  "stable-diffusion",
  "dreamshaper",
  "flux",
  "gpt-image",
  "nano-banana",
  "image-quality",
  "image-1",
  "image-2",
  "imagine-image",
  "imagine-video",
  "inpainting",
  "img2img",
  "text-to-speech",
];

/**
 * Normalize only true spelling aliases. Never map a request to a newer model
 * version: availability and routing must accurately reflect the backing target.
 */
export function getCanonicalTextGenerationModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "gpt-5.5": "gpt-5-5",
    "gpt-5.5-high": "gpt-5-5-high",
    "gpt-5.4": "gpt-5-4",
    "gpt-5.4-high": "gpt-5-4-high",
    "gpt-5.4-mini": "gpt-5-4-mini",
    "gpt-5.4-nano": "gpt-5-4-nano",
    "gpt-5.3": "gpt-5-3",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-opus-4.7": "claude-opus-4-7",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "gemini-3.1-pro": "gemini-3-1-pro",
    "gemini-3.1-flash-lite": "gemini-3-1-flash-lite",
    "gemini-2.5-pro": "gemini-2-5-pro",
    "gemini-2.5-flash": "gemini-2-5-flash",
    "kimi-k2.6": "kimi-2.6",
  };
  return aliases[normalized] ?? normalized;
}

function getModelIdentifier(model: CatalogModelLike): string {
  const root = typeof model.root === "string" ? model.root : "";
  const id = typeof model.id === "string" ? model.id : "";
  return (root || id).toLowerCase();
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.toLowerCase())
    : [];
}

export function getTextGenerationCatalogExclusionReason(
  model: CatalogModelLike
): CatalogExclusionReason | null {
  const identifier = getModelIdentifier(model);
  const modelId = typeof model.id === "string" ? model.id.toLowerCase() : "";
  const providerPrefix = modelId.includes("/") ? modelId.split("/", 1)[0] : "";
  if (HIDDEN_PROVIDER_PREFIXES.has(providerPrefix)) return "blocked-provider-prefix";

  const canonicalId = getCanonicalTextGenerationModelId(identifier);
  if (
    EXACTLY_EXCLUDED_MODEL_IDS.has(identifier) ||
    EXACTLY_EXCLUDED_MODEL_IDS.has(canonicalId) ||
    EXCLUDED_ID_FRAGMENTS.some((fragment) => identifier.includes(fragment))
  ) {
    return "internal-or-routing-alias";
  }

  const type = typeof model.type === "string" ? model.type.toLowerCase() : "";
  if (NON_TEXT_MODEL_TYPES.has(type)) return "not-text-generation";

  const apiFormat =
    typeof model.api_format === "string"
      ? model.api_format
      : typeof model.apiFormat === "string"
        ? model.apiFormat
        : "";
  if (apiFormat && apiFormat !== "chat-completions" && apiFormat !== "responses") {
    return "non-chat-endpoint";
  }

  const endpoints = asStringArray(model.supported_endpoints ?? model.supportedEndpoints);
  if (endpoints.length > 0) {
    if (endpoints.some((endpoint) => TEXT_GENERATION_ENDPOINTS.has(endpoint))) return null;
    if (endpoints.some((endpoint) => NON_TEXT_ENDPOINTS.has(endpoint)))
      return "not-text-generation";
  }

  const outputs = asStringArray(model.output_modalities);
  if (outputs.length > 0 && !outputs.includes("text")) return "not-text-generation";

  return null;
}

export function isTextGenerationCatalogModel(model: CatalogModelLike): boolean {
  return getTextGenerationCatalogExclusionReason(model) === null;
}

export function sanitizeTextGenerationCatalogId(modelId: string): string {
  return modelId
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
