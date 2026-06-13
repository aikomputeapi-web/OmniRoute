import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProxyPoolProvider } from "@/lib/freeProxyProviders/proxypool";

describe("ProxyPoolProvider", () => {
  let provider: ProxyPoolProvider;

  beforeEach(() => {
    provider = new ProxyPoolProvider();
    vi.clearAllMocks();
  });

  it("should have correct id and name", () => {
    expect(provider.id).toBe("proxypool");
    expect(provider.name).toBe("ProxyPool");
  });

  it("should be disabled by default", () => {
    delete process.env.FREE_PROXY_PROXYPOOL_ENABLED;
    expect(provider.isEnabled()).toBe(false);
  });

  it("should be enabled when env var is true", () => {
    process.env.FREE_PROXY_PROXYPOOL_ENABLED = "true";
    expect(provider.isEnabled()).toBe(true);
  });

  describe("sync", () => {
    it("should return disabled error when provider is disabled", async () => {
      delete process.env.FREE_PROXY_PROXYPOOL_ENABLED;
      const result = await provider.sync();
      
      expect(result.fetched).toBe(0);
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.errors).toContain("ProxyPool provider disabled");
    });

    it("should fetch and parse proxies from API", async () => {
      process.env.FREE_PROXY_PROXYPOOL_ENABLED = "true";
      process.env.FREE_PROXY_PROXYPOOL_API_URL = "http://test:5010";

      const mockProxies = [
        { proxy: "1.2.3.4:8080" },
        { proxy: "5.6.7.8:3128" },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockProxies,
      });

      const mockUpsert = vi.fn()
        .mockResolvedValueOnce({ action: "created" })
        .mockResolvedValueOnce({ action: "updated" });

      vi.doMock("@/lib/db/freeProxies", () => ({
        upsertFreeProxy: mockUpsert,
      }));

      const result = await provider.sync();

      expect(result.fetched).toBe(2);
      expect(result.added).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors.length).toBe(0);
    });

    it("should handle fetch errors gracefully", async () => {
      process.env.FREE_PROXY_PROXYPOOL_ENABLED = "true";

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await provider.sync();

      expect(result.fetched).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("HTTP 500");
    });

    it("should skip private/loopback IPs", async () => {
      process.env.FREE_PROXY_PROXYPOOL_ENABLED = "true";

      const mockProxies = [
        { proxy: "127.0.0.1:8080" },
        { proxy: "10.0.0.1:3128" },
        { proxy: "8.8.8.8:8080" },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockProxies,
      });

      const mockUpsert = vi.fn().mockResolvedValue({ action: "created" });

      vi.doMock("@/lib/db/freeProxies", () => ({
        upsertFreeProxy: mockUpsert,
      }));

      const result = await provider.sync();

      expect(result.errors.some(e => e.includes("private"))).toBe(true);
      expect(mockUpsert).toHaveBeenCalledTimes(1);
    });

    it("should respect max proxies limit", async () => {
      process.env.FREE_PROXY_PROXYPOOL_ENABLED = "true";
      process.env.FREE_PROXY_PROXYPOOL_MAX = "2";

      const mockProxies = [
        { proxy: "1.2.3.4:8080" },
        { proxy: "5.6.7.8:3128" },
        { proxy: "9.10.11.12:8888" },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockProxies,
      });

      const mockUpsert = vi.fn().mockResolvedValue({ action: "created" });

      vi.doMock("@/lib/db/freeProxies", () => ({
        upsertFreeProxy: mockUpsert,
      }));

      const result = await provider.sync();

      expect(result.fetched).toBe(2);
    });
  });

  describe("list", () => {
    it("should list proxies from database", async () => {
      const mockList = vi.fn().mockResolvedValue([
        {
          source: "proxypool",
          host: "1.2.3.4",
          port: 8080,
          type: "http",
          countryCode: null,
          qualityScore: 50,
          latencyMs: null,
          anonymity: null,
          lastValidated: "2024-01-01T00:00:00Z",
        },
      ]);

      vi.doMock("@/lib/db/freeProxies", () => ({
        listFreeProxiesBySource: mockList,
      }));

      const result = await provider.list({ limit: 10 });

      expect(result).toHaveLength(1);
      expect(mockList).toHaveBeenCalledWith("proxypool", { limit: 10 });
    });
  });
});
