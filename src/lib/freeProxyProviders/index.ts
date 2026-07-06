import type { FreeProxyProvider, FreeProxySourceId } from "./types";
import { OneproxyProvider } from "./oneproxy";
import { ProxiflyProvider } from "./proxifly";
import { IplocateProvider } from "./iplocate";
import { ProxyPoolProvider } from "./proxypool";
import { ProxyScraperProvider } from "./proxyscraper";

const ALL_PROVIDERS: FreeProxyProvider[] = [
  new OneproxyProvider(),
  new ProxiflyProvider(),
  new IplocateProvider(),
  new ProxyPoolProvider(),
  new ProxyScraperProvider(),
];

/**
 * Persisted provider toggle map (`freeProxyProviderToggles` settings key).
 *
 * Resolution order for `isProviderEnabled(id, envFlag)`:
 *   1. If a persisted boolean exists for `id`, it wins (operator overrides env).
 *   2. Otherwise fall back to the env flag default (the historical behaviour —
 *      providers default ON unless their `FREE_PROXY_<NAME>_ENABLED=false`).
 *
 * The cache is intentionally sync because `isEnabled()` and
 * `getEnabledProviders()` are called from sync call-sites (the scheduler tick,
 * the stats route, the manual sync route filter). Hydration happens before any
 * tick via `loadPersistedProviderToggles()` at boot and is re-pushed by
 * `applyRuntimeSettings` whenever the operator PATCHes the settings, so the
 * sync read path never sees a stale cache in practice.
 */
let persistedToggles: Partial<Record<FreeProxySourceId, boolean>> | null = null;

/**
 * Returns the persisted enable-state for a provider id, or `undefined` when no
 * persisted override exists (caller should fall back to env).
 */
export function getPersistedProviderToggle(id: FreeProxySourceId): boolean | undefined {
  if (persistedToggles == null) return undefined;
  const value = persistedToggles[id];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Sync override used by `applyRuntimeSettings` after a settings PATCH (and by
 * the boot path). Replaces the entire cached map atomically. Passing `null`
 * clears the cache so subsequent reads fall back to env defaults.
 */
export function setPersistedProviderToggles(
  map: Partial<Record<FreeProxySourceId, boolean>> | null,
): void {
  persistedToggles = map;
}

/**
 * Shared enable-state resolver consulted by every provider's `isEnabled()`.
 *
 * @param id       provider id (`FreeProxySourceId`)
 * @param envFlag  the env var name the provider historically checked
 * @returns `true` unless an operator persistently disabled the provider
 *          (persisted `false`) or set the env flag to `"false"`. A persisted
 *          `true` re-enables a provider that the env flag disabled.
 */
export function isProviderEnabled(id: FreeProxySourceId, envFlag: string): boolean {
  const persisted = getPersistedProviderToggle(id);
  if (persisted !== undefined) {
    return persisted;
  }
  return process.env[envFlag] !== "false";
}

/**
 * Lazily hydrates the persisted-toggle cache from the settings store. Safe to
 * call repeatedly; only the first miss triggers a DB read. Subsequent calls
 * are a no-op once the cache is non-null (so `setPersistedProviderToggles`
 * pushes from `applyRuntimeSettings` are preserved).
 */
export async function loadPersistedProviderToggles(): Promise<void> {
  if (persistedToggles !== null) return;
  try {
    const { getSettings } = await import("@/lib/db/settings");
    const settings = await getSettings();
    const raw = settings.freeProxyProviderToggles;
    persistedToggles = normalizeToggles(raw);
  } catch {
    // Cold-boot before the DB is ready: leave env-derived defaults in place.
    persistedToggles = {};
  }
}

function normalizeToggles(
  raw: unknown,
): Partial<Record<FreeProxySourceId, boolean>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<FreeProxySourceId, boolean>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") {
      out[key as FreeProxySourceId] = value;
    }
  }
  return out;
}

export function getProvider(id: FreeProxySourceId): FreeProxyProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

export function getEnabledProviders(): FreeProxyProvider[] {
  return ALL_PROVIDERS.filter((p) => p.isEnabled());
}

export function getAllProviders(): FreeProxyProvider[] {
  return ALL_PROVIDERS;
}
