/**
 * generateVirtualCatalog.ts — Auto-generate virtual model catalog.
 *
 * Scans all active provider connections, groups models by their root ID
 * (the base model name without provider prefix), and creates:
 *   1. A combo with strategy="priority" for each unique root model
 *   2. A model-combo mapping so bare model names route to the combo
 *
 * This allows customers to use "claude-sonnet-4-6" instead of
 * "kr/claude-sonnet-4-6" and the system will try providers in priority
 * order with automatic failover.
 */

import {
  getProviderConnections,
  getAllCustomModels,
  getSettings,
  getProviderNodes,
  getModelIsHidden,
} from "@/lib/localDb";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getAllSyncedAvailableModels } from "@/lib/db/models";
import { getCombos, createCombo, deleteCombo } from "@/lib/db/combos";
import {
  getModelComboMappings,
  createModelComboMapping,
  deleteModelComboMapping,
} from "@/lib/db/modelComboMappings";
import { hasEligibleConnectionForModel } from "@/domain/connectionModelRules";

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

interface ProviderModelEntry {
  /** Full prefixed ID, e.g. "kr/claude-sonnet-4-6" */
  prefixedId: string;
  /** Raw model ID without prefix, e.g. "claude-sonnet-4-6" */
  rootId: string;
  /** Canonical provider ID */
  providerId: string;
  /** Short alias for this provider, e.g. "kr" */
  alias: string;
  /** Whether this is a chat model vs embedding/image/etc */
  type: "chat" | "embedding" | "image" | "rerank" | "audio" | "other";
  /** Context window length if known */
  contextLength?: number;
  /** Whether model supports vision */
  supportsVision?: boolean;
}

export interface VirtualCatalogEntry {
  /** The clean root model ID (what customers see) */
  id: string;
  /** Combo ID for this virtual model */
  comboId: string;
  /** Provider variants backing this model */
  providers: Array<{
    providerId: string;
    alias: string;
    prefixedId: string;
  }>;
  /** Model type */
  type: string;
  /** Whether this entry is visible in the catalog */
  isVisible: boolean;
}

export interface VirtualCatalogResult {
  created: number;
  updated: number;
  deleted: number;
  entries: VirtualCatalogEntry[];
  errors: string[];
  warnings: string[];
}

// Tag used to identify auto-generated virtual catalog combos
const VIRTUAL_CATALOG_TAG = "__virtual_catalog__";

const ALLOWED_OPENROUTER_MODELS = new Set([
  "moonshotai/kimi-k2.6:free",
  "minimax/minimax-m2.5:free",
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
]);

const ALLOWED_NVIDIA_MODELS = new Set([
  "moonshotai/kimi-k2.6",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "z-ai/glm-5.1",
  "minimaxai/minimax-m2.7",
]);

const FORCED_CONSOLIDATION_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "minimax-m3",
  "kimi-k2",
  "gpt-oss-120b",
  "gpt-oss-20b",
  "glm-5",
  "gpt-5-5",
  "gpt-5-5-high",
  "gpt-5-4",
  "gpt-5-4-high",
  "gpt-5-4-mini",
  "gpt-5-3",
  "gpt-4o",
  "o3-mini",
  "deepseek-v3",
  "deepseek-r1",
  "gemini-3-1-pro",
  "gemini-3-flash",
  "gemini-3-1-flash-lite",
  "gemini-2-5-pro",
  "gemini-2-5-flash",
  "qwen3-coder",
  "llama-4-scout",
  "mistral-small",
  "ling-2-6",
  "qwen3-6",
]);

// Models that should never appear in the customer-facing /v1/models list
const BLOCKLISTED_ROOT_IDS = new Set([
  "codex-auto-review",
  "big-pickle",
  "nemotron-3-super-free",
  "trinity-large-preview-free",
  "pepper-1",
  "gemini-pro-agent",
  "gpt-5-2", // superceded
]);

// Provider prefixes whose models should be hidden entirely unless consolidated
const HIDDEN_PROVIDER_PREFIXES = new Set([
  "veo-free",
  "veoaifree-web",
  "chipotle",
  "pepper",
  "ddgw",
  "duckduckgo-web",
  "theoldllm",
  "tllm",
  "oc",
]);

