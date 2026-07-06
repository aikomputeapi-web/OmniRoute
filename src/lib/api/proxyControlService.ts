/**
 * proxyControlService.ts — Proxy Control Center backend contract.
 *
 * Bridges the customer-portal Proxy Control Center UI to OmniRoute's native
 * free-proxy / proxy-registry persistence layer. The single source of truth for
 * proxy pool state is OmniRoute's SQLite `free_proxies` / `proxy_registry` /
 * `proxy_assignments` tables, driven by the background `freeProxyJob` and
 * surfaced by `@/lib/db/freeProxies` and `@/lib/db/proxies`.
 *
 * Wire contract (mirrors `customer-portal/src/lib/proxy-control.ts`):
 *   - Tier 1/2 rows come from `free_proxies` (keyed by `id`).
 *   - Tier 3 rows come from `proxy_registry` joined with the `global` scope
 *     `proxy_assignments` (keyed by `registryId` = `proxy_registry.id`).
 *   - Settings use the package's `JobSettings` camelCase field names with
 *     millisecond intervals (`checkIntervalMs` / `syncIntervalMs`); the customer
 *     portal coerces those to minutes.
 *
 * Why native infra instead of the reusable package:
 *   The reusable proxy package (`proxy-tool-reuseable/`) declares
 *   `better-sqlite3` + `undici` as optional peer-deps and ships only a built
 *   `dist/`. Wiring it into OmniRoute against the already-running job + SQLite
 *   file would duplicate the schema and diverge from the live scheduler. The
 *   package maps 1:1 onto OmniRoute's existing DB helpers, so the contract is
 *   honored here without pulling in the package as a dependency. See
 *   `customer-portal/PROXY_CONTROL_CENTER_HANDOFF.md` for the full rationale.
 */

import { getDbInstance } from "@/lib/db/core";
import {
  deleteFreeProxy,
  getFreeProxyById,
  getFreeProxyStats,
  listFreeProxiesByTier,
  promoteFreeProxyToPool,
  resetFreeProxyConsecutiveCounters,
  setFreeProxyTier,
  type FreeProxyRecord,
} from "@/lib/db/freeProxies";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { getAllProviders } from "@/lib/freeProxyProviders";

export type ProxyTier = "tier1" | "tier2" | "tier3";
export const PROXY_CONTROL_TIERS: readonly ProxyTier[] = ["tier1", "tier2", "tier3"];

export type ProxyManualAction =
  | "promote"
  | "demote"
  | "quarantine"
  | "remove"
  | "run-check"
  | "run-sync";

export const PROXY_MANUAL_ACTIONS: readonly ProxyManualAction[] = [
  "promote",
  "demote",
  "quarantine",
  "remove",
  "run-check",
  "run-sync",
];

/** Default global pool size used when no setting is present. */
const DEFAULT_POOL_SIZE = 20;

/** Settings keys persisted in the `settings` namespace that influence the job. */
const FREE_PROXY_SETTING_KEYS = new Set<string>([
  "freeProxyAutoJobEnabled",
  "freeProxyCheckIntervalMin",
  "freeProxySyncIntervalMin",
  "freeProxyCountryFilter",
  "freeProxyMinQuality",
  "freeProxyMinSuccessRate",
  "freeProxyMinTests",
  "freeProxyGlobalPoolSize",
  "freeProxyAutoElevate",
  "freeProxyAutoRemoveDead",
  "freeProxyTier1PromoteThreshold",
  "freeProxyTier2DemoteThreshold",
  "freeProxyLiveFailThreshold",
  "freeProxyAutoDistribute",
  // Persisted provider toggle store. `applyRuntimeSettings` pushes this map
  // into the live provider cache (freeProxyProviders/index.setPersistedProviderToggles)
  // and the scheduler's `getEnabledProviders()` honours it via `isProviderEnabled()`.
  // Env flags (e.g. FREE_PROXY_1PROXY_ENABLED) remain the cold-boot default
  // before the first settings apply.
  "freeProxyProviderToggles",
]);

