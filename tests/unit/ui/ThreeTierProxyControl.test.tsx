// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const { default: ThreeTierProxyControl } = await import(
  "@/app/(dashboard)/dashboard/settings/components/proxy/ThreeTierProxyControl"
);

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
}

const SNAPSHOT = {
  tiers: {
    tier1: [
      {
        id: "p1",
        tier: 1,
        type: "http",
        host: "1.2.3.4",
        port: 8080,
        source: "proxyscraper",
        country_code: "US",
        quality_score: 40,
        latency_ms: 120,
        in_pool: 0,
        pool_proxy_id: null,
        test_count: 3,
        success_count: 3,
        consecutive_successes: 3,
        consecutive_failures: 0,
        last_validated: null,
        updated_at: "2026-07-01T00:00:00Z",
      },
    ],
    tier2: [],
    tier3: [],
  },
  counts: { tier1: 1, tier2: 0, tier3: 0 },
  source: "omniroute",
  globalPoolCount: 0,
  lastSyncedAt: null,
};

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function renderControl() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<ThreeTierProxyControl />);
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

describe("ThreeTierProxyControl", () => {
  it("loads the snapshot from /api/admin/proxy-control on mount", async () => {
    const mockFetch = vi.fn(() => okJson(SNAPSHOT));
    vi.stubGlobal("fetch", mockFetch);
    renderControl();
    await waitForCondition(() =>
      mockFetch.mock.calls.some(([url]) => String(url).includes("/api/admin/proxy-control"))
    );
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes("/api/admin/proxy-control"))
    ).toBe(true);
  });

  it("renders tier rule text for all three tiers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => okJson(SNAPSHOT))
    );
    const el = renderControl();
    await waitForCondition(() => el.textContent?.includes("1.2.3.4:8080") === true);
    expect(el.textContent).toContain("proxyTierIntakeRule");
    expect(el.textContent).toContain("proxyTierVerifiedRule");
    expect(el.textContent).toContain("proxyTierActiveRule");
  });

  it("selects a row and enables Delete selected in the toolbar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => okJson(SNAPSHOT))
    );
    const el = renderControl();
    await waitForCondition(() => el.textContent?.includes("1.2.3.4:8080") === true);

    const rowCheckbox = el.querySelector(
      'input[aria-label="Select 1.2.3.4:8080"]'
    ) as HTMLInputElement;
    expect(rowCheckbox).not.toBeNull();
    act(() => {
      rowCheckbox.click();
    });

    const deleteBtn = el.querySelector(
      '[data-testid="selection-toolbar-delete-selected"]'
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(false);
  });

  it("selecting all rows via the toolbar select-all button selects every tier row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => okJson(SNAPSHOT))
    );
    const el = renderControl();
    await waitForCondition(() => el.textContent?.includes("1.2.3.4:8080") === true);

    const selectAllBtn = el.querySelector('[data-testid="selection-toolbar-select-all"]')!;
    act(() => {
      selectAllBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const rowCheckbox = el.querySelector(
      'input[aria-label="Select 1.2.3.4:8080"]'
    ) as HTMLInputElement;
    expect(rowCheckbox.checked).toBe(true);
  });

  it("delete selected opens a confirm modal, and confirming posts the remove action", async () => {
    const mockFetch = vi.fn((url: string) => {
      if (String(url).includes("/actions")) return okJson({ applied: 1, skipped: 0 });
      return okJson(SNAPSHOT);
    });
    vi.stubGlobal("fetch", mockFetch);
    const el = renderControl();
    await waitForCondition(() => el.textContent?.includes("1.2.3.4:8080") === true);

    const rowCheckbox = el.querySelector(
      'input[aria-label="Select 1.2.3.4:8080"]'
    ) as HTMLInputElement;
    act(() => {
      rowCheckbox.click();
    });

    const deleteBtn = el.querySelector('[data-testid="selection-toolbar-delete-selected"]')!;
    act(() => {
      deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Confirm modal should now be open — find its confirm button (icon-less,
    // labeled with the same delete-selected key) and click it.
    await waitForCondition(() =>
      Array.from(el.querySelectorAll("button")).some(
        (b) => b.textContent === "proxyTierDeleteSelected"
      )
    );
    const confirmButtons = Array.from(el.querySelectorAll("button")).filter(
      (b) => b.textContent === "proxyTierDeleteSelected"
    );
    // last one rendered is the modal's confirm action
    act(() => {
      confirmButtons[confirmButtons.length - 1].dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });

    await waitForCondition(() =>
      mockFetch.mock.calls.some(([url]) => String(url).includes("/actions"))
    );
    const actionCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/actions"))!;
    const body = JSON.parse((actionCall[1] as RequestInit).body as string);
    expect(body.action).toBe("remove");
    expect(body.selectionKeys).toEqual(["tier1:p1"]);
  });
});
