import type { FreeProxyItem, FreeProxySyncResult, FreeProxyProvider } from "./types";
import { isPrivateHost } from "@/shared/network/outboundUrlGuard";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

const DEFAULT_MAX = 1000;
const DEFAULT_COUNTRY_FILTER = "US";

/**
 * Proxy JSON entry from monosans/proxy-scraper-checker output.
 * Only the fields we need are typed; extra fields are ignored.
 */
interface ScraperJsonEntry {
  protocol: string;
  host: string;
  port: number;
  timeout: number; // response time in seconds
  geolocation?: {
    country?: {
      iso_code?: string;
    };
  };
  asn?: {
    autonomous_system_organization?: string;
  };
}

/**
 * ProxyScraperProvider integrates with monosans/proxy-scraper-checker
 * (https://github.com/monosans/proxy-scraper-checker)
 *
 * **Primary mode (JSON)**: Reads `proxies.json` or `proxies_pretty.json` which
 * contain per-proxy geolocation, ASN, and latency data from MaxMind databases.
 * Proxies are filtered by country code (default: US) and imported with accurate
 * metadata.
 *
 * **Fallback mode (TXT)**: If no JSON file is found, falls back to reading
 * plain-text `http.txt`, `socks4.txt`, `socks5.txt` files. In this mode,
 * proxies are tagged with the configured country code but lack real geo data.
 *
 * Env vars:
 *   FREE_PROXY_SCRAPER_ENABLED       — default true (opt-out via =false)
 *   FREE_PROXY_SCRAPER_JSON_FILE     — path to proxies.json (primary mode)
 *   FREE_PROXY_SCRAPER_HTTP_FILE     — fallback: path to http.txt
 *   FREE_PROXY_SCRAPER_SOCKS4_FILE   — fallback: path to socks4.txt
 *   FREE_PROXY_SCRAPER_SOCKS5_FILE   — fallback: path to socks5.txt
 *   FREE_PROXY_SCRAPER_MAX           — max proxies to import (default: 1000)
 *   FREE_PROXY_COUNTRY_FILTER        — ISO country code filter (default: US)
 */
export class ProxyScraperProvider implements FreeProxyProvider {
  readonly id = "proxyscraper" as const;
  readonly name = "ProxyScraper";

  isEnabled(): boolean {
    // Default ON — opt out with FREE_PROXY_SCRAPER_ENABLED=false
    return process.env.FREE_PROXY_SCRAPER_ENABLED !== "false";
  }

  private async getConfig() {
    let countryFilter = "";
    try {
      const { getSettings } = await import("../db/settings");
      const settings = await getSettings();
      countryFilter = (settings.freeProxyCountryFilter as string) || "";
    } catch {}

    if (!countryFilter) {
      countryFilter = (
        process.env.FREE_PROXY_COUNTRY_FILTER ?? DEFAULT_COUNTRY_FILTER
      ).toUpperCase();
    } else {
      countryFilter = countryFilter.toUpperCase();
    }

    const baseOutDir = "./proxy_scraper_data/out";
    const countrySubdir = `${baseOutDir}/proxies/${countryFilter}`;
    const useCountrySubdir = countryFilter !== "ALL" && existsSync(`${countrySubdir}/http.txt`);
    return {
      // Primary: JSON file with geolocation data
      jsonFile: process.env.FREE_PROXY_SCRAPER_JSON_FILE || `${baseOutDir}/proxies.json`,
      // Fallback: flat text files
      httpFile:
        process.env.FREE_PROXY_SCRAPER_HTTP_FILE ||
        (useCountrySubdir ? `${countrySubdir}/http.txt` : `${baseOutDir}/http.txt`),
      socks4File:
        process.env.FREE_PROXY_SCRAPER_SOCKS4_FILE ||
        (useCountrySubdir ? `${countrySubdir}/socks4.txt` : `${baseOutDir}/socks4.txt`),
      socks5File:
        process.env.FREE_PROXY_SCRAPER_SOCKS5_FILE ||
        (useCountrySubdir ? `${countrySubdir}/socks5.txt` : `${baseOutDir}/socks5.txt`),
      maxProxies: parseInt(process.env.FREE_PROXY_SCRAPER_MAX || "", 10) || DEFAULT_MAX,
      countryCode: countryFilter === "ALL" ? null : countryFilter || null,
    };
  }

  /**
   * Compute a 0-100 quality score from response latency.
   * Sub-second proxies score highest; anything over 10s gets minimum.
   */
  private latencyToQuality(timeoutSec: number): number {
    if (timeoutSec <= 0.1) return 95;
    if (timeoutSec <= 0.5) return 85;
    if (timeoutSec <= 1.0) return 75;
    if (timeoutSec <= 2.0) return 65;
    if (timeoutSec <= 5.0) return 50;
    if (timeoutSec <= 10.0) return 35;
    return 20;
  }

  /**
   * Normalize protocol string from the scraper JSON to our internal type.
   * monosans outputs "http", "socks4", "socks5". We treat "https" same as "http"
   * for proxy type purposes.
   */
  private normalizeProtocol(protocol: string): "http" | "https" | "socks4" | "socks5" {
    const p = protocol.toLowerCase();
    if (p === "socks4") return "socks4";
    if (p === "socks5") return "socks5";
    if (p === "https") return "https";
    return "http";
  }

