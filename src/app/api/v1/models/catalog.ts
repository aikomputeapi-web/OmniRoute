import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { AI_PROVIDERS, NOAUTH_PROVIDERS } from "@/shared/constants/providers";
import {
  getProviderConnections,
  getCombos,
  getAllCustomModels,
  getSettings,
  getProviderNodes,
  getModelIsHidden,
  getModelAliases,
} from "@/lib/localDb";
import { getAllEmbeddingModels } from "@omniroute/open-sse/config/embeddingRegistry";
import { getAllImageModels } from "@omniroute/open-sse/config/imageRegistry";
import { getAllRerankModels } from "@omniroute/open-sse/config/rerankRegistry";
import { getAllAudioModels } from "@omniroute/open-sse/config/audioRegistry";
import { getAllModerationModels } from "@omniroute/open-sse/config/moderationRegistry";
import { getAllVideoModels } from "@omniroute/open-sse/config/videoRegistry";
import { getAllMusicModels } from "@omniroute/open-sse/config/musicRegistry";
import { REGISTRY } from "@omniroute/open-sse/config/providerRegistry";
import { CODEX_NATIVE_UNPREFIXED_MODELS } from "@omniroute/open-sse/services/model";
import { resolveNestedComboTargets } from "@omniroute/open-sse/services/combo";
import { getAllSyncedAvailableModels, type SyncedAvailableModel } from "@/lib/db/models";
import { getCompatibleFallbackModels } from "@/lib/providers/managedAvailableModels";
import { getOpenRouterCatalog } from "@/lib/catalog/openrouterCatalog";
import {
  getCanonicalTextGenerationModelId,
  isTextGenerationCatalogModel,
  sanitizeTextGenerationCatalogId,
} from "@/lib/catalog/textGenerationCatalogPolicy";
import { hasEligibleConnectionForModel } from "@/domain/connectionModelRules";
import {
  INTERNAL_PROXY_ERROR,
  enrichCatalogModelEntry,
  getCanonicalModelMetadata,
  getCatalogDiagnosticsHeaders,
} from "@/lib/modelMetadataRegistry";
import { getSyncedCapability } from "@/lib/modelsDevSync";
import { getModelSpec } from "@/shared/constants/modelSpecs";
import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { isModelCatalogNamesEnabled } from "@/shared/utils/featureFlags";
import { parseModel } from "@omniroute/open-sse/services/model";
import { getTokenLimit } from "@omniroute/open-sse/services/contextManager";
import { extractApiKey } from "@/sse/services/auth";
import type { ComboModelStep } from "@/lib/combos/steps";
import {
  type CustomModelEntry,
  type ComboCatalogTarget,
  type ComboTargetCatalogMetadata,
  isPositiveFiniteNumber,
  parseJsonStringArray,
  intersectStringArrays,
  minKnownNumber,
  maybeOmitCatalogModelName,
} from "./catalogHelpers";
import {
  qualifyOpenRouterModelId,
  normalizeOpenRouterModalities,
  getOpenRouterModelType,
  isOpenRouterFreeModel,
  getOpenRouterDisplayName,
} from "./catalogOpenrouter";
import { getVisionCapabilityFields, getCustomVisionCapabilityFields } from "./catalogVision";
import { FALLBACK_ALIAS_TO_PROVIDER, buildAliasMaps } from "./catalogProviderMaps";
import { getModelCatalogAuthRejection, isCodexModelCatalogClient } from "./catalogRequest";

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
  "google/gemma-4-31b-it",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "mistralai/devstral-2-123b-instruct-2512",
  "stepfun-ai/step-3.5-flash",
  "nvidia/nemotron-3-super-120b-a12b",
  "deepseek-ai/deepseek-v4-pro",
]);