export interface FreeProxyRowWire {
  id: string;
  tier: number;
  type: string;
  host: string;
  port: number;
  source: string;
  country_code: string | null;
  quality_score: number | null;
  latency_ms: number | null;
  in_pool: number;
  pool_proxy_id: string | null;
  test_count: number;
  success_count: number;
  consecutive_successes: number;
  consecutive_failures: number;
  last_validated: string | null;
  updated_at: string;
}

export interface GlobalPoolRowWire {
  registryId: string;
  type: string;
  host: string;
  port: number;
  source: string | null;
  region: string | null;
  quality_score: number | null;
  latency_ms: number | null;
  status: string;
  updated_at: string;
  scope_id: string | null;
}

export interface JobSettingsWire {
  enabled: boolean;
  checkIntervalMs: number;
  syncIntervalMs: number;
  countryFilter: string;
  minQuality: number;
  minSuccessRate: number;
  minTests: number;
  poolSize: number;
  autoElevate: boolean;
  autoRemoveDead: boolean;
  tier1PromoteThreshold: number;
  tier2DemoteThreshold: number;
  liveFailThreshold: number;
  autoDistribute: boolean;
}

export interface ProxySettingsWire extends JobSettingsWire {
  providers: Record<string, boolean>;
}

export interface ProxyControlSnapshotWire {
  tiers: Record<ProxyTier, FreeProxyRowWire[] | GlobalPoolRowWire[]>;
  settings: ProxySettingsWire;
  source: "omniroute";
  counts: Record<ProxyTier, number>;
  globalPoolCount: number;
  lastSyncedAt: string | null;
}

export interface ProxyActionResultWire {
  success: boolean;
  action: ProxyManualAction;
  applied: number;
  skipped: number;
  errors: Array<{ selectionKey: string; error: string }>;
}

const DEFAULT_JOB_SETTINGS: JobSettingsWire = {
  enabled: false,
  checkIntervalMs: 5 * 60_000,
  syncIntervalMs: 30 * 60_000,
  countryFilter: "US",
  minQuality: 40,
  minSuccessRate: 100,
  minTests: 5,
  poolSize: DEFAULT_POOL_SIZE,
  autoElevate: true,
  autoRemoveDead: true,
  tier1PromoteThreshold: 5,
  tier2PromoteThreshold: 10,
  tier2DemoteThreshold: 3,
  liveFailThreshold: 3,
  autoDistribute: false,
};

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value: unknown): boolean {
  return value === true;
}

/** Provider toggle map: derive current env state then overlay persisted toggles. */
async function resolveProviderToggles(
  persisted: Record<string, boolean> | undefined,
): Promise<Record<string, boolean>> {
  const providers = getAllProviders();
  const map: Record<string, boolean> = {};
  for (const provider of providers) {
    map[provider.id] = provider.isEnabled();
  }
  if (persisted && typeof persisted === "object") {
    for (const [key, value] of Object.entries(persisted)) {
      map[key] = toBool(value);
    }
  }
  return map;
}