  // ---------------------------------------------------------------------------
  // Primary mode: JSON with geolocation filtering
  // ---------------------------------------------------------------------------

  private async syncFromJson(
    jsonPath: string,
    config: Awaited<ReturnType<typeof this.getConfig>>
  ): Promise<FreeProxySyncResult> {
    const { upsertFreeProxy } = await import("../db/freeProxies");
    const errors: string[] = [];
    let added = 0;
    let updated = 0;
    let fetched = 0;
    let filtered = 0;

    const content = await readFile(jsonPath, "utf-8");
    let entries: ScraperJsonEntry[];
    try {
      entries = JSON.parse(content) as ScraperJsonEntry[];
    } catch {
      return { fetched: 0, added: 0, updated: 0, errors: ["Invalid JSON in scraper output"] };
    }

    if (!Array.isArray(entries)) {
      return { fetched: 0, added: 0, updated: 0, errors: ["JSON is not an array"] };
    }

    fetched = entries.length;

    for (const entry of entries) {
      // --- Country filter: only import proxies from the configured country ---
      const isoCode = entry.geolocation?.country?.iso_code?.toUpperCase() ?? null;

      if (config.countryCode && isoCode !== config.countryCode) {
        filtered++;
        continue;
      }

      // --- Validate host/port ---
      const host = entry.host;
      const port = entry.port;

      if (!host || !port || typeof port !== "number" || isPrivateHost(host)) {
        errors.push(`proxyscraper: skipped invalid/private host ${host}`);
        continue;
      }

      // --- Enforce per-protocol import limit ---
      if (added + updated >= config.maxProxies) break;

      const latencyMs = typeof entry.timeout === "number" ? Math.round(entry.timeout * 1000) : null;

      const item: FreeProxyItem = {
        source: "proxyscraper",
        host,
        port,
        type: this.normalizeProtocol(entry.protocol),
        countryCode: isoCode,
        qualityScore: typeof entry.timeout === "number" ? this.latencyToQuality(entry.timeout) : 60,
        latencyMs,
        anonymity: "anonymous",
        lastValidated: new Date().toISOString(),
      };

      const result = await upsertFreeProxy(item);
      if (result.action === "created") added++;
      else if (result.action === "updated") updated++;
    }

    if (filtered > 0) {
      errors.push(
        `Filtered out ${filtered} non-${config.countryCode} proxies (${fetched} total, ${fetched - filtered} matched)`
      );
    }

    return { fetched, added, updated, errors };
  }

  // ---------------------------------------------------------------------------
  // Fallback mode: flat text files (no geolocation data)
  // ---------------------------------------------------------------------------

  private async syncFromTxtFiles(
    config: Awaited<ReturnType<typeof this.getConfig>>
  ): Promise<FreeProxySyncResult> {
    const { upsertFreeProxy } = await import("../db/freeProxies");
    const errors: string[] = [];
    let added = 0;
    let updated = 0;
    let fetched = 0;

    const files = [
      { path: config.httpFile, type: "http" as const },
      { path: config.socks4File, type: "socks4" as const },
      { path: config.socks5File, type: "socks5" as const },
    ];

    for (const { path, type } of files) {
      try {
        if (!existsSync(path)) {
          errors.push(`File not found: ${path}`);
          continue;
        }

        const content = await readFile(path, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        const proxies = lines.slice(0, config.maxProxies);
        fetched += proxies.length;

        for (const line of proxies) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;

          const [host, portStr] = trimmed.split(":");
          const port = parseInt(portStr, 10);

          if (!host || !port || isNaN(port) || isPrivateHost(host)) {
            errors.push(`proxyscraper: skipped invalid/private host ${host}`);
            continue;
          }

          const item: FreeProxyItem = {
            source: "proxyscraper",
            host,
            port,
            type,
            // Tag with the configured country so the freeProxyJob can promote them
            countryCode: config.countryCode,
            qualityScore: 60, // proxy-scraper-checker validates these
            latencyMs: null,
            anonymity: "anonymous",
            lastValidated: new Date().toISOString(),
          };

          const result = await upsertFreeProxy(item);
          if (result.action === "created") added++;
          else if (result.action === "updated") updated++;
        }
      } catch (err) {
        errors.push(`${type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { fetched, added, updated, errors };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async sync(): Promise<FreeProxySyncResult> {
    if (!this.isEnabled()) {
      return { fetched: 0, added: 0, updated: 0, errors: ["ProxyScraper provider disabled"] };
    }

    const config = await this.getConfig();

    // Primary: try JSON file with geolocation data
    if (existsSync(config.jsonFile)) {
      return this.syncFromJson(config.jsonFile, config);
    }

    // Fallback: flat text files (no per-proxy country filtering)
    return this.syncFromTxtFiles(config);
  }

  async list(filters: {
    protocol?: string;
    country?: string;
    minQuality?: number;
    limit?: number;
  }): Promise<FreeProxyItem[]> {
    const { listFreeProxiesBySource } = await import("../db/freeProxies");
    return listFreeProxiesBySource("proxyscraper", filters);
  }
}
