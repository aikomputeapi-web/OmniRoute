import type { FreeProxyItem, FreeProxySyncResult, FreeProxyProvider } from "./types";
import { isPrivateHost } from "@/shared/network/outboundUrlGuard";
import { isProviderEnabled } from "./index";

const DEFAULT_API_URL = "https://proxylist.geonode.com/api/proxy/list";
const DEFAULT_MAX = 500;
const DEFAULT_TIMEOUT_MS = 15000;

type GeoNodeProxy = {
  ip: string;
  port: number;
  protocols: string[];
  country: string;
  speed: number;
  anonymityLevel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

type GeoNodeResponse = {
  data: GeoNodeProxy[];
  total: number;
  page: number;
  limit: number;
};

export class IplocateProvider implements FreeProxyProvider {
  readonly id = "iplocate" as const;
  readonly name = "IPLocate";

  isEnabled(): boolean {
    // Opt-in (default OFF): iplocate fetches 0 proxies and errors on every sync,
    // contributing nothing while adding sync latency. Enable with
    // FREE_PROXY_IPLOCATE_ENABLED=true or the UI toggle.
    return isProviderEnabled(this.id, "FREE_PROXY_IPLOCATE_ENABLED", false);
  }

  private getConfig() {
    return {
      apiUrl: process.env.FREE_PROXY_IPLOCATE_BASE_URL || DEFAULT_API_URL,
      maxProxies: parseInt(process.env.FREE_PROXY_IPLOCATE_MAX || "", 10) || DEFAULT_MAX,
    };
  }

  async sync(): Promise<FreeProxySyncResult> {
    if (!this.isEnabled()) {
      return { fetched: 0, added: 0, updated: 0, errors: ["IPLocate provider disabled"] };
    }

    const { upsertFreeProxy } = await import("../db/freeProxies");
    const { apiUrl, maxProxies } = this.getConfig();
    let countryFilter = "";
    try {
      const { getSettings } = await import("../db/settings");
      const settings = await getSettings();
      countryFilter = (settings.freeProxyCountryFilter as string) || "";
    } catch {}

    if (!countryFilter) {
      countryFilter = (process.env.FREE_PROXY_COUNTRY_FILTER ?? "US").toUpperCase();
    } else {
      countryFilter = countryFilter.toUpperCase();
    }

    const errors: string[] = [];
    let added = 0;
    let updated = 0;
    let fetched = 0;

    try {
      const params = new URLSearchParams({
        limit: String(Math.min(maxProxies, 500)),
        page: "1",
        sort_by: "speed",
        sort_type: "asc",
        speeds: "fastest",
      });

      if (countryFilter && countryFilter !== "ALL") {
        params.set("country", countryFilter);
      }

      const url = `${apiUrl}?${params.toString()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        errors.push(`HTTP ${res.status}: ${text.slice(0, 100)}`);
        return { fetched: 0, added: 0, updated: 0, errors };
      }

      const json = (await res.json()) as GeoNodeResponse;
      if (!Array.isArray(json.data)) {
        errors.push("Invalid response format");
        return { fetched: 0, added: 0, updated: 0, errors };
      }

      for (const p of json.data) {
        if (!p.ip || !p.port || isPrivateHost(p.ip)) {
          errors.push(`geonode: skipped invalid/private host ${p.ip}`);
          continue;
        }

        const protocols = p.protocols || ["http"];
        for (const proto of protocols) {
          const normalizedType =
            proto.toLowerCase() === "https"
              ? "https"
              : proto.toLowerCase() === "socks5"
                ? "socks5"
                : proto.toLowerCase() === "socks4"
                  ? "socks4"
                  : "http";

          const item: FreeProxyItem = {
            source: "iplocate",
            host: p.ip,
            port: Number(p.port),
            type: normalizedType as FreeProxyItem["type"],
            countryCode: p.country?.slice(0, 2).toUpperCase() || null,
            qualityScore: p.speed
              ? Math.min(100, Math.max(0, Math.round((1 - p.speed / 10000) * 100)))
              : 50,
            latencyMs: p.speed ?? null,
            anonymity: p.anonymityLevel || null,
            lastValidated: new Date().toISOString(),
          };

          const r = await upsertFreeProxy(item);
          if (r.action === "created") added++;
          else if (r.action === "updated") updated++;
          if (r.action !== "skipped") fetched++;
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

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