function jobSettingsFromRaw(raw: Record<string, unknown>): JobSettingsWire {
  const checkIntervalMin = num(raw.freeProxyCheckIntervalMin, 10);
  const syncIntervalMin = num(raw.freeProxySyncIntervalMin, 30);
  return {
    enabled: raw.freeProxyAutoJobEnabled === true || raw.freeProxyAutoJobEnabled === undefined,
    checkIntervalMs: Math.max(1, Math.round(checkIntervalMin * 60_000)),
    syncIntervalMs: Math.max(1, Math.round(syncIntervalMin * 60_000)),
    countryFilter:
      typeof raw.freeProxyCountryFilter === "string" && raw.freeProxyCountryFilter.length > 0
        ? String(raw.freeProxyCountryFilter).toUpperCase()
        : DEFAULT_JOB_SETTINGS.countryFilter,
    minQuality: num(raw.freeProxyMinQuality, DEFAULT_JOB_SETTINGS.minQuality),
    minSuccessRate: num(raw.freeProxyMinSuccessRate, DEFAULT_JOB_SETTINGS.minSuccessRate),
    minTests: num(raw.freeProxyMinTests, DEFAULT_JOB_SETTINGS.minTests),
    poolSize: num(raw.freeProxyGlobalPoolSize, DEFAULT_JOB_SETTINGS.poolSize),
    autoElevate: raw.freeProxyAutoElevate !== false,
    autoRemoveDead:
      raw.freeProxyAutoRemoveDead === undefined ? true : raw.freeProxyAutoRemoveDead !== false,
    tier1PromoteThreshold: num(raw.freeProxyTier1PromoteThreshold, DEFAULT_JOB_SETTINGS.tier1PromoteThreshold),
    tier2PromoteThreshold: num(raw.freeProxyTier2PromoteThreshold, DEFAULT_JOB_SETTINGS.tier2PromoteThreshold),
    tier2DemoteThreshold: num(raw.freeProxyTier2DemoteThreshold, DEFAULT_JOB_SETTINGS.tier2DemoteThreshold),
    liveFailThreshold: num(raw.freeProxyLiveFailThreshold, DEFAULT_JOB_SETTINGS.liveFailThreshold),
    autoDistribute: raw.freeProxyAutoDistribute === true,
  };
}

function serializeFreeProxyRow(row: FreeProxyRecord): FreeProxyRowWire {
  return {
    id: row.id,
    tier: row.tier,
    type: row.type,
    host: row.host,
    port: row.port,
    source: row.source,
    country_code: row.countryCode,
    quality_score: row.qualityScore,
    latency_ms: row.latencyMs,
    in_pool: row.inPool ? 1 : 0,
    pool_proxy_id: row.poolProxyId,
    test_count: row.testCount,
    success_count: row.successCount,
    consecutive_successes: row.consecutiveSuccesses,
    consecutive_failures: row.consecutiveFailures,
    last_validated: row.lastValidated,
    updated_at: row.updatedAt,
  };
}

function listGlobalPoolRows(): GlobalPoolRowWire[] {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT p.id, p.type, p.host, p.port, p.source, p.region, p.quality_score,
              p.latency_ms, p.status, p.updated_at, pa.scope_id
         FROM proxy_registry p
         JOIN proxy_assignments pa ON pa.proxy_id = p.id
        WHERE pa.scope = 'global' AND pa.scope_id LIKE '__global__%'
        ORDER BY CAST(SUBSTR(pa.scope_id, 11) AS INTEGER) ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    registryId: String(r.id ?? ""),
    type: String(r.type ?? "http"),
    host: String(r.host ?? ""),
    port: num(r.port, 0),
    source: r.source != null ? String(r.source) : null,
    region: r.region != null ? String(r.region) : null,
    quality_score: r.quality_score != null ? num(r.quality_score, 0) : null,
    latency_ms: r.latency_ms != null ? num(r.latency_ms, 0) : null,
    status: String(r.status ?? "active"),
    updated_at: String(r.updated_at ?? ""),
    scope_id: r.scope_id != null ? String(r.scope_id) : null,
  }));
}

/**
 * Build the full Proxy Control Center snapshot by reading the live SQLite
 * free-proxy / global-pool state plus persisted settings.
 */