const VISION_MODEL_KEYWORDS = [
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
  "llava",
  "bakllava",
  "pixtral",
  "mistral-pixtral",
  "qwen-vl",
  "qvq",
  "glm-4.6v",
  "glm-4.5v",
  "vision",
  "multimodal",
  "kimi",
];
export function isVisionModelId(modelId: string): boolean {
  const normalized = String(modelId || "").toLowerCase();
  if (!normalized) return false;
  return VISION_MODEL_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Build unified OpenAI-compatible model catalog response.
 * Reused by `/api/v1/models` and `/api/v1` to avoid semantic drift (T09).
 */
export async function getUnifiedModelsResponse(
  request: Request,
  corsHeaders: Record<string, string> = {}
) {
  const diagnosticHeaders = getCatalogDiagnosticsHeaders({ request });
  try {
    let settings: Record<string, any> = {};
    try {
      settings = await getSettings();
    } catch {}

    const authRejection = await getModelCatalogAuthRejection(request, settings, {
      ...corsHeaders,
      ...diagnosticHeaders,
    });
    if (authRejection) return authRejection;

    const { aliasToProviderId, providerIdToAlias } = buildAliasMaps();
    const resolveCanonicalProviderId = (aliasOrProviderId: string, fallbackProviderId?: string) =>
      aliasToProviderId[aliasOrProviderId] ||
      (fallbackProviderId ? aliasToProviderId[fallbackProviderId] : undefined) ||
      FALLBACK_ALIAS_TO_PROVIDER[aliasOrProviderId] ||
      fallbackProviderId ||
      aliasOrProviderId;

    // Issue #96: Allow blocking specific providers from the models list
    const blockedProviders: Set<string> = new Set(
      Array.isArray(settings.blockedProviders) ? settings.blockedProviders : []
    );

    // Get active provider connections
    let connections = [];
    let totalConnectionCount = 0; // Track if DB has ANY connections (even disabled)
    try {
      connections = await getProviderConnections();
      totalConnectionCount = connections.length;
      // Filter to only active connections
      connections = connections.filter((c) => c.isActive !== false);
    } catch (e) {
      // If database not available, show no provider models (safe default)
      console.log("[catalog] Could not fetch providers:", e);
    }

    // Get provider nodes (for compatible providers with custom prefixes)
    let providerNodes = [];
    try {
      providerNodes = await getProviderNodes();
    } catch (e) {
      console.log("Could not fetch provider nodes");
    }

    // Build map of provider node ID to prefix and type for compatible providers
    const providerIdToPrefix: Record<string, string> = {};
    const nodeIdToProviderType: Record<string, string> = {};
    for (const node of providerNodes) {
      if (node.prefix) {
        providerIdToPrefix[node.id] = node.prefix;
      }
      if (node.type) {
        nodeIdToProviderType[node.id] = node.type;
      }
    }

    // Get combos
    let combos = [];
    try {
      combos = await getCombos();
    } catch (e) {
      console.log("Could not fetch combos");
    }

    // Build set of active provider aliases
    const activeAliases = new Set();
    const connectionsByProvider = new Map<string, typeof connections>();
    const registerConnectionKey = (
      key: string | null | undefined,
      connection: (typeof connections)[number]
    ) => {
      if (!key) return;
      const existing = connectionsByProvider.get(key) || [];
      existing.push(connection);
      connectionsByProvider.set(key, existing);
    };
    for (const conn of connections) {
      const alias = providerIdToAlias[conn.provider] || conn.provider;
      activeAliases.add(alias);
      activeAliases.add(conn.provider);
      registerConnectionKey(alias, conn);
      registerConnectionKey(conn.provider, conn);
    }

    // noAuth providers never create DB connection rows, so they are always active.
    // Add their IDs and aliases unconditionally so the catalog gate does not filter them. (#2798)
    for (const p of Object.values(NOAUTH_PROVIDERS)) {
      activeAliases.add(p.id);
      if ("alias" in p && typeof p.alias === "string") activeAliases.add(p.alias);
    }

    const getConnectionsForProvider = (...keys: Array<string | null | undefined>) => {
      const seen = new Set<string>();
      const collected: typeof connections = [];
      for (const key of keys) {
        if (!key) continue;
        for (const connection of connectionsByProvider.get(key) || []) {
          if (!connection?.id || seen.has(connection.id)) continue;
          seen.add(connection.id);
          collected.push(connection);
        }
      }
      return collected;
    };

    const providerSupportsModel = (providerKey: string, modelId: string) => {
      const providerId = aliasToProviderId[providerKey] || providerKey;
      const alias = providerIdToAlias[providerId] || providerKey;
      // noAuth providers have no connection rows — treat every model as eligible. (#2798)
      const isNoAuth = Object.values(NOAUTH_PROVIDERS).some(
        (p) => p.id === providerId || p.id === providerKey || ("alias" in p && p.alias === alias)
      );
      if (isNoAuth) return true;
      return hasEligibleConnectionForModel(
        getConnectionsForProvider(providerKey, providerId, alias),
        modelId
      );
    };

    const getRegistryModel = (providerId: string, modelId: string) => {
      const alias = providerIdToAlias[providerId] || PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const providerModels = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
      return providerModels.find((model) => model?.id === modelId) || null;
    };

    const prefixRoutesToProvider = (prefix: string, providerId: string) => {
      const parsed = parseModel(`${prefix}/__omniroute_probe__`);
      return parsed.provider === providerId;
    };

    const getProviderPrefixes = (providerId: string, rawProvider: string) => {
      const prefixes = new Set<string>([providerId, rawProvider, providerIdToAlias[providerId]]);
      for (const [alias, mappedProviderId] of Object.entries(aliasToProviderId)) {
        if (mappedProviderId === providerId) prefixes.add(alias);
      }
      return [...prefixes].filter(
        (prefix): prefix is string =>
          typeof prefix === "string" &&
          prefix.length > 0 &&
          prefixRoutesToProvider(prefix, providerId)
      );
    };

    const getComboTargetModelId = (target: ComboCatalogTarget) => {
      const rawProvider = typeof target.provider === "string" ? target.provider.trim() : "";
      const modelStr = typeof target.modelStr === "string" ? target.modelStr.trim() : "";
      if (!rawProvider || rawProvider === "unknown" || !modelStr) return null;

      const providerId = resolveCanonicalProviderId(rawProvider);
      if (!providerId || providerId === "unknown") return null;

      for (const prefix of getProviderPrefixes(providerId, rawProvider)) {
        const prefixWithSlash = `${prefix}/`;
        if (modelStr.startsWith(prefixWithSlash)) {
          const modelId = modelStr.slice(prefixWithSlash.length).trim();
          return modelId ? { providerId, modelId } : null;
        }
      }

      return { providerId, modelId: modelStr };
    };

    const getComboTargetCatalogMetadata = (
      target: ComboCatalogTarget
    ): ComboTargetCatalogMetadata | null => {
      const targetModel = getComboTargetModelId(target);
      if (!targetModel) return null;

      const canonical = getCanonicalModelMetadata({
        provider: targetModel.providerId,
        model: targetModel.modelId,
      });
      if (!canonical) return null;

      const source = canonical.metadata.source;
      if (!source.providerRegistry && !source.staticSpec && !source.syncedCapability) return null;

      const providerId = canonical.provider || targetModel.providerId;
      const modelId = canonical.model || targetModel.modelId;
      const synced = getSyncedCapability(providerId, modelId);
      const spec = getModelSpec(modelId);
      const registryModel = getRegistryModel(providerId, modelId);
      const syncedInputModalities = parseJsonStringArray(synced?.modalities_input);
      const syncedOutputModalities = parseJsonStringArray(synced?.modalities_output);

      const syncedContext = isPositiveFiniteNumber(synced?.limit_context)
        ? synced.limit_context
        : undefined;
      const registryContext = isPositiveFiniteNumber(registryModel?.contextLength)
        ? registryModel.contextLength
        : undefined;
      const specContext = isPositiveFiniteNumber(spec?.contextWindow)
        ? spec.contextWindow
        : undefined;
      const contextLength =
        syncedContext ??
        registryContext ??
        specContext ??
        (getTokenLimit(providerId, modelId) || undefined);
      const registryInputLimit = isPositiveFiniteNumber(registryModel?.maxInputTokens)
        ? registryModel.maxInputTokens
        : undefined;
      const syncedInputLimit = isPositiveFiniteNumber(synced?.limit_input)
        ? synced.limit_input
        : undefined;
      const maxInputTokens = registryInputLimit ?? syncedInputLimit ?? contextLength;
      const maxOutputTokens = isPositiveFiniteNumber(synced?.limit_output)
        ? synced.limit_output
        : isPositiveFiniteNumber(spec?.maxOutputTokens)
          ? spec.maxOutputTokens
          : undefined;

      const syncedVision =
        typeof synced?.attachment === "boolean"
          ? synced.attachment
          : syncedInputModalities.length > 0 || syncedOutputModalities.length > 0
            ? [...syncedInputModalities, ...syncedOutputModalities].some((entry) =>
                // eslint-disable-next-line no-restricted-syntax -- teknik string kontrolü, kullanıcı metni araması değil
                entry.toLowerCase().includes("image")
              )
            : undefined;
      const registryVision =
        typeof registryModel?.supportsVision === "boolean"
          ? registryModel.supportsVision
          : undefined;
      const specVision =
        typeof spec?.supportsVision === "boolean" ? spec.supportsVision : undefined;
      const knownVision = syncedVision ?? registryVision ?? specVision;

      const inputModalities =
        syncedInputModalities.length > 0
          ? syncedInputModalities
          : knownVision === true
            ? ["text", "image"]
            : undefined;
      const outputModalities =
        syncedOutputModalities.length > 0
          ? syncedOutputModalities
          : knownVision === true
            ? ["text"]
            : undefined;

      const capabilities: Record<string, boolean> = {};
      if (typeof synced?.tool_call === "boolean") {
        capabilities.tool_calling = synced.tool_call;
      } else if (typeof registryModel?.toolCalling === "boolean") {
        capabilities.tool_calling = registryModel.toolCalling;
      } else if (typeof spec?.supportsTools === "boolean") {
        capabilities.tool_calling = spec.supportsTools;
      }
      if (typeof synced?.reasoning === "boolean") {
        capabilities.reasoning = synced.reasoning;
      } else if (typeof registryModel?.supportsReasoning === "boolean") {
        capabilities.reasoning = registryModel.supportsReasoning;
      } else if (typeof spec?.supportsThinking === "boolean") {
        capabilities.reasoning = spec.supportsThinking;
      }
      if (typeof knownVision === "boolean") capabilities.vision = knownVision;
      if (typeof synced?.attachment === "boolean") capabilities.attachment = synced.attachment;
      if (typeof synced?.structured_output === "boolean") {
        capabilities.structured_output = synced.structured_output;
      }
      if (typeof synced?.temperature === "boolean") capabilities.temperature = synced.temperature;
      if (typeof synced?.reasoning === "boolean") {
        capabilities.thinking = synced.reasoning;
      } else if (typeof spec?.supportsThinking === "boolean") {
        capabilities.thinking = spec.supportsThinking;
      }

      return {
        ...(contextLength ? { contextLength } : {}),
        ...(maxInputTokens ? { maxInputTokens } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
        ...(outputModalities && outputModalities.length > 0 ? { outputModalities } : {}),
        capabilities,
      };
    };

    const buildComboCatalogMetadata = (
      combo: Parameters<typeof resolveNestedComboTargets>[0],
      allCombos: Parameters<typeof resolveNestedComboTargets>[1]
    ) => {
      const explicitContextLength = isPositiveFiniteNumber(combo.context_length)
        ? combo.context_length
        : undefined;

      const baseMetadata = explicitContextLength ? { context_length: explicitContextLength } : {};
      const targets = resolveNestedComboTargets(combo as any, allCombos) as ComboCatalogTarget[];
      if (targets.length === 0) return baseMetadata;

      const targetMetadata = targets.map((target) => getComboTargetCatalogMetadata(target));

      const knownMetadata = targetMetadata.filter(
        (metadata): metadata is ComboTargetCatalogMetadata => metadata !== null
      );
      if (knownMetadata.length === 0) return baseMetadata;
      const contextLength =
        explicitContextLength ??
        minKnownNumber(knownMetadata.map((metadata) => metadata.contextLength));
      const maxInputTokens = minKnownNumber(
        knownMetadata.map((metadata) => metadata.maxInputTokens)
      );
      const maxOutputTokens = minKnownNumber(
        knownMetadata.map((metadata) => metadata.maxOutputTokens)
      );

      const inputModalities = knownMetadata.every(
        (metadata) => Array.isArray(metadata.inputModalities) && metadata.inputModalities.length > 0
      )
        ? intersectStringArrays(knownMetadata.map((metadata) => metadata.inputModalities || []))
        : [];
      const outputModalities = knownMetadata.every(
        (metadata) =>
          Array.isArray(metadata.outputModalities) && metadata.outputModalities.length > 0
      )
        ? intersectStringArrays(knownMetadata.map((metadata) => metadata.outputModalities || []))
        : [];

      const capabilities: Record<string, boolean> = {};
      for (const key of [
        "tool_calling",
        "reasoning",
        "vision",
        "attachment",
        "structured_output",
        "temperature",
        "thinking",
      ]) {
        const values = knownMetadata.map((metadata) => metadata.capabilities[key]);
        if (values.every((value): value is boolean => typeof value === "boolean")) {
          const [first] = values;
          if (values.every((value) => value === first)) capabilities[key] = first;
        }
      }

      return {
        ...baseMetadata,
        ...(contextLength ? { context_length: contextLength } : {}),
        ...(maxInputTokens ? { max_input_tokens: maxInputTokens } : {}),
        ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
        ...(inputModalities.length > 0 ? { input_modalities: inputModalities } : {}),
        ...(outputModalities.length > 0 ? { output_modalities: outputModalities } : {}),
        ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      };
    };

    // Collect models from active providers (or all if none active)
    const models = [];
    const timestamp = Math.floor(Date.now() / 1000);

    // ── Virtual Catalog Mode ────────────────────────────────────────────────
    // When enabled, virtual catalog combos (tagged __virtual_catalog__) are
    // exposed as clean root-model entries (e.g. "claude-sonnet-4-6") instead
    // of being hidden. Provider-prefixed duplicates are removed later.
    const virtualCatalogEnabled = settings.virtualCatalogEnabled === true;
    const virtualCatalogBrand =
      typeof settings.virtualCatalogBrand === "string" && settings.virtualCatalogBrand.trim()
        ? settings.virtualCatalogBrand.trim()
        : "aikompute";
    const virtualCatalogTag = "__virtual_catalog__";
    const virtualCatalogRootIds = new Set<string>();
    // ────────────────────────────────────────────────────────────────────────

    // Add combos first (they appear at the top) — only active ones
    for (const combo of combos) {
      if (combo.isActive === false) continue;
      if (typeof combo.name !== "string" || combo.name.length === 0) continue;

      // Skip combos whose any underlying target model is hidden
      const comboTargets = resolveNestedComboTargets(
        combo as Parameters<typeof resolveNestedComboTargets>[0],
        combos as Parameters<typeof resolveNestedComboTargets>[1]
      ) as ComboCatalogTarget[];
      if (
        comboTargets.some((target) => {
          const resolved = getComboTargetModelId(target);
          return resolved ? getModelIsHidden(resolved.providerId, resolved.modelId) : false;
        })
      ) {
        continue;
      }

      // Virtual catalog combos: emit as clean root-model entries
      const isVirtualCatalogCombo =
        Array.isArray(combo.tags) && combo.tags.includes(virtualCatalogTag);

      if (isVirtualCatalogCombo) {
        if (!virtualCatalogEnabled) continue; // Skip if feature is off
        const comboMetadata = buildComboCatalogMetadata(combo, combos);
        virtualCatalogRootIds.add(combo.name);
        models.push({
          id: combo.name,
          object: "model",
          created: timestamp,
          owned_by: virtualCatalogBrand,
          permission: [],
          root: combo.name,
          parent: null,
          ...comboMetadata,
        });
        continue;
      }

      // Regular combos: skip hidden ones as before
      if (combo.isHidden === true) continue;

      const comboMetadata = buildComboCatalogMetadata(combo, combos);

      models.push({
        id: combo.name,
        object: "model",
        created: timestamp,
        owned_by: "combo",
        permission: [],
        root: combo.name,
        parent: null,
        ...comboMetadata,
      });
    }

    // Resolve synced available models (from auto-sync) — used to skip static
    // PROVIDER_MODELS entries for providers that have a live, API-fresh list.
    let syncedModelsByProvider: Record<string, SyncedAvailableModel[]> = {};
    try {
      syncedModelsByProvider = await getAllSyncedAvailableModels();
    } catch (e) {
      // DB unavailable — log and fall through; static models remain as defaults.
      console.log("[catalog] Could not fetch synced available models:", e);
    }
    const providersWithSyncedModels = new Set(
      Object.keys(syncedModelsByProvider).filter((pid) => {
        const models = syncedModelsByProvider[pid];
        return Array.isArray(models) && models.length > 0;
      })
    );

    // Add provider models (chat)
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = aliasToProviderId[alias] || alias;
      const canonicalProviderId = resolveCanonicalProviderId(alias, providerId);

      // Skip blocked providers (Issue #96)
      if (blockedProviders.has(alias) || blockedProviders.has(canonicalProviderId)) continue;

      // Only include models from providers with active connections
      if (!activeAliases.has(alias) && !activeAliases.has(canonicalProviderId)) {
        continue;
      }

      // Skip static models for providers that have synced available models
      // (auto-sync provides the authoritative, up-to-date list from the API).
      if (providersWithSyncedModels.has(canonicalProviderId)) continue;

      for (const model of providerModels) {
        if (canonicalProviderId === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(model.id)) {
          continue;
        }
        if (!providerSupportsModel(canonicalProviderId, model.id)) continue;
        const aliasId = `${alias}/${model.id}`;
        if (getModelIsHidden(canonicalProviderId, model.id)) continue;

        const visionFields =
          getVisionCapabilityFields(aliasId) || getVisionCapabilityFields(model.id);

        models.push({
          id: aliasId,
          object: "model",
          created: timestamp,
          owned_by: canonicalProviderId,
          permission: [],
          root: model.id,
          parent: null,
          ...(visionFields || {}),
        });

        // Add provider-id prefix in addition to short alias (ex: kiro/model + kr/model).
        // This improves compatibility for clients that expect full provider names.
        if (
          canonicalProviderId !== alias &&
          prefixRoutesToProvider(canonicalProviderId, canonicalProviderId)
        ) {
          const providerIdModel = `${canonicalProviderId}/${model.id}`;
          const providerVisionFields =
            getVisionCapabilityFields(providerIdModel) || getVisionCapabilityFields(model.id);
          models.push({
            id: providerIdModel,
            object: "model",
            created: timestamp,
            owned_by: canonicalProviderId,
            permission: [],
            root: model.id,
            parent: aliasId,
            ...(providerVisionFields || {}),
          });
        }
      }
    }

    for (const modelId of CODEX_NATIVE_UNPREFIXED_MODELS) {
      if (!providerSupportsModel("codex", modelId)) continue;
      if (getModelIsHidden("codex", modelId)) continue;

      const alias = providerIdToAlias.codex || "cx";
      const aliasId = `${alias}/${modelId}`;
      const providerIdModel = `codex/${modelId}`;
      const entries = [
        { id: aliasId, parent: null },
        { id: providerIdModel, parent: aliasId },
        { id: modelId, parent: providerIdModel },
      ];

      for (const entry of entries) {
        if (models.some((existingModel) => existingModel.id === entry.id)) continue;
        models.push({
          id: entry.id,
          object: "model",
          created: timestamp,
          owned_by: "codex",
          permission: [],
          root: modelId,
          parent: entry.parent,
        });
      }
    }

    try {
      // Data already loaded above into syncedModelsByProvider; the try block
      // here protects the for-loop / model processing from unexpected errors.
      for (const [providerId, syncedModels] of Object.entries(syncedModelsByProvider)) {
        if (!Array.isArray(syncedModels) || syncedModels.length === 0) continue;
        if (blockedProviders.has(providerId)) continue;
        if (providerId === "reka") continue;

        const prefix = providerIdToPrefix[providerId];
        const alias = prefix || providerIdToAlias[providerId] || providerId;
        const canonicalProviderId = resolveCanonicalProviderId(alias, providerId);
        const parentProviderType = nodeIdToProviderType[providerId];

        if (
          !activeAliases.has(alias) &&
          !activeAliases.has(canonicalProviderId) &&
          !activeAliases.has(providerId) &&
          !(parentProviderType && activeAliases.has(parentProviderType))
        ) {
          continue;
        }

        for (const sm of syncedModels) {
          if (providerId === "openrouter" && !ALLOWED_OPENROUTER_MODELS.has(sm.id)) {
            continue;
          }
          if (providerId === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(sm.id)) {
            continue;
          }
          if (!providerSupportsModel(canonicalProviderId, sm.id)) continue;

          const isAllowedExclusively = providerId === "nvidia" || providerId === "openrouter";
          if (!isAllowedExclusively && getModelIsHidden(providerId, sm.id)) continue;

          // Strip modelIdPrefix (e.g. "accounts/fireworks/models/") from display ID
          // so synced model IDs match the short IDs from static registry.
          const registryEntry = REGISTRY[providerId];
          const displayModelId =
            registryEntry?.modelIdPrefix && sm.id.startsWith(registryEntry.modelIdPrefix)
              ? sm.id.slice(registryEntry.modelIdPrefix.length)
              : sm.id;

          const aliasId = `${alias}/${displayModelId}`;
          const endpoints = Array.isArray(sm.supportedEndpoints) ? sm.supportedEndpoints : ["chat"];
          const apiFormat = typeof sm.apiFormat === "string" ? sm.apiFormat : "chat-completions";
          let modelType: string | undefined;
          if (endpoints.includes("embeddings")) modelType = "embedding";
          else if (endpoints.includes("rerank")) modelType = "rerank";
          else if (endpoints.includes("images")) modelType = "image";
          else if (endpoints.includes("audio")) modelType = "audio";
          const syncedFields = {
            ...(modelType ? { type: modelType } : {}),
            ...(apiFormat !== "chat-completions" ? { api_format: apiFormat } : {}),
            ...(modelType === "audio" ? { subtype: "transcription" } : {}),
            ...(sm.inputTokenLimit ? { context_length: sm.inputTokenLimit } : {}),
            ...(typeof sm.outputTokenLimit === "number"
              ? { max_output_tokens: sm.outputTokenLimit }
              : {}),
            ...(endpoints.length > 1 || !endpoints.includes("chat")
              ? { supported_endpoints: endpoints }
              : {}),
          };

          const existingAliasModel = models.find((model) => model.id === aliasId);
          if (existingAliasModel) {
            Object.assign(existingAliasModel, syncedFields);
            continue;
          }

          models.push({
            id: aliasId,
            object: "model",
            created: timestamp,
            owned_by: canonicalProviderId,
            permission: [],
            root: sm.id,
            parent: null,
            ...syncedFields,
          });

          if (modelType === "audio") {
            models.push({
              id: aliasId,
              object: "model",
              created: timestamp,
              owned_by: canonicalProviderId,
              permission: [],
              root: sm.id,
              parent: null,
              type: "audio",
              subtype: "speech",
              ...(sm.inputTokenLimit ? { context_length: sm.inputTokenLimit } : {}),
              ...(typeof sm.outputTokenLimit === "number"
                ? { max_output_tokens: sm.outputTokenLimit }
                : {}),
              ...(endpoints.length > 1 || !endpoints.includes("chat")
                ? { supported_endpoints: endpoints }
                : {}),
            });
          }

          if (canonicalProviderId !== alias && !prefix) {
            const providerPrefixedId = `${canonicalProviderId}/${displayModelId}`;
            if (!models.some((model) => model.id === providerPrefixedId)) {
              models.push({
                id: providerPrefixedId,
                object: "model",
                created: timestamp,
                owned_by: canonicalProviderId,
                permission: [],
                root: sm.id,
                parent: aliasId,
                ...syncedFields,
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("[catalog] Error fetching synced provider models:", err);
    }

    if (
      activeAliases.has("openrouter") &&
      !blockedProviders.has("openrouter") &&
      !providersWithSyncedModels.has("openrouter")
    ) {
      try {
        const openRouterCatalog = await getOpenRouterCatalog();
        for (const openRouterModel of openRouterCatalog.data || []) {
          if (!openRouterModel?.id || typeof openRouterModel.id !== "string") continue;
          const qualifiedId = qualifyOpenRouterModelId(openRouterModel.id);
          if (models.some((existingModel: any) => existingModel?.id === qualifiedId)) continue;

          const inputModalities = normalizeOpenRouterModalities(
            openRouterModel.architecture?.input_modalities
          );
          const outputModalities = normalizeOpenRouterModalities(
            openRouterModel.architecture?.output_modalities
          );
          const modelType = getOpenRouterModelType(inputModalities, outputModalities);
          const isFree = isOpenRouterFreeModel(openRouterModel);
          const supportedParameters = Array.isArray(openRouterModel.supported_parameters)
            ? openRouterModel.supported_parameters
            : [];
          const capabilities: Record<string, boolean> = {};
          if (inputModalities.includes("image")) capabilities.vision = true;
          if (
            supportedParameters.includes("reasoning") ||
            supportedParameters.includes("include_reasoning")
          ) {
            capabilities.reasoning = true;
          }
          if (supportedParameters.includes("tools")) capabilities.tool_calling = true;
          if (
            supportedParameters.includes("structured_outputs") ||
            supportedParameters.includes("response_format")
          ) {
            capabilities.structured_output = true;
          }

          models.push({
            id: qualifiedId,
            object: "model",
            created: openRouterModel.created || timestamp,
            owned_by: "openrouter",
            permission: [],
            root: openRouterModel.id,
            parent: null,
            name: getOpenRouterDisplayName(openRouterModel),
            type: modelType,
            ...(isFree ? { free: true } : {}),
            ...(typeof openRouterModel.context_length === "number"
              ? { context_length: openRouterModel.context_length }
              : {}),
            ...(typeof openRouterModel.top_provider?.max_completion_tokens === "number"
              ? { max_output_tokens: openRouterModel.top_provider.max_completion_tokens }
              : {}),
            ...(inputModalities.length > 0 ? { input_modalities: inputModalities } : {}),
            ...(outputModalities.length > 0 ? { output_modalities: outputModalities } : {}),
            ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
          });
        }
      } catch (err) {
        console.error("[catalog] Error loading OpenRouter catalog:", err);
      }
    }

    // Helper: check if a provider is active (by provider id or alias)
    const isProviderActive = (provider: string) => {
      if (activeAliases.size === 0) return false; // No active connections = show nothing
      const alias = providerIdToAlias[provider] || provider;
      const canonicalProviderId = resolveCanonicalProviderId(alias, provider);

      // FIX #1752: Ensure blocked providers are not returned for non-chat models
      if (
        blockedProviders.has(alias) ||
        blockedProviders.has(canonicalProviderId) ||
        blockedProviders.has(provider)
      ) {
        return false;
      }

      return (
        activeAliases.has(alias) ||
        activeAliases.has(provider) ||
        activeAliases.has(canonicalProviderId)
      );
    };

    const hasEquivalentSpecialtyModel = (
      providerId: string,
      rawModelId: string,
      type: string,
      scopedModelId: string
    ) =>
      models.some((model: any) => {
        if (model?.id === scopedModelId) return true;
        if (model?.owned_by !== providerId || model?.type !== type) return false;
        const existingRoot =
          typeof model?.root === "string"
            ? model.root
            : typeof model?.id === "string"
              ? model.id.split("/").pop()
              : null;
        return existingRoot === rawModelId;
      });

    // Add embedding models (filtered by active providers)
    for (const embModel of getAllEmbeddingModels()) {
      if (!isProviderActive(embModel.provider)) continue;
      const rawModelId = embModel.id.split("/").pop() || embModel.id;
      if (embModel.provider === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(rawModelId)) continue;
      if (
        embModel.provider === "openrouter" &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId) &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId + ":free")
      )
        continue;
      if (!providerSupportsModel(embModel.provider, rawModelId)) continue;
      if (getModelIsHidden(embModel.provider, rawModelId)) continue;
      if (hasEquivalentSpecialtyModel(embModel.provider, rawModelId, "embedding", embModel.id)) {
        continue;
      }
      models.push({
        id: embModel.id,
        object: "model",
        created: timestamp,
        owned_by: embModel.provider,
        root: rawModelId,
        type: "embedding",
        dimensions: embModel.dimensions,
      });
    }

    // Add image models (filtered by active providers)
    for (const imgModel of getAllImageModels()) {
      if (!isProviderActive(imgModel.provider)) continue;
      const rawModelId = imgModel.id.split("/").pop() || imgModel.id;
      if (imgModel.provider === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(rawModelId)) continue;
      if (
        imgModel.provider === "openrouter" &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId) &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId + ":free")
      )
        continue;
      if (!providerSupportsModel(imgModel.provider, rawModelId)) continue;
      if (getModelIsHidden(imgModel.provider, rawModelId)) continue;
      models.push({
        id: imgModel.id,
        object: "model",
        created: timestamp,
        owned_by: imgModel.provider,
        type: "image",
        supported_sizes: imgModel.supportedSizes,
        input_modalities: imgModel.inputModalities || ["text"],
        output_modalities: ["image"],
        ...(imgModel.description ? { description: imgModel.description } : {}),
      });
    }

    // Add rerank models (filtered by active providers)
    for (const rerankModel of getAllRerankModels()) {
      if (!isProviderActive(rerankModel.provider)) continue;
      const rawModelId = rerankModel.id.split("/").pop() || rerankModel.id;
      if (rerankModel.provider === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(rawModelId)) continue;
      if (
        rerankModel.provider === "openrouter" &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId) &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId + ":free")
      )
        continue;
      if (!providerSupportsModel(rerankModel.provider, rawModelId)) continue;
      if (getModelIsHidden(rerankModel.provider, rawModelId)) continue;
      if (hasEquivalentSpecialtyModel(rerankModel.provider, rawModelId, "rerank", rerankModel.id)) {
        continue;
      }
      models.push({
        id: rerankModel.id,
        object: "model",
        created: timestamp,
        owned_by: rerankModel.provider,
        root: rawModelId,
        type: "rerank",
      });
    }

    // Add audio models (filtered by active providers)
    for (const audioModel of getAllAudioModels()) {
      if (!isProviderActive(audioModel.provider)) continue;
      const rawModelId = audioModel.id.split("/").pop() || audioModel.id;
      if (audioModel.provider === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(rawModelId)) continue;
      if (
        audioModel.provider === "openrouter" &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId) &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId + ":free")
      )
        continue;
      if (!providerSupportsModel(audioModel.provider, rawModelId)) continue;
      if (getModelIsHidden(audioModel.provider, rawModelId)) continue;
      models.push({
        id: audioModel.id,
        object: "model",
        created: timestamp,
        owned_by: audioModel.provider,
        type: "audio",
        subtype: audioModel.subtype,
      });
    }

    // Add moderation models (filtered by active providers)
    for (const modModel of getAllModerationModels()) {
      if (!isProviderActive(modModel.provider)) continue;
      const rawModelId = modModel.id.split("/").pop() || modModel.id;
      if (modModel.provider === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(rawModelId)) continue;
      if (
        modModel.provider === "openrouter" &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId) &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId + ":free")
      )
        continue;
      if (!providerSupportsModel(modModel.provider, rawModelId)) continue;
      if (getModelIsHidden(modModel.provider, rawModelId)) continue;
      models.push({
        id: modModel.id,
        object: "model",
        created: timestamp,
        owned_by: modModel.provider,
        type: "moderation",
      });
    }

    // Add video models (filtered by active providers)
    for (const videoModel of getAllVideoModels()) {
      if (!isProviderActive(videoModel.provider)) continue;
      const rawModelId = videoModel.id.split("/").pop() || videoModel.id;
      if (videoModel.provider === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(rawModelId)) continue;
      if (
        videoModel.provider === "openrouter" &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId) &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId + ":free")
      )
        continue;
      if (!providerSupportsModel(videoModel.provider, rawModelId)) continue;
      if (getModelIsHidden(videoModel.provider, rawModelId)) continue;
      models.push({
        id: videoModel.id,
        object: "model",
        created: timestamp,
        owned_by: videoModel.provider,
        type: "video",
      });
    }

    // Add music models (filtered by active providers)
    for (const musicModel of getAllMusicModels()) {
      if (!isProviderActive(musicModel.provider)) continue;
      const rawModelId = musicModel.id.split("/").pop() || musicModel.id;
      if (musicModel.provider === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(rawModelId)) continue;
      if (
        musicModel.provider === "openrouter" &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId) &&
        !ALLOWED_OPENROUTER_MODELS.has(rawModelId + ":free")
      )
        continue;
      if (!providerSupportsModel(musicModel.provider, rawModelId)) continue;
      if (getModelIsHidden(musicModel.provider, rawModelId)) continue;
      models.push({
        id: musicModel.id,
        object: "model",
        created: timestamp,
        owned_by: musicModel.provider,
        type: "music",
      });
    }

    // Add custom models (user-defined)
    try {
      const customModelsMap = (await getAllCustomModels()) as Record<string, unknown>;
      for (const [providerId, rawProviderCustomModels] of Object.entries(customModelsMap)) {
        // Skip Gemini — handled by syncedAvailableModels above
        if (providerId === "gemini") continue;
        if (providerId === "reka") continue;
        const providerCustomModels: CustomModelEntry[] = Array.isArray(rawProviderCustomModels)
          ? rawProviderCustomModels.filter(
              (model): model is CustomModelEntry =>
                !!model && typeof model === "object" && !Array.isArray(model)
            )
          : [];
        // For compatible providers, use the prefix from provider nodes
        const prefix = providerIdToPrefix[providerId];
        const alias = prefix || providerIdToAlias[providerId] || providerId;
        const canonicalProviderId = resolveCanonicalProviderId(alias, providerId);

        // Only include if provider is active — check alias, canonical ID, raw providerId,
        // or the parent provider type (for compatible providers whose node ID is a UUID)
        const parentProviderType = nodeIdToProviderType[providerId];
        if (
          !activeAliases.has(alias) &&
          !activeAliases.has(canonicalProviderId) &&
          !activeAliases.has(providerId) &&
          !(parentProviderType && activeAliases.has(parentProviderType))
        )
          continue;

        for (const model of providerCustomModels) {
          const modelId = typeof model.id === "string" ? model.id : null;
          if (!modelId) continue;

          if (canonicalProviderId === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(modelId)) {
            continue;
          }
          if (canonicalProviderId === "openrouter" && !ALLOWED_OPENROUTER_MODELS.has(modelId)) {
            continue;
          }

          const isAllowedExclusively =
            canonicalProviderId === "nvidia" || canonicalProviderId === "openrouter";
          if (!isAllowedExclusively) {
            if (model.isHidden === true) continue;
            if (getModelIsHidden(canonicalProviderId, modelId)) continue;
          }

          // noAuth providers (e.g. theoldllm) never create DB connection rows, so the
          // eligibility gate would drop every imported/custom model for them (#3200).
          // Mirror providerSupportsModel's noAuth bypass (#2798) — keep the gate for
          // auth providers (preserving parentProviderType for compatible UUID nodes).
          const isNoAuthProvider =
            isAllowedExclusively ||
            Object.values(NOAUTH_PROVIDERS).some(
              (p) =>
                p.id === canonicalProviderId ||
                p.id === providerId ||
                ("alias" in p && p.alias === alias)
            );

          if (
            !isNoAuthProvider &&
            !hasEligibleConnectionForModel(
              getConnectionsForProvider(alias, canonicalProviderId, providerId, parentProviderType),
              modelId
            )
          ) {
            continue;
          }

          // Skip if already added as built-in
          const aliasId = `${alias}/${modelId}`;
          if (models.some((m) => m.id === aliasId)) continue;

          // Determine type from supportedEndpoints
          const endpoints = Array.isArray(model.supportedEndpoints)
            ? model.supportedEndpoints
            : ["chat"];
          const apiFormat =
            typeof model.apiFormat === "string" ? model.apiFormat : "chat-completions";
          let modelType: string | undefined;
          if (endpoints.includes("embeddings")) modelType = "embedding";
          else if (endpoints.includes("rerank")) modelType = "rerank";
          else if (endpoints.includes("images")) modelType = "image";
          else if (endpoints.includes("audio")) modelType = "audio";
          if (
            modelType &&
            hasEquivalentSpecialtyModel(canonicalProviderId, modelId, modelType, aliasId)
          ) {
            continue;
          }
          const visionFields =
            modelType === "chat" ? getCustomVisionCapabilityFields(model, aliasId, modelId) : null;

          models.push({
            id: aliasId,
            object: "model",
            created: timestamp,
            owned_by: canonicalProviderId,
            permission: [],
            root: modelId,
            parent: null,
            custom: true,
            ...(modelType ? { type: modelType } : {}),
            ...(apiFormat !== "chat-completions" ? { api_format: apiFormat } : {}),
            ...(endpoints.length > 1 || !endpoints.includes("chat")
              ? { supported_endpoints: endpoints }
              : {}),
            ...(typeof model.inputTokenLimit === "number"
              ? { context_length: model.inputTokenLimit }
              : {}),
            ...(typeof model.outputTokenLimit === "number"
              ? { max_output_tokens: model.outputTokenLimit }
              : {}),
            ...(visionFields || {}),
          });

          // Only add provider-prefixed version if different from alias
          if (canonicalProviderId !== alias && !prefix) {
            const providerPrefixedId = `${canonicalProviderId}/${modelId}`;
            if (models.some((m) => m.id === providerPrefixedId)) continue;
            const providerVisionFields =
              modelType === "chat"
                ? getCustomVisionCapabilityFields(model, providerPrefixedId, modelId)
                : null;
            models.push({
              id: providerPrefixedId,
              object: "model",
              created: timestamp,
              owned_by: canonicalProviderId,
              permission: [],
              root: modelId,
              parent: aliasId,
              custom: true,
              ...(modelType ? { type: modelType } : {}),
              ...(typeof model.inputTokenLimit === "number"
                ? { context_length: model.inputTokenLimit }
                : {}),
              ...(typeof model.outputTokenLimit === "number"
                ? { max_output_tokens: model.outputTokenLimit }
                : {}),
              ...(providerVisionFields || {}),
            });
          }
        }
      }
    } catch (e) {
      console.log("Could not fetch custom models");
    }

    // Port of decolua/9router#730 — surface models registered ONLY through a model
    // alias (`key_value` namespace `modelAliases`, value `"<providerKey>/<modelId>"`).
    // Without this walk, a compatible-provider entry like `setModelAlias("kimi-k2.6",
    // "custom/kimi-k2.6")` resolves at request time but never shows up in `/v1/models`.
    // We respect the same gating as the static/custom listing path: provider must be
    // active (or noAuth+unblocked), model must not be hidden, and the canonical alias
    // entry must not already exist (so we don't shadow combo / synced / custom rows).
    try {
      const modelAliases = await getModelAliases();
      const aliasBacked = extractAliasBackedModels(modelAliases);
      for (const { providerKey, modelId } of aliasBacked) {
        const canonicalProviderId = resolveCanonicalProviderId(providerKey);
        if (!canonicalProviderId) continue;
        if (
          blockedProviders.has(providerKey) ||
          blockedProviders.has(canonicalProviderId) ||
          isNoAuthProviderBlocked(blockedProviders, canonicalProviderId, providerKey)
        ) {
          continue;
        }

        const alias = providerIdToAlias[canonicalProviderId] || providerKey;
        if (
          !activeAliases.has(alias) &&
          !activeAliases.has(canonicalProviderId) &&
          !activeAliases.has(providerKey)
        ) {
          continue;
        }

        if (getModelIsHidden(canonicalProviderId, modelId)) continue;

        const aliasId = `${alias}/${modelId}`;
        const rawPrefixedId = `${providerKey}/${modelId}`;
        if (
          models.some((m: any) => m?.id === aliasId) ||
          models.some((m: any) => m?.id === rawPrefixedId)
        ) {
          continue;
        }

        const visionFields =
          getVisionCapabilityFields(aliasId) || getVisionCapabilityFields(modelId);

        if (includeAlias) {
          models.push({
            id: aliasId,
            object: "model",
            created: timestamp,
            owned_by: canonicalProviderId,
            permission: [],
            root: modelId,
            parent: null,
            ...(visionFields || {}),
          });
        }
        if (
          includeCanonical &&
          canonicalProviderId !== alias &&
          !isNoAuthProviderKey(canonicalProviderId) &&
          prefixRoutesToProvider(canonicalProviderId, canonicalProviderId)
        ) {
          const providerPrefixedId = `${canonicalProviderId}/${modelId}`;
          if (models.some((m: any) => m?.id === providerPrefixedId)) continue;
          const providerVisionFields =
            getVisionCapabilityFields(providerPrefixedId) || getVisionCapabilityFields(modelId);
          models.push({
            id: providerPrefixedId,
            object: "model",
            created: timestamp,
            owned_by: canonicalProviderId,
            permission: [],
            root: modelId,
            parent: includeAlias ? aliasId : null,
            ...(providerVisionFields || {}),
          });
        }
      }
    } catch (e) {
      console.log("Could not fetch model aliases");
    }

    // Add managed fallback models for compatible providers that don't import a model list.
    for (const conn of connections) {
      const providerId = typeof conn.provider === "string" ? conn.provider : null;
      if (!providerId) continue;
      if (blockedProviders.has(providerId)) continue;

      const fallbackModels = getCompatibleFallbackModels(providerId);
      if (!Array.isArray(fallbackModels) || fallbackModels.length === 0) continue;

      const prefix = providerIdToPrefix[providerId];
      const alias = prefix || providerIdToAlias[providerId] || providerId;
      const canonicalProviderId = resolveCanonicalProviderId(alias, providerId);

      for (const model of fallbackModels) {
        const modelId = typeof model.id === "string" ? model.id : null;
        if (!modelId) continue;

        if (providerId === "nvidia" && !ALLOWED_NVIDIA_MODELS.has(modelId)) {
          continue;
        }
        if (providerId === "openrouter" && !ALLOWED_OPENROUTER_MODELS.has(modelId)) {
          continue;
        }

        const isAllowedExclusively = providerId === "nvidia" || providerId === "openrouter";
        if (!isAllowedExclusively && getModelIsHidden(canonicalProviderId, modelId)) {
          continue;
        }

        if (!hasEligibleConnectionForModel([conn], modelId)) continue;

        const aliasId = `${alias}/${modelId}`;
        if (models.some((m) => m.id === aliasId)) continue;

        const visionFields =
          getVisionCapabilityFields(aliasId) || getVisionCapabilityFields(modelId);
        const contextLength =
          typeof model.contextLength === "number" ? model.contextLength : undefined;

        models.push({
          id: aliasId,
          object: "model",
          created: timestamp,
          owned_by: providerId,
          permission: [],
          root: modelId,
          parent: null,
          ...(contextLength ? { context_length: contextLength } : {}),
          ...(visionFields || {}),
        });
      }
    }

    // Filter by API key permissions if requested
    const apiKey = extractApiKey(request);
    let finalModels = models;
    if (apiKey) {
      const { isModelAllowedForKey, getApiKeyMetadata } = await import("@/lib/db/apiKeys");

      // Quota-exclusive keys (allowedQuotas non-empty): list ONLY the pool's qtSd/*
      // virtual models. #4806: build from the hidden qtSd/* combos directly — the base
      // `models` list drops hidden combos, so filtering it returned nothing (0 models).
      const keyMeta = await getApiKeyMetadata(apiKey);
      if (keyMeta && keyMeta.allowedQuotas && keyMeta.allowedQuotas.length > 0) {
        const { buildQuotaExclusiveModels } = await import("@/lib/quota/quotaCombos");
        finalModels = await buildQuotaExclusiveModels(
          keyMeta.allowedQuotas,
          combos,
          timestamp,
          (c) => buildComboCatalogMetadata(c, combos)
        );
      } else {
        const filtered = [];
        for (const m of models) {
          // m.id is the full identifier (e.g. openai/gpt-4o), m.root is the raw model string
          // check either one as the config could use either patterns
          if (
            (await isModelAllowedForKey(apiKey, m.id)) ||
            (await isModelAllowedForKey(apiKey, m.root))
          ) {
            filtered.push(m);
          }
        }
        finalModels = filtered;
      }
    }

    const getDefaultContextFallback = (model: any): number | undefined => {
      if (typeof model.context_length === "number") return undefined;
      if (model.owned_by === "combo") return undefined;
      if (model.type && model.type !== "chat") return undefined;

      const provider = typeof model.owned_by === "string" ? model.owned_by : null;
      if (!provider) return undefined;
      const canonicalId = aliasToProviderId[provider] || provider;

      const registryFallback = REGISTRY[canonicalId]?.defaultContextLength;
      if (registryFallback) return registryFallback;

      const modelId =
        model.root || (typeof model.id === "string" ? model.id.split("/").pop() : undefined);
      return modelId ? getTokenLimit(canonicalId, modelId) : getTokenLimit(canonicalId);
    };

    const includeModelNames = isModelCatalogNamesEnabled();
    const enrichedModels = finalModels.map((model) => {
      if (model.owned_by === "combo" || model.owned_by === virtualCatalogBrand) {
        return maybeOmitCatalogModelName(model, includeModelNames);
      }
      const enriched = enrichCatalogModelEntry(model);
      const fallbackContextLength = getDefaultContextFallback(enriched);
      const listedModel = fallbackContextLength
        ? { ...enriched, context_length: fallbackContextLength }
        : enriched;
      return maybeOmitCatalogModelName(listedModel, includeModelNames);
    });

    // Product policy: /v1/models advertises only text-generation models.
    // Specialty models remain available through their dedicated endpoint catalogs.
    let outputModels = enrichedModels.filter(isTextGenerationCatalogModel);

    // When virtual catalog mode is active, remove provider-prefixed entries whose
    // exact canonical identity is already represented by a clean virtual model.
    if (virtualCatalogEnabled && virtualCatalogRootIds.size > 0) {
      outputModels = outputModels.filter((model) => {
        if (model.owned_by === virtualCatalogBrand) return true;

        const modelId = typeof model.id === "string" ? model.id : "";
        const rootId = typeof model.root === "string" ? model.root : modelId;
        const canonical = getCanonicalTextGenerationModelId(rootId);
        if (virtualCatalogRootIds.has(canonical)) return false;
        if (virtualCatalogRootIds.has(sanitizeTextGenerationCatalogId(canonical))) return false;

        const slashIdx = modelId.indexOf("/");
        if (slashIdx > 0) {
          const canonicalUnprefixed = getCanonicalTextGenerationModelId(
            modelId.slice(slashIdx + 1)
          );
          if (virtualCatalogRootIds.has(canonicalUnprefixed)) return false;
          if (virtualCatalogRootIds.has(sanitizeTextGenerationCatalogId(canonicalUnprefixed))) {
            return false;
          }
        }
        return true;
      });
    }

    // Codex CLI compatibility: its model-catalog refresh (codex_models_manager) does
    // GET /v1/models?client_version=<v> and decodes a JSON object with a TOP-LEVEL
    // `models` array, so the OpenAI-standard `{object,data}` shape makes it fail with
    // "missing field `models`" and log "failed to refresh available models" on every
    // startup. For codex clients only (detected by the codex originator/user-agent) we add
    // an EMPTY `models: []` so the decode succeeds and the error disappears. Every other
    // OpenAI consumer keeps the byte-identical `{object,data}` response.
    //
    // We deliberately keep it EMPTY rather than mirroring the catalog: codex replaces its
    // built-in per-model agent prompt (`base_instructions`, ~21k chars) with whatever a
    // populated entry carries for the selected model, so emitting our models with an
    // empty/foreign `base_instructions` would drop codex's agent prompt to nothing and
    // break its agent behavior (verified empirically against codex 0.137). An empty array
    // keeps codex on its built-in model info — same inference as today, minus the error.
    const responseBody: Record<string, unknown> = {
      object: "list",
      data: outputModels,
    };
    if (isCodexModelCatalogClient(request)) {
      responseBody.models = [];
    }

    return Response.json(responseBody, {
      headers: {
        ...corsHeaders,
        ...diagnosticHeaders,
      },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "server_error",
          code: INTERNAL_PROXY_ERROR,
        },
      },
      {
        status: 500,
        headers: {
          ...corsHeaders,
          ...diagnosticHeaders,
        },
      }
    );
  }
}
