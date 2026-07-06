// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/dashboard/system/proxy",
  useSearchParams: () => new URLSearchParams(),
}));

const { default: OverviewTab } = await import(
  "@/app/(dashboard)/dashboard/settings/components/proxy/OverviewTab"
);

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
}

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function renderOverview() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<OverviewTab />);
  });
  containers.push({ root, el });
  return el;
}

async function waitForCondition(fn: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitForCondition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("OverviewTab", () => {
  it("renders stat values once all fetches resolve", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/proxies/pool")) return okJson({ items: [{}, {}] });
        if (String(url).includes("/api/settings/proxies")) return okJson({ items: [{}] });
        if (String(url).includes("/free-proxies/stats"))
          return okJson({ stats: { total: 10, inPool: 3, avgQuality: 55 } });
        if (String(url).includes("/proxy-control"))
          return okJson({ counts: { tier1: 2, tier2: 1, tier3: 3 } });
        if (String(url).includes("/api/settings")) return okJson({ freeProxyAutoJobEnabled: true });
        return okJson({});
      })
    );
    const el = renderOverview();
    await waitForCondition(() => el.textContent?.includes("2 / 1 / 3") === true);
    expect(el.textContent).toContain("2 / 1 / 3");
  });

  it("shows a dash placeholder when a fetch fails, instead of crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down")))
    );
    const el = renderOverview();
    await waitForCondition(() => el.textContent?.includes("—") === true);
    expect(el.textContent).toContain("—");
  });

  it("navigates to the options tab when the automation link is clicked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => okJson({}))
    );
    const el = renderOverview();
    await waitForCondition(() =>
      Array.from(el.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("proxyOverviewGoToOptions")
      )
    );
    const btn = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("proxyOverviewGoToOptions")
    )!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(replaceMock).toHaveBeenCalledWith(
      expect.stringContaining("tab=options"),
      expect.anything()
    );
  });
});
