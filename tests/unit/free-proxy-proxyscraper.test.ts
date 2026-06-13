import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProxyScraperProvider } from "@/lib/freeProxyProviders/proxyscraper";
import type { FreeProxyItem } from "@/lib/freeProxyProviders/types";

vi.mock("fs/promises");
vi.mock("fs");
vi.mock("@/lib/db/freeProxies");

describe("ProxyScraperProvider", () => {
  let provider: ProxyScraperProvider;

  beforeEach(() => {
    provider = new ProxyScraperProvider();
    vi.clearAllMocks();
  });

  describe("basic properties", () => {
    it("should have correct id", () => {
      expect(provider.id).toBe("proxyscraper");
    });

    it("should have correct name", () => {
      expect(provider.name).toBe("ProxyScraper");
    });
  });

  describe("isEnabled", () => {
    it("should return false when env var is not set", () => {
      delete process.env.FREE_PROXY_SCRAPER_ENABLED;
      expect(provider.isEnabled()).toBe(false);
    });

    it("should return true when env var is 'true'", () => {
      process.env.FREE_PROXY_SCRAPER_ENABLED = "true";
      expect(provider.isEnabled()).toBe(true);
    });

    it("should return false when env var is 'false'", () => {
      process.env.FREE_PROXY_SCRAPER_ENABLED = "false";
      expect(provider.isEnabled()).toBe(false);
    });
  });

  describe("sync", () => {
    it("should return error when disabled", async () => {
      delete process.env.FREE_PROXY_SCRAPER_ENABLED;

      const result = await provider.sync();

      expect(result).toEqual({
        fetched: 0,
        added: 0,
        updated: 0,
        errors: ["ProxyScraper provider disabled"],
      });
    });

    it("should parse proxy files correctly", async () => {
      process.env.FREE_PROXY_SCRAPER_ENABLED = "true";

      const mockFileContent = "1.2.3.4:8080\n5.6.7.8:3128\n# comment\n\n9.10.11.12:80";

      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const { upsertFreeProxy } = await import("@/lib/db/freeProxies");

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(mockFileContent);
      vi.mocked(upsertFreeProxy).mockResolvedValue({ id: "test-id", action: "created" });

      const result = await provider.sync();

      expect(result.fetched).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
    });

    it("should skip invalid proxy formats", async () => {
      process.env.FREE_PROXY_SCRAPER_ENABLED = "true";

      const mockFileContent = "invalid\n:8080\n1.2.3.4:\n1.2.3.4:abc";

      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(mockFileContent);

      const result = await provider.sync();

      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should skip private IP addresses", async () => {
      process.env.FREE_PROXY_SCRAPER_ENABLED = "true";

      const mockFileContent = "192.168.1.1:8080\n10.0.0.1:3128\n172.16.0.1:80";

      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(mockFileContent);

      const result = await provider.sync();

      expect(result.errors.some((e) => e.includes("private"))).toBe(true);
    });

    it("should handle file not found gracefully", async () => {
      process.env.FREE_PROXY_SCRAPER_ENABLED = "true";

      const { existsSync } = await import("fs");
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await provider.sync();

      expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
    });

    it("should respect max proxies limit", async () => {
      process.env.FREE_PROXY_SCRAPER_ENABLED = "true";
      process.env.FREE_PROXY_SCRAPER_MAX = "2";

      const mockFileContent = Array.from({ length: 100 }, (_, i) => `1.2.3.${i}:8080`).join("\n");

      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const { upsertFreeProxy } = await import("@/lib/db/freeProxies");

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(mockFileContent);
      vi.mocked(upsertFreeProxy).mockResolvedValue({ id: "test-id", action: "created" });

      const result = await provider.sync();

      expect(result.fetched).toBeLessThanOrEqual(6); // 2 per file type * 3 types
    });
  });

  describe("list", () => {
    it("should call listFreeProxiesBySource with correct parameters", async () => {
      const { listFreeProxiesBySource } = await import("@/lib/db/freeProxies");
      vi.mocked(listFreeProxiesBySource).mockResolvedValue([]);

      const filters = { protocol: "http", limit: 10 };
      await provider.list(filters);

      expect(listFreeProxiesBySource).toHaveBeenCalledWith("proxyscraper", filters);
    });

    it("should return proxies from database", async () => {
      const mockProxies: FreeProxyItem[] = [
        {
          source: "proxyscraper",
          host: "1.2.3.4",
          port: 8080,
          type: "http",
          countryCode: "US",
          qualityScore: 60,
          latencyMs: 100,
          anonymity: "anonymous",
          lastValidated: new Date().toISOString(),
        },
      ];

      const { listFreeProxiesBySource } = await import("@/lib/db/freeProxies");
      vi.mocked(listFreeProxiesBySource).mockResolvedValue(mockProxies);

      const result = await provider.list({});

      expect(result).toEqual(mockProxies);
    });
  });

  describe("configuration", () => {
    it("should use environment variables for file paths", () => {
      process.env.FREE_PROXY_SCRAPER_HTTP_FILE = "/custom/http.txt";
      process.env.FREE_PROXY_SCRAPER_SOCKS4_FILE = "/custom/socks4.txt";
      process.env.FREE_PROXY_SCRAPER_SOCKS5_FILE = "/custom/socks5.txt";

      const config = (provider as any).getConfig();

      expect(config.httpFile).toBe("/custom/http.txt");
      expect(config.socks4File).toBe("/custom/socks4.txt");
      expect(config.socks5File).toBe("/custom/socks5.txt");
    });

    it("should use default file paths when env vars not set", () => {
      delete process.env.FREE_PROXY_SCRAPER_HTTP_FILE;
      delete process.env.FREE_PROXY_SCRAPER_SOCKS4_FILE;
      delete process.env.FREE_PROXY_SCRAPER_SOCKS5_FILE;

      const config = (provider as any).getConfig();

      expect(config.httpFile).toBe("./proxies/http.txt");
      expect(config.socks4File).toBe("./proxies/socks4.txt");
      expect(config.socks5File).toBe("./proxies/socks5.txt");
    });

    it("should parse max proxies from env var", () => {
      process.env.FREE_PROXY_SCRAPER_MAX = "500";

      const config = (provider as any).getConfig();

      expect(config.maxProxies).toBe(500);
    });

    it("should use default max when env var is invalid", () => {
      process.env.FREE_PROXY_SCRAPER_MAX = "invalid";

      const config = (provider as any).getConfig();

      expect(config.maxProxies).toBe(1000);
    });
  });
});
