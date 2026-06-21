import type { FreeProxyItem, FreeProxySyncResult, FreeProxyProvider } from "./types";
import { isPrivateHost } from "@/shared/network/outboundUrlGuard";

const BASE_URL = "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols";
const PROTOCOLS = ["http", "https", "socks4", "socks5"] as const;

// In-module cache to respect GitHub raw rate limits
let lastFetchAt = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

type IplocateProxy = {
  ip: string;
  port: number;
  country: string;
};

export class IplocateProvider implements FreeProxyProvider {
  readonly id = "iplocate" as const;
  readonly name = "IPLocate";

  isEnabled(): boolean {
    // Default ON — opt out with FREE_PROXY_IPLOCATE_ENABLED=false
    return process.env.FREE_PROXY_IPLOCATE_ENABLED !== "false";
  }

  async sync(): Promise<FreeProxySyncResult> {
    if (!this.isEnabled()) {
      return {
        fetched: 0,
        added: 0,
        updated: 0,
        errors: ["IPLocate provider disabled (opt-in via FREE_PROXY_IPLOCATE_ENABLED=true)"],
      };
    }

    const now = Date.now();
    if (now - lastFetchAt < CACHE_TTL_MS) {
      return { fetched: 0, added: 0, updated: 0, errors: ["IPLocate: cache fresh, skipping sync"] };
    }

    const { upsertFreeProxy } = await import("../db/freeProxies");
    const baseUrl = process.env.FREE_PROXY_IPLOCATE_BASE_URL || BASE_URL;
    // When FREE_PROXY_COUNTRY_FILTER is set (default: US), only store matching proxies.
    const countryFilter = (process.env.FREE_PROXY_COUNTRY_FILTER ?? "US").toUpperCase() || null;
    const errors: string[] = [];
    let added = 0;
    let updated = 0;
    let fetched = 0;

    for (const proto of PROTOCOLS) {
      try {
        const url = `${baseUrl}/${proto}.json`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers:
            lastFetchAt > 0 ? { "If-Modified-Since": new Date(lastFetchAt).toUTCString() } : {},
        });

        if (res.status === 304) continue;
        if (!res.ok) {
          errors.push(`${proto}: HTTP ${res.status}`);
          continue;
        }

        const data = (await res.json()) as IplocateProxy[];
        if (!Array.isArray(data)) continue;

        for (const p of data) {
          if (!p.ip || !p.port) continue;
          if (isPrivateHost(p.ip)) {
            errors.push(`${proto}: skipped private/loopback host ${p.ip}`);
            continue;
          }
          const resolvedCountry = p.country?.slice(0, 2).toUpperCase() || null;
          if (countryFilter && resolvedCountry && resolvedCountry !== countryFilter) continue;
          const item: FreeProxyItem = {
            source: "iplocate",
            host: p.ip,
            port: Number(p.port),
            type: proto,
            countryCode: resolvedCountry,
            qualityScore: null,
            latencyMs: null,
            anonymity: null,
            lastValidated: new Date().toISOString(),
          };
          const r = await upsertFreeProxy(item);
          if (r.action === "created") added++;
          else updated++;
          fetched++;
        }
      } catch (err) {
        errors.push(`${proto}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    lastFetchAt = Date.now();
    return { fetched, added, updated, errors };
  }

  async list(filters: {
    protocol?: string;
    country?: string;
    minQuality?: number;
    limit?: number;
  }): Promise<FreeProxyItem[]> {
    const { listFreeProxiesBySource } = await import("../db/freeProxies");
    return listFreeProxiesBySource("iplocate", filters);
  }
}