export async function buildProxyControlSnapshot(): Promise<ProxyControlSnapshotWire> {
  const rawSettings = (await getSettings()) as Record<string, unknown>;
  const jobSettings = jobSettingsFromRaw(rawSettings);
  const persistedToggles = isRecord(rawSettings.freeProxyProviderToggles)
    ? (rawSettings.freeProxyProviderToggles as Record<string, boolean>)
    : undefined;
  const providers = await resolveProviderToggles(persistedToggles);

  const [tier1, tier2, stats] = await Promise.all([
    listFreeProxiesByTier(1, { limit: 500 }),
    listFreeProxiesByTier(2, { limit: 500 }),
    getFreeProxyStats(),
  ]);
  const tier3 = listGlobalPoolRows();

  return {
    tiers: {
      tier1: tier1.map(serializeFreeProxyRow),
      tier2: tier2.map(serializeFreeProxyRow),
      tier3,
    },
    settings: { ...jobSettings, providers },
    source: "omniroute",
    counts: {
      tier1: tier1.length,
      tier2: tier2.length,
      tier3: tier3.length,
    },
    globalPoolCount: tier3.length,
    lastSyncedAt: stats.lastSyncAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate + apply a partial settings patch. Accepts minute-form intervals plus
 * the `providers` map. Returns the fresh snapshot on success.
 *
 * Notes:
 *  - Provider toggles are persisted under `freeProxyProviderToggles` and are
 *    honoured live: `updateSettings` → `applyRuntimeSettings` pushes the map
 *    into the provider module cache (`setPersistedProviderToggles`), and the
 *    scheduler's `getEnabledProviders()` consults `isProviderEnabled()` which
 *    prefers the persisted value over the env flag. Flipping a provider in the
 *    UI therefore takes effect on the next tick without a restart.
 *  - Applying settings triggers `updateSettings`, which hot-reloads the
 *    `freeProxyJob` via `applyRuntimeSettings`.
 */
export async function applyProxyControlSettings(
  patch: Record<string, unknown>,
  _actor?: string,
): Promise<ProxyControlSnapshotWire> {
  if (!isRecord(patch)) {
    throw newMalformedError("settings patch must be a JSON object");
  }

  const updates: Record<string, unknown> = {};

  if (patch.enabled !== undefined) {
    updates.freeProxyAutoJobEnabled = toBool(patch.enabled);
  }
  if (typeof patch.checkIntervalMinutes === "number" && Number.isFinite(patch.checkIntervalMinutes)) {
    updates.freeProxyCheckIntervalMin = Math.max(1, Math.round(patch.checkIntervalMinutes));
  } else if (typeof patch.checkIntervalMin === "number") {
    updates.freeProxyCheckIntervalMin = Math.max(1, Math.round(patch.checkIntervalMin));
  }
  if (typeof patch.syncIntervalMinutes === "number" && Number.isFinite(patch.syncIntervalMinutes)) {
    updates.freeProxySyncIntervalMin = Math.max(1, Math.round(patch.syncIntervalMinutes));
  } else if (typeof patch.syncIntervalMin === "number") {
    updates.freeProxySyncIntervalMin = Math.max(1, Math.round(patch.syncIntervalMin));
  }
  if (typeof patch.countryFilter === "string" && patch.countryFilter.length > 0) {
    updates.freeProxyCountryFilter = String(patch.countryFilter).toUpperCase();
  }
  if (typeof patch.minQuality === "number") updates.freeProxyMinQuality = Math.max(0, Math.round(patch.minQuality));
  if (typeof patch.minSuccessRate === "number") {
    updates.freeProxyMinSuccessRate = Math.max(0, Math.min(100, Math.round(patch.minSuccessRate)));
  }
  if (typeof patch.minTests === "number") updates.freeProxyMinTests = Math.max(1, Math.round(patch.minTests));
  if (typeof patch.poolSize === "number") {
    updates.freeProxyGlobalPoolSize = Math.max(1, Math.round(patch.poolSize));
  }
  if (typeof patch.autoElevate === "boolean") updates.freeProxyAutoElevate = patch.autoElevate;
  if (typeof patch.autoRemoveDead === "boolean") updates.freeProxyAutoRemoveDead = patch.autoRemoveDead;
  if (typeof patch.tier1PromoteThreshold === "number") {
    updates.freeProxyTier1PromoteThreshold = Math.max(1, Math.round(patch.tier1PromoteThreshold));
  }
  if (typeof patch.tier2PromoteThreshold === "number") {
    updates.freeProxyTier2PromoteThreshold = Math.max(1, Math.round(patch.tier2PromoteThreshold));
  }
  if (typeof patch.tier2DemoteThreshold === "number") {
    updates.freeProxyTier2DemoteThreshold = Math.max(1, Math.round(patch.tier2DemoteThreshold));
  }
  if (typeof patch.liveFailThreshold === "number") {
    updates.freeProxyLiveFailThreshold = Math.max(1, Math.round(patch.liveFailThreshold));
  }
  if (typeof patch.autoDistribute === "boolean") updates.freeProxyAutoDistribute = patch.autoDistribute;

  if (isRecord(patch.providers)) {
    const providerToggles: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(patch.providers)) {
      providerToggles[key] = toBool(value);
    }
    updates.freeProxyProviderToggles = providerToggles;
  }

  // Reject keys we do not know how to persist, but only at the top level —
  // unknown nested keys (e.g. extra provider ids) are tolerated.
  const unknownKeys = Object.keys(patch).filter(
    (key) =>
      !KNOWN_SETTINGS_PATCH_KEYS.has(key) && key !== "actor",
  );
  if (unknownKeys.length > 0) {
    throw newMalformedError(`unknown settings key(s): ${unknownKeys.join(", ")}`);
  }

  if (Object.keys(updates).length > 0) {
    // Only pass known persistent setting keys to updateSettings so we never
    // write arbitrary payload into the key_value store.
    const safeUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (FREE_PROXY_SETTING_KEYS.has(key)) safeUpdates[key] = value;
    }
    if (Object.keys(safeUpdates).length > 0) {
      await updateSettings(safeUpdates);
    }
  }

  return buildProxyControlSnapshot();
}