/**
 * Sanitize a model root ID into a safe combo name.
 * Replaces slashes with hyphens so "deepseek/deepseek-v4-pro" → "deepseek-deepseek-v4-pro".
 * Strips leading/trailing hyphens and collapses consecutive hyphens.
 */
function sanitizeComboName(rootId: string): string {
  return rootId
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getCanonicalRootId(rootId: string): string {
  const lower = rootId.toLowerCase();

  // ── Claude family ──────────────────────────────────────────
  if (lower.includes("claude") && lower.includes("sonnet")) {
    return "claude-sonnet-4-6";
  }
  if (lower.includes("claude") && lower.includes("opus")) {
    return "claude-opus-4-7";
  }
  if (lower.includes("claude") && (lower.includes("haiku") || lower.includes("haiku"))) {
    return "claude-haiku-4-5";
  }

  // ── GPT family ─────────────────────────────────────────────
  if (lower.includes("gpt-oss-120b")) return "gpt-oss-120b";
  if (lower.includes("gpt-oss-20b")) return "gpt-oss-20b";
  if (
    lower.includes("gpt-5.5-high") ||
    lower.includes("gpt-5-5-high") ||
    lower.includes("gpt-5.5-xhigh") ||
    lower.includes("gpt-5-5-xhigh")
  ) {
    return "gpt-5-5-high";
  }
  if (
    (lower.includes("gpt-5.5") || lower.includes("gpt-5-5") || lower.includes("gpt_5_5")) &&
    !lower.includes("high")
  ) {
    return "gpt-5-5";
  }
  if (
    lower.includes("gpt-5.4-high") ||
    lower.includes("gpt-5-4-high") ||
    lower.includes("gpt-5.4-xhigh") ||
    lower.includes("gpt-5-4-xhigh")
  ) {
    return "gpt-5-4-high";
  }
  if (
    (lower.includes("gpt-5.4") || lower.includes("gpt-5-4") || lower.includes("gpt_5_4")) &&
    !lower.includes("mini") &&
    !lower.includes("high")
  ) {
    return "gpt-5-4";
  }
  if (
    lower.includes("gpt-5.4-mini") ||
    lower.includes("gpt-5-4-mini") ||
    lower.includes("gpt-5-mini") ||
    lower.includes("gpt-5.mini") ||
    lower.includes("gpt-4o-mini")
  ) {
    return "gpt-5-4-mini";
  }
  if (lower.includes("gpt-5.3") || lower.includes("gpt-5-3")) {
    return "gpt-5-3";
  }
  if (lower.includes("gpt-4o") || lower.includes("gpt_4o")) {
    return "gpt-4o";
  }

  // ── Gemini family ──────────────────────────────────────────
  if (
    lower.includes("gemini") &&
    lower.includes("pro") &&
    !lower.includes("flash") &&
    !lower.includes("lite") &&
    !lower.includes("agent")
  ) {
    // gemini 3.1 pro variants
    if (
      lower.includes("3.1") ||
      lower.includes("3-1") ||
      lower.includes("3_pro") ||
      lower.includes("gemini_3_pro")
    ) {
      return "gemini-3-1-pro";
    }
    if (lower.includes("2.5") || lower.includes("2-5")) {
      return "gemini-2-5-pro";
    }
    return "gemini-3-1-pro";
  }
  if (lower.includes("gemini") && lower.includes("flash") && lower.includes("lite")) {
    return "gemini-3-1-flash-lite";
  }
  if (lower.includes("gemini") && lower.includes("flash") && !lower.includes("lite")) {
    if (lower.includes("2.5") || lower.includes("2-5")) {
      return "gemini-2-5-flash";
    }
    return "gemini-3-flash";
  }

  // ── DeepSeek family ────────────────────────────────────────
  if (lower.includes("deepseek") && lower.includes("r1")) return "deepseek-r1";
  if (lower.includes("deepseek")) return "deepseek-v3";

  // ── Reasoning ──────────────────────────────────────────────
  if (lower.includes("o3-mini") || lower === "o3mini") return "o3-mini";

  // ── Open weights ───────────────────────────────────────────
  if (lower.includes("llama") && lower.includes("scout")) return "llama-4-scout";
  if (lower.includes("mistral") && lower.includes("small")) return "mistral-small";
  if (lower.includes("ling") && (lower.includes("2.6") || lower.includes("2-6"))) return "ling-2-6";
  if (lower.includes("qwen") && !lower.includes("coder")) return "qwen3-6";

  // ── Other families ─────────────────────────────────────────
  if (lower.includes("minimax")) return "minimax-m3";
  if (lower.includes("kimi")) return "kimi-k2";
  if (lower.includes("glm")) return "glm-5";
  if (lower.includes("qwen") && lower.includes("coder")) return "qwen3-coder";

  return rootId;
}

/** Returns true if a model should be completely excluded from the customer catalog */
export function isBlocklistedForCatalog(rootId: string, providerPrefix: string): boolean {
  if (HIDDEN_PROVIDER_PREFIXES.has(providerPrefix)) return true;
  if (BLOCKLISTED_ROOT_IDS.has(rootId)) return true;
  const lower = rootId.toLowerCase();
  if (lower.includes("codex-auto-review") || lower.includes("codex_auto")) return true;
  if (lower === "gpt-5-2" || lower === "gpt-5.2") return true;
  if (lower.includes("codex-spark") || lower.includes("3-codex") || lower.includes("3.codex"))
    return true;
  return false;
}

function parseVersion(id: string) {
  const match = id.match(/\d+(\.\d+)?/g) || [];
  const numbers = match.map((n) => parseFloat(n));
  const isThinking =
    id.toLowerCase().includes("thinking") || id.toLowerCase().includes("reasoning");
  return { numbers, isThinking };
}

function compareVersions(idA: string, idB: string): number {
  const vA = parseVersion(idA);
  const vB = parseVersion(idB);

  const len = Math.max(vA.numbers.length, vB.numbers.length);
  for (let i = 0; i < len; i++) {
    const numA = vA.numbers[i] ?? 0;
    const numB = vB.numbers[i] ?? 0;
    if (numA !== numB) {
      return numA - numB;
    }
  }

  if (vA.isThinking !== vB.isThinking) {
    return vA.isThinking ? -1 : 1; // regular version preferred over thinking version
  }

  return 0;
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function buildAliasMaps() {
  const aliasToProviderId: Record<string, string> = {};
  const providerIdToAlias: Record<string, string> = {};

  for (const provider of Object.values(AI_PROVIDERS)) {
    const providerId = provider?.id;
    const alias = provider?.alias || providerId;
    if (!providerId) continue;
    aliasToProviderId[providerId] = providerId;
    aliasToProviderId[alias] = providerId;
    if (!providerIdToAlias[providerId]) {
      providerIdToAlias[providerId] = alias;
    }
  }

  for (const [left, right] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
    if (!aliasToProviderId[left]) aliasToProviderId[left] = right;
    if (!aliasToProviderId[right]) aliasToProviderId[right] = left;
    if (!providerIdToAlias[left]) providerIdToAlias[left] = right;
  }

  return { aliasToProviderId, providerIdToAlias };
}

/**
 * Get the default provider priority. Higher = tried first.
 * This can be overridden via the virtualCatalogProviderOrder setting.
 */
function getDefaultProviderPriority(providerId: string): number {
  // Default priorities: higher number = higher priority (tried first)
  const defaults: Record<string, number> = {
    kiro: 100,
    github: 90,
    antigravity: 80,
    geminiCli: 70,
    claude: 60,
    cursor: 50,
    cline: 40,
    codex: 30,
    kilocode: 20,
  };
  return defaults[providerId] ?? 10;
}

function getProviderPriorityFromOrder(providerId: string, order: string[]): number {
  const index = order.indexOf(providerId);
  if (index === -1) return 0;
  // First in list = highest priority
  return (order.length - index) * 10;
}

// ──────────────────────────────────────────────────────────
// Core: Scan all providers and collect models
// ──────────────────────────────────────────────────────────

async function collectAllProviderModels(): Promise<ProviderModelEntry[]> {
  const { aliasToProviderId, providerIdToAlias } = buildAliasMaps();
  const entries: ProviderModelEntry[] = [];

  // Get active connections
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter((c: Record<string, unknown>) => c.isActive !== false);
  } catch {
    return entries;
  }

  const activeProviders = new Set<string>();
  const connectionsByProvider = new Map<string, Array<Record<string, unknown>>>();

  for (const conn of connections) {
    const providerId = conn.provider as string;
    const alias = providerIdToAlias[providerId] || providerId;
    activeProviders.add(alias);
    activeProviders.add(providerId);

    const existing = connectionsByProvider.get(providerId) || [];
    existing.push(conn);
    connectionsByProvider.set(providerId, existing);
    if (alias !== providerId) {
      const existingAlias = connectionsByProvider.get(alias) || [];
      existingAlias.push(conn);
      connectionsByProvider.set(alias, existingAlias);
    }
  }

  const getConns = (key: string) => connectionsByProvider.get(key) || [];

  // Get provider nodes for custom prefixes
  let providerNodes: Array<Record<string, unknown>> = [];
  try {
    providerNodes = await getProviderNodes();
  } catch {
    /* empty */
  }
  const providerIdToPrefix: Record<string, string> = {};
  for (const node of providerNodes) {
    if (node.prefix) {
      providerIdToPrefix[node.id as string] = node.prefix as string;
    }
  }

  // 1. Built-in provider models
  for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
    const providerId = aliasToProviderId[alias] || alias;
    if (!activeProviders.has(alias) && !activeProviders.has(providerId)) continue;

    for (const model of providerModels) {
      if (providerId === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(model.id)) continue;
      if (providerId === "openrouter" && !ALLOWED_OPENROUTER_MODELS.has(model.id)) continue;
      if (!hasEligibleConnectionForModel(getConns(providerId), model.id)) continue;

      const isAllowedExclusively = providerId === "nvidia" || providerId === "openrouter";
      if (!isAllowedExclusively && getModelIsHidden(providerId, model.id)) continue;

      entries.push({
        prefixedId: `${alias}/${model.id}`,
        rootId: model.id,
        providerId,
        alias,
        type: "chat",
        contextLength: model.contextLength,
        supportsVision: model.supportsVision,
      });
    }
  }

  // 2. Synced available models
  try {
    const syncedModelsByProvider = await getAllSyncedAvailableModels();
    for (const [providerId, syncedModels] of Object.entries(syncedModelsByProvider)) {
      if (!Array.isArray(syncedModels) || syncedModels.length === 0) continue;
      if (providerId === "reka") continue;

      const prefix = providerIdToPrefix[providerId];
      const alias = prefix || providerIdToAlias[providerId] || providerId;

      if (!activeProviders.has(alias) && !activeProviders.has(providerId)) continue;

      for (const sm of syncedModels) {
        if (providerId === "openrouter" && !ALLOWED_OPENROUTER_MODELS.has(sm.id)) {
          continue;
        }
        if (providerId === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(sm.id)) {
          continue;
        }
        if (!hasEligibleConnectionForModel(getConns(providerId), sm.id)) continue;

        const isAllowedExclusively = providerId === "nvidia" || providerId === "openrouter";
        if (!isAllowedExclusively && getModelIsHidden(providerId, sm.id)) continue;

        const endpoints = Array.isArray(sm.supportedEndpoints) ? sm.supportedEndpoints : ["chat"];
        let modelType: ProviderModelEntry["type"] = "chat";
        if (endpoints.includes("embeddings")) modelType = "embedding";
        else if (endpoints.includes("rerank")) modelType = "rerank";
        else if (endpoints.includes("images")) modelType = "image";
        else if (endpoints.includes("audio")) modelType = "other";

        // Skip if already added
        const prefixedId = `${alias}/${sm.id}`;
        if (entries.some((e) => e.prefixedId === prefixedId)) continue;

        entries.push({
          prefixedId,
          rootId: sm.id,
          providerId,
          alias,
          type: modelType,
          contextLength: sm.inputTokenLimit,
        });
      }
    }
  } catch {
    /* synced models not available */
  }

  // 3. Custom models
  try {
    const customModelsMap = (await getAllCustomModels()) as Record<string, unknown>;
    for (const [providerId, rawModels] of Object.entries(customModelsMap)) {
      if (providerId === "gemini" || providerId === "reka") continue;
      const models = Array.isArray(rawModels) ? rawModels : [];

      const prefix = providerIdToPrefix[providerId];
      const alias = prefix || providerIdToAlias[providerId] || providerId;

      if (!activeProviders.has(alias) && !activeProviders.has(providerId)) continue;

      for (const model of models) {
        if (!model || typeof model !== "object") continue;
        const modelId = (model as Record<string, unknown>).id as string;
        if (!modelId) continue;
        if (providerId === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(modelId)) continue;
        if (providerId === "openrouter" && !ALLOWED_OPENROUTER_MODELS.has(modelId)) continue;
        if (!hasEligibleConnectionForModel(getConns(providerId), modelId)) continue;

        const isAllowedExclusively = providerId === "nvidia" || providerId === "openrouter";
        if (!isAllowedExclusively && (model as Record<string, unknown>).isHidden === true) continue;

        const prefixedId = `${alias}/${modelId}`;
        if (entries.some((e) => e.prefixedId === prefixedId)) continue;

        entries.push({
          prefixedId,
          rootId: modelId,
          providerId,
          alias,
          type: "chat",
          contextLength: (model as Record<string, unknown>).inputTokenLimit as number,
        });
      }
    }
  } catch {
    /* custom models not available */
  }

  return entries;
}

