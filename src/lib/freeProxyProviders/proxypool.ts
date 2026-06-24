import type { FreeProxyItem, FreeProxySyncResult, FreeProxyProvider } from "./types";
import { isPrivateHost } from "@/shared/network/outboundUrlGuard";

const DEFAULT_API_URL = "http://localhost:5010";
const DEFAULT_MAX = 500;

type ProxyPoolProxy = {
  proxy: string; // format: "ip:port"
};

export class ProxyPoolProvider implements FreeProxyProvider {
  readonly id = "proxypool" as const;
  readonly name = "ProxyPool";

  isEnabled(): boolean {
    // Default ON — opt out with FREE_PROXY_PROXYPOOL_ENABLED=false
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
    const errors: string[] = [];
    let added = 0;
    let updated = 0;

    try {
      const res = await fetch(`${apiUrl}/get_all/`, { signal: AbortSignal.timeout(30000) });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        errors.push(`HTTP ${res.status}: ${text.slice(0, 100)}`);
        return { fetched: 0, added: 0, updated: 0, errors };
      }

      const proxies = (await res.json()) as ProxyPoolProxy[];
      if (!Array.isArray(proxies)) {
        errors.push("Invalid response format");
        return { fetched: 0, added: 0, updated: 0, errors };
      }

      const limitedProxies = proxies.slice(0, maxProxies);

      for (const p of limitedProxies) {
        const [host, portStr] = p.proxy.split(":");
        const port = parseInt(portStr, 10);

        if (!host || !port || isPrivateHost(host)) {
          errors.push(`proxypool: skipped invalid/private host ${host}`);
          continue;
        }

        const item: FreeProxyItem = {
          source: "proxypool",
          host,
          port,
          type: "http",
          countryCode: null,
          qualityScore: 50,
          latencyMs: null,
          anonymity: null,
          lastValidated: new Date().toISOString(),
        };

        const result = await upsertFreeProxy(item);
        if (result.action === "created") added++;
        else if (result.action === "updated") updated++;
      }

      return { fetched: limitedProxies.length, added, updated, errors };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return { fetched: 0, added, updated, errors };
    }
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