const KNOWN_SETTINGS_PATCH_KEYS = new Set<string>([
  "enabled",
  "checkIntervalMinutes",
  "checkIntervalMin",
  "syncIntervalMinutes",
  "syncIntervalMin",
  "countryFilter",
  "minQuality",
  "minSuccessRate",
  "minTests",
  "poolSize",
  "autoElevate",
  "autoRemoveDead",
  "tier1PromoteThreshold",
  "tier2DemoteThreshold",
  "liveFailThreshold",
  "autoDistribute",
  "providers",
]);

export interface ProxyActionRequestInput {
  action: string;
  selectionKeys: unknown;
  actor?: unknown;
}

/**
 * Parse a `{ tier, sourceId }` selection key. Tier 1/2 sourceId is a
 * `free_proxies.id`; tier 3 sourceId is a `proxy_registry.id`.
 */
function parseSelectionKey(key: string): { tier: ProxyTier; sourceId: string } | null {
  if (typeof key !== "string") return null;
  const sep = key.indexOf(":");
  if (sep <= 0) return null;
  const tierStr = key.slice(0, sep);
  const sourceId = key.slice(sep + 1);
  if (!sourceId) return null;
  if (tierStr === "tier1" || tierStr === "tier2" || tierStr === "tier3") {
    return { tier: tierStr as ProxyTier, sourceId };
  }
  return null;
}

function newMalformedError(message: string): Error {
  const err = new Error(message);
  (err as { status?: number }).status = 400;
  return err;
}

function newNotFoundError(message: string): Error {
  const err = new Error(message);
  (err as { status?: number }).status = 404;
  return err;
}

function newUnsupportedError(message: string): Error {
  const err = new Error(message);
  (err as { status?: number }).status = 501;
  return err;
}

