// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// The relay modals and the registry manager are heavy subtrees unrelated to
// this tab's own logic (deploy-relay dropdown + maintenance actions) — stub
// them so this test stays focused and fast.
vi.mock("@/app/(dashboard)/dashboard/settings/components/ProxyRegistryManager", () => ({
  default: () => <div data-testid="stub-registry" />,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/proxy/VercelRelayModal", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/proxy/DenoRelayModal", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/proxy/CloudflareRelayModal", () => ({
  default: () => null,
}));

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
}

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

async function renderTab() {
  const { default: ProxyPoolTab } = await import(
    "@/app/(dashboard)/dashboard/settings/components/proxy/ProxyPoolTab"
  );
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<ProxyPoolTab />);
  });
  containers.push({ root, el });
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => okJson({}))
  );
  vi.resetModules();
});

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ProxyPoolTab — Deploy Relay dropdown", () => {
  it("renders the Deploy Relay trigger when at least one relay is enabled", async () => {
    const el = await renderTab();
    expect(el.querySelector('[data-testid="proxy-pool-deploy-relay"]')).not.toBeNull();
  });

  it("opens the dropdown menu on click and shows relay items", async () => {
    const el = await renderTab();
    const trigger = el.querySelector('[data-testid="proxy-pool-deploy-relay"]')!;
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("vercelRelayButton");
    expect(el.textContent).toContain("denoRelayButton");
    expect(el.textContent).toContain("cloudflareRelayButton");
  });

  it("closes the dropdown on an outside click", async () => {
    const el = await renderTab();
    const trigger = el.querySelector('[data-testid="proxy-pool-deploy-relay"]')!;
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("vercelRelayButton");
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("vercelRelayButton");
  });

  it("hides the Deploy Relay trigger entirely when all relays are disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_RELAY_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_DENO_RELAY_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_CLOUDFLARE_RELAY_ENABLED", "false");
    const el = await renderTab();
    expect(el.querySelector('[data-testid="proxy-pool-deploy-relay"]')).toBeNull();
  });
});

describe("ProxyPoolTab — pool maintenance actions", () => {
  it("Test All & Remove Bad posts to /api/settings/proxies/egress", async () => {
    const mockFetch = vi.fn(() => okJson({ report: [{ alive: false }, { alive: true }] }));
    vi.stubGlobal("fetch", mockFetch);
    const el = await renderTab();
    const btn = el.querySelector('[data-testid="proxy-pool-remove-bad"]')!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      mockFetch.mock.calls.some(([url]) => String(url) === "/api/settings/proxies/egress")
    ).toBe(true);
  });

  it("Import Best from Free Pool posts to /api/settings/free-proxies/sync", async () => {
    const mockFetch = vi.fn(() => okJson({}));
    vi.stubGlobal("fetch", mockFetch);
    const el = await renderTab();
    const btn = el.querySelector('[data-testid="proxy-pool-import-best"]')!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      mockFetch.mock.calls.some(([url]) => String(url) === "/api/settings/free-proxies/sync")
    ).toBe(true);
  });
});

describe("ProxyPoolTab — SSR smoke (this file shipped broken once, #6260 class)", () => {
  it("server-renders without throwing", async () => {
    const { default: ProxyPoolTab } = await import(
      "@/app/(dashboard)/dashboard/settings/components/proxy/ProxyPoolTab"
    );
    expect(() => renderToString(React.createElement(ProxyPoolTab))).not.toThrow();
  });
});