// ──────────────────────────────────────────────────────────
// Core: Generate or update virtual catalog
// ──────────────────────────────────────────────────────────

export async function generateVirtualCatalog(): Promise<VirtualCatalogResult> {
  const result: VirtualCatalogResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    entries: [],
    errors: [],
    warnings: [],
  };

  // Get settings for provider ordering
  let settings: Record<string, unknown> = {};
  try {
    settings = await getSettings();
  } catch {
    /* use defaults */
  }

  const providerOrder = Array.isArray(settings.virtualCatalogProviderOrder)
    ? (settings.virtualCatalogProviderOrder as string[])
    : [];

  // 1. Collect all models from active providers
  const allModels = await collectAllProviderModels();

  // Warn if no models were discovered (most likely no connections)
  if (allModels.length === 0) {
    let connections: Array<Record<string, unknown>> = [];
    try {
      connections = await getProviderConnections();
    } catch {
      /* ignore */
    }
    const activeCount = connections.filter((c) => c.isActive !== false).length;

    if (connections.length === 0) {
      result.warnings.push(
        "No provider connections found. Add provider connections in the OmniRoute dashboard before generating the catalog."
      );
    } else if (activeCount === 0) {
      result.warnings.push(
        `Found ${connections.length} provider connection(s) but none are active. Enable at least one connection before generating the catalog.`
      );
    } else {
      result.warnings.push(
        `Found ${activeCount} active connection(s) but no eligible models were discovered. Check that your connections have valid API keys and are not excluding all models.`
      );
    }
  }

  // 2. Group by root model ID (only chat models for now)
  const chatModels = allModels.filter((m) => m.type === "chat");
  const grouped = new Map<string, ProviderModelEntry[]>();
  for (const model of chatModels) {
    const canonicalId = getCanonicalRootId(model.rootId);
    const existing = grouped.get(canonicalId) || [];
    existing.push(model);
    grouped.set(canonicalId, existing);
  }

  if (chatModels.length > 0 && grouped.size === 0) {
    result.warnings.push(
      "Models were found but none are chat models. Only chat models are included in the virtual catalog."
    );
  }

  // 3. Clean up old virtual catalog combos + mappings
  const existingCombos = await getCombos();
  const virtualCombos = existingCombos.filter((c: Record<string, unknown>) =>
    (c.tags as string[] | undefined)?.includes(VIRTUAL_CATALOG_TAG)
  );
  // Build a set of non-virtual combo names to avoid collisions
  const nonVirtualComboNames = new Set(
    existingCombos
      .filter(
        (c: Record<string, unknown>) =>
          !(c.tags as string[] | undefined)?.includes(VIRTUAL_CATALOG_TAG)
      )
      .map((c: Record<string, unknown>) => c.name as string)
      .filter(Boolean)
  );

  const existingMappings = await getModelComboMappings();
  const virtualMappings = existingMappings.filter((m) => m.description === VIRTUAL_CATALOG_TAG);

  // Delete old virtual catalog entries
  for (const combo of virtualCombos) {
    try {
      await deleteCombo(combo.id as string);
      result.deleted++;
    } catch (err) {
      result.errors.push(
        `Failed to delete old combo ${combo.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  for (const mapping of virtualMappings) {
    try {
      await deleteModelComboMapping(mapping.id);
    } catch {
      /* ignore cleanup errors */
    }
  }

  // 4. Create new combos + mappings for each grouped model
  for (const [rootId, variants] of grouped) {
    // Consolidate all chat models to expose them prefix-free under the virtual catalog.
    const uniqueProviders = new Set(variants.map((v) => v.providerId));

    // Sanitize the root ID for use as a combo name (handles slashes, special chars)
    const comboName = sanitizeComboName(rootId);
    if (!comboName) {
      result.errors.push(`Cannot create combo for "${rootId}": name is empty after sanitization`);
      continue;
    }

    // Skip if a non-virtual combo with this name already exists
    if (nonVirtualComboNames.has(comboName)) {
      result.warnings.push(
        `Skipped "${comboName}": a user-created combo with this name already exists. Rename or delete it to include this model in the virtual catalog.`
      );
      continue;
    }

    // Sort by provider priority (highest first), then by version (latest first)
    const sorted = variants.sort((a, b) => {
      const priorityA =
        providerOrder.length > 0
          ? getProviderPriorityFromOrder(a.providerId, providerOrder)
          : getDefaultProviderPriority(a.providerId);
      const priorityB =
        providerOrder.length > 0
          ? getProviderPriorityFromOrder(b.providerId, providerOrder)
          : getDefaultProviderPriority(b.providerId);

      if (priorityA !== priorityB) {
        return priorityB - priorityA;
      }

      return compareVersions(b.rootId, a.rootId);
    });

    try {
      // Create combo with priority strategy
      const combo = await createCombo({
        name: comboName,
        strategy: "priority",
        isHidden: true, // Hidden from raw catalog — only shown via virtual catalog
        isActive: true,
        tags: [VIRTUAL_CATALOG_TAG],
        models: sorted.map((v, index) => ({
          kind: "model",
          model: v.prefixedId,
          providerId: v.alias,
          weight: Math.max(0, 100 - index * 10),
        })),
      });

      // Create model-combo mapping for the sanitized name
      await createModelComboMapping({
        pattern: comboName,
        comboId: combo.id as string,
        priority: 100,
        enabled: true,
        description: VIRTUAL_CATALOG_TAG,
      });

      // If the sanitized name differs from rootId, also map the original
      // so requests using the raw model ID still route correctly
      if (comboName !== rootId) {
        try {
          await createModelComboMapping({
            pattern: rootId,
            comboId: combo.id as string,
            priority: 100,
            enabled: true,
            description: VIRTUAL_CATALOG_TAG,
          });
        } catch {
          /* non-critical: sanitized name mapping is enough */
        }
      }

      // Map all individual raw variant model IDs in this group to the same combo
      // so requests using specific version names still route correctly
      const uniqueRawIds = new Set(variants.map((v) => v.rootId));
      for (const rawId of uniqueRawIds) {
        if (rawId !== rootId && rawId !== comboName) {
          try {
            await createModelComboMapping({
              pattern: rawId,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {
            /* ignore duplicate or error */
          }
        }
      }

      // Explicitly map all known allowed names (including inactive provider variants)
      // for our forced consolidation models to ensure client request compatibility.
      if (rootId === "gpt-oss-120b") {
        const extraPatterns = ["openai/gpt-oss-120b:free", "openai/gpt-oss-120b", "gpt-oss-120b"];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "gpt-oss-20b") {
        const extraPatterns = ["openai/gpt-oss-20b:free", "openai/gpt-oss-20b", "gpt-oss-20b"];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "gpt-5-5-high") {
        const extraPatterns = [
          "gpt-5-5-high",
          "gpt-5.5-high",
          "gpt-5-5-xhigh",
          "gpt-5.5-xhigh",
          "openai/gpt-5.5-high",
          "openai/gpt-5-5-high",
        ];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "gpt-5-4-high") {
        const extraPatterns = [
          "gpt-5-4-high",
          "gpt-5.4-high",
          "gpt-5-4-xhigh",
          "gpt-5.4-xhigh",
          "openai/gpt-5.4-high",
          "openai/gpt-5-4-high",
        ];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "kimi-k2") {
        const extraPatterns = [
          "kimi-k2",
          "kimi-k2.6",
          "kimi-k2-6",
          "moonshotai/kimi-k2.6:free",
          "moonshotai/kimi-k2.6",
        ];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "minimax-m3") {
        const extraPatterns = [
          "minimax-m3",
          "minimax-m2",
          "minimax-m2.1",
          "minimax-m2.5",
          "minimax-m2.7",
          "minimax/minimax-m2.5:free",
          "minimaxai/minimax-m2.7",
        ];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "glm-5") {
        const extraPatterns = ["glm-5", "glm-5.1", "z-ai/glm-5.1"];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "claude-sonnet-4-6") {
        const extraPatterns = [
          "claude-sonnet-4-6",
          "claude-sonnet-4.6",
          "claude-sonnet-4.5",
          "claude-sonnet-4.0",
          "claude-sonnet-4-6-thinking",
          "claude-sonnet-4.6-thinking",
        ];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }
      if (rootId === "claude-opus-4-7") {
        const extraPatterns = [
          "claude-opus-4-7",
          "claude-opus-4.7",
          "claude-opus-4-6",
          "claude-opus-4.6",
          "claude-opus-4.5",
          "claude-opus-4-5-20251101",
          "claude-opus-4-7-thinking",
          "claude-opus-4.7-thinking",
          "claude-opus-4-6-thinking",
          "claude-opus-4.6-thinking",
        ];
        for (const p of extraPatterns) {
          try {
            await createModelComboMapping({
              pattern: p,
              comboId: combo.id as string,
              priority: 100,
              enabled: true,
              description: VIRTUAL_CATALOG_TAG,
            });
          } catch {}
        }
      }

      result.created++;
      result.entries.push({
        id: comboName,
        comboId: combo.id as string,
        providers: sorted.map((v) => ({
          providerId: v.providerId,
          alias: v.alias,
          prefixedId: v.prefixedId,
        })),
        type: "chat",
        isVisible: true,
      });
    } catch (err) {
      result.errors.push(
        `Failed to create virtual combo for ${comboName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 5. Enable the setting only if we actually created entries
  if (result.created > 0 && !settings.virtualCatalogEnabled) {
    try {
      const { updateSettings } = await import("@/lib/db/settings");
      await updateSettings({ virtualCatalogEnabled: true });
    } catch {
      /* non-critical */
    }
  } else if (result.created === 0 && result.warnings.length === 0) {
    result.warnings.push("No virtual catalog entries were created. The catalog was not enabled.");
  }

  return result;
}

// ──────────────────────────────────────────────────────────
// Query: Get current virtual catalog state
// ──────────────────────────────────────────────────────────

export async function getVirtualCatalogEntries(): Promise<VirtualCatalogEntry[]> {
  const existingCombos = await getCombos();
  const virtualCombos = existingCombos.filter((c: Record<string, unknown>) =>
    (c.tags as string[] | undefined)?.includes(VIRTUAL_CATALOG_TAG)
  );

  return virtualCombos.map((combo: Record<string, unknown>) => {
    const models = Array.isArray(combo.models) ? combo.models : [];
    return {
      id: combo.name as string,
      comboId: combo.id as string,
      providers: models
        .filter(
          (m: unknown) =>
            m && typeof m === "object" && (m as Record<string, unknown>).kind === "model"
        )
        .map((m: unknown) => {
          const step = m as Record<string, unknown>;
          const modelStr = (step.model as string) || "";
          const slashIdx = modelStr.indexOf("/");
          const alias = slashIdx > 0 ? modelStr.slice(0, slashIdx) : "";
          return {
            providerId: (step.providerId as string) || alias,
            alias,
            prefixedId: modelStr,
          };
        }),
      type: "chat",
      isVisible: combo.isActive !== false && combo.isHidden !== true,
    };
  });
}