/**
 * Demote a Tier 3 (global-pool) proxy back to Tier 2. The free-proxy job owns a
 * private `demoteTier3ToTier1`; here we demote to Tier 2 (matches the contract:
 * portal demote targets Tier 3 selections) and clear the registry assignment in
 * one transaction. Implemented directly against the documented schema to avoid
 * refactoring private job exports.
 */
function demoteTier3ToTier2(registryId: string): boolean {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const freeProxy = db
      .prepare("SELECT id FROM free_proxies WHERE pool_proxy_id = ?")
      .get(registryId) as { id?: string } | undefined;

    db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(registryId);
    db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(registryId);

    if (freeProxy?.id) {
      db.prepare(
        "UPDATE free_proxies SET tier = 2, in_pool = 0, pool_proxy_id = NULL, consecutive_successes = 0, consecutive_failures = 0, updated_at = ? WHERE id = ?",
      ).run(now, freeProxy.id);
    }
    return Boolean(freeProxy?.id);
  })();
  return result;
}

/**
 * Promote a Tier 2 candidate into the global pool (Tier 3). Reuses the atomic
 * `promoteFreeProxyToPool` helper that inserts the `proxy_registry` row and
 * flips the free proxy's `in_pool` flag in a single transaction. The portal-side
 * contract expects promote to be available for Tier 2 selections.
 */
async function promoteTier2ToGlobal(freeProxyId: string): Promise<boolean> {
  const free = await getFreeProxyById(freeProxyId);
  if (!free) return false;
  if (free.inPool) return true; // already in pool — treat as success (idempotent)
  const newRegistryId = await promoteFreeProxyToPool(free.id, {
    name: `[${free.source}] ${free.host}:${free.port}`,
    type: free.type,
    host: free.host,
    port: free.port,
    source: free.source,
  });
  return newRegistryId != null;
}

/**
 * Best-effort quarantine: reset consecutive counters and drop Tier 3 selections
 * back to Tier 2 (out of the live pool). The free-proxy package has no
 * dedicated quarantine status; this is the documented best-effort mapping.
 */
function quarantineSelection(tier: ProxyTier, sourceId: string): boolean {
  if (tier === "tier1" || tier === "tier2") {
    return resetFreeProxyConsecutiveCounters(sourceId);
  }
  if (tier === "tier3") {
    return demoteTier3ToTier2(sourceId);
  }
  return false;
}

/**
 * Remove a selection. Tier 1/2 → delete the `free_proxies` row (and its linked
 * registry row if any); Tier 3 → remove the registry/assignments and unlink the
 * free proxy back to Tier 1 (matches `demoteTier3ToTier1` semantics).
 */
async function removeSelection(tier: ProxyTier, sourceId: string): Promise<boolean> {
  if (tier === "tier1" || tier === "tier2") {
    return deleteFreeProxy(sourceId);
  }
  // Tier 3 remove: delegate to the job's exported `demoteTier3ToTier1`, which
  // atomically deletes the proxy_registry/assignments rows and resets the
  // linked free_proxies row to Tier 1 (counters cleared, in_pool=0).
  const { demoteTier3ToTier1 } = await import("@/lib/jobs/freeProxyJob");
  const db = getDbInstance();
  const hostRow = db
    .prepare("SELECT host FROM proxy_registry WHERE id = ?")
    .get(sourceId) as { host?: string } | undefined;
  await demoteTier3ToTier1(sourceId, hostRow?.host ?? sourceId);
  return true;
}

/**
 * Dispatch a manual action selected by the customer-portal Proxy Control
 * Center. `run-check` / `run-sync` accept an empty selection (global tick).
 */
