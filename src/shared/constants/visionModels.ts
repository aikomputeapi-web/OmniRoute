const VISION_MODEL_SUBSTRINGS = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4-vision",
  "gpt-4-turbo",
  "claude-3",
  "claude-3.5",
  "claude-3-5",
  "claude-4",
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gemini",
  "gemma",
  "mistral-pixtral",
  "vision",
  "multimodal",
];

const VISION_MODEL_TOKENS = new Set(["bakllava", "llava", "pixtral", "qvq", "vl", "docvision"]);

export function isVisionModelId(modelId: string): boolean {
  const normalized = String(modelId || "").toLowerCase();
  if (!normalized) return false;

  if (VISION_MODEL_SUBSTRINGS.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => VISION_MODEL_TOKENS.has(token));
}
