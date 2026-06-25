import type { FreeProxyItem, FreeProxySyncResult, FreeProxyProvider } from "./types";
import { isPrivateHost } from "@/shared/network/outboundUrlGuard";

const DEFAULT_API_URL = "https://api.proxyscrape.com/v2";
const DEFAULT_MAX = 500;
const DEFAULT_TIMEOUT_MS = 30000;
const PROTOCOLS = ["http", "socks4", "socks5"] as const;

export class ProxyPoolProvider implements FreeProxyProvider {
  readonly id = "proxypool" as const;
  readonly name = "ProxyPool";

  isEnabled(): boolean {
    return process.env.FREE_PROXY_PROXYPOOL_ENABLED !== "false";
  }

  private getConfig() {
    return {
      apiUrl: process.env.FREE_PROXY_PROXYPOOL_API_URL || DEFAULT_API_URL,
      maxProxies: parseInt(process.env.FREE_PROXY_PROXYPOOL_MAX || "", 10) || DEFAULT_MAX,
    };
  }

  async sync(): Promise<FreeProxySyncResult> {
    if (!this.isEnabled()) {
      return { fetched: 0, added: 0, updated: 0, errors: ["ProxyPool provider disabled"] };
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

    for (const protocol of PROTOCOLS) {
      try {
        const params = new URLSearchParams({
          request: "displayproxies",
          protocol,
          timeout: "10000",
          country: countryFilter !== "ALL" ? countryFilter.toLowerCase() : "all",
          ssl: "all",
          anonymity: "all",
        });

        const url = `${apiUrl}/?${params.toString()}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });

        if (!res.ok) {
          errors.push(`${protocol}: HTTP ${res.status}`);
          continue;
        }

        const text = await res.text();
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

        let protocolAdded = 0;
        for (const line of lines) {
          if (protocolAdded >= maxProxies) break;

          const [host, portStr] = line.split(":");
          if (!host || !portStr) continue;

          const port = parseInt(portStr, 10);
          if (!port || isNaN(port) || isPrivateHost(host)) continue;

          const item: FreeProxyItem = {
            source: "proxypool",
            host,
            port,
            type: protocol === "http" ? "http" : protocol as FreeProxyItem["type"],
            countryCode: countryFilter !== "ALL" ? countryFilter : null,
            qualityScore: 60,
            latencyMs: null,
            anonymity: protocol === "http" ? "anonymous" : null,
            lastValidated: new Date().toISOString(),
          };

          const result = await upsertFreeProxy(item);
          if (result.action === "created") added++;
          else if (result.action === "updated") updated++;
          if (result.action !== "skipped") fetched++;
          protocolAdded++;
        }
      } catch (err) {
        errors.push(`${protocol}: ${err instanceof Error ? err.message : String(err)}`);
      }
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
    return listFreeProxiesBySource("proxypool", filters);
  }
}