export async function dispatchProxyControlAction(
  input: ProxyActionRequestInput,
): Promise<ProxyActionResultWire> {
  if (!isRecord(input as unknown)) {
    throw newMalformedError("action request must be a JSON object");
  }
  const action = String(input.action ?? "");
  if (!PROXY_MANUAL_ACTIONS.includes(action as ProxyManualAction)) {
    throw newMalformedError(
      `unknown action "${action}"; allowed: ${PROXY_MANUAL_ACTIONS.join(", ")}`,
    );
  }
  const rawSelection = input.selectionKeys;
  if (!Array.isArray(rawSelection)) {
    throw newMalformedError("selectionKeys must be an array");
  }

  if (action === "run-check" || action === "run-sync") {
    // Global tick — selection is optional. Fire-and-forget the background tick
    // so the HTTP request resolves quickly, matching the existing
    // `/api/settings/free-proxies/test-all` and `/sync` behaviour.
    const errors: Array<{ selectionKey: string; error: string }> = [];
    void runFreeProxyTick(action).catch((err) => {
      console.warn(`[ProxyControl] ${action} tick failed:`, err);
    });
    return {
      success: true,
      action: action as ProxyManualAction,
      applied: 1,
      skipped: 0,
      errors,
    };
  }

  const parsedSelections = rawSelection
    .map((key) => parseSelectionKey(String(key)))
    .filter((parsed): parsed is { tier: ProxyTier; sourceId: string } => parsed !== null);

  if (parsedSelections.length === 0) {
    throw newMalformedError("selectionKeys must contain at least one `${tier}:${sourceId}`");
  }

  const errors: Array<{ selectionKey: string; error: string }> = [];
  let applied = 0;
  let skipped = 0;

  for (const { tier, sourceId } of parsedSelections) {
    const selectionKey = `${tier}:${sourceId}`;
    try {
      if (action === "promote") {
        if (tier !== "tier2") {
          skipped++;
          errors.push({
            selectionKey,
            error: "promote is only valid for tier2 selections",
          });
          continue;
        }
        const ok = await promoteTier2ToGlobal(sourceId);
        if (ok) {
          applied++;
        } else {
          skipped++;
          errors.push({ selectionKey, error: "promotion failed" });
        }
      } else if (action === "demote") {
        if (tier !== "tier3") {
          skipped++;
          errors.push({
            selectionKey,
            error: "demote is only valid for tier3 selections",
          });
          continue;
        }
        if (demoteTier3ToTier2(sourceId)) {
          applied++;
        } else {
          skipped++;
          errors.push({ selectionKey, error: "demote failed" });
        }
      } else if (action === "quarantine") {
        if (quarantineSelection(tier, sourceId)) {
          applied++;
        } else {
          skipped++;
          errors.push({ selectionKey, error: "quarantine had no matching row" });
        }
      } else if (action === "remove") {
        const ok = await removeSelection(tier, sourceId);
        if (ok) {
          applied++;
        } else {
          skipped++;
          errors.push({ selectionKey, error: "remove found no matching row" });
        }
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 404) {
        skipped++;
        errors.push({ selectionKey, error: "not found" });
      } else if (status === 501) {
        skipped++;
        errors.push({
          selectionKey,
          error: err instanceof Error ? err.message : "unsupported action",
        });
      } else {
        errors.push({
          selectionKey,
          error: err instanceof Error ? err.message : "internal error",
        });
      }
    }
  }

  return {
    success: errors.length === 0,
    action: action as ProxyManualAction,
    applied,
    skipped,
    errors,
  };
}

async function runFreeProxyTick(action: "run-check" | "run-sync"): Promise<void> {
  if (action === "run-check") {
    const { runFreeProxyCheckTick } = await import("@/lib/jobs/freeProxyJob");
    await runFreeProxyCheckTick();
    return;
  }
  // Sync: delegate to the job's exported `runFreeProxySyncTick`, which
  // orchestrates provider sync + non-matching-country cleanup + elevate in one
  // pass and records the sync marker the snapshot's `lastSyncedAt` reads.
  const { runFreeProxySyncTick } = await import("@/lib/jobs/freeProxyJob");
  await runFreeProxySyncTick();
}

export { newNotFoundError, newUnsupportedError };
