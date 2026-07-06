// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Stub localStorage before importing the component
const lsStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => {
    lsStore[k] = v;
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k in lsStore) delete lsStore[k];
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ── Import component after mocks ─────────────────────────────────────────────

const { default: FreePoolTab } =
  await import("../../src/app/(dashboard)/dashboard/settings/components/proxy/FreePoolTab");

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultStats = { total: 0, inPool: 0, avgQuality: null, lastSyncAt: null };

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
}

function setupFetch(items: unknown[] = [], stats = defaultStats) {
  const mockFetch = vi.fn((url: string) => {
    if (String(url).includes("/stats")) return okJson({ stats });
    return okJson({ items });
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function renderTab() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<FreePoolTab />);
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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
  setupFetch();
});

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FreePoolTab source toggles", () => {
  it("renders a toggle group with exactly 3 buttons", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    const bar = el.querySelector("[role='group']")!;
    expect(bar).toBeTruthy();
    const buttons = bar.querySelectorAll("button");
    expect(buttons.length).toBe(3);
  });

  it("all toggles start enabled (aria-pressed=true)", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    const buttons = Array.from(el.querySelector("[role='group']")!.querySelectorAll("button"));
    buttons.forEach((btn) => expect(btn.getAttribute("aria-pressed")).toBe("true"));
  });

  it("clicking a toggle disables it (aria-pressed=false)", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    const bar = el.querySelector("[role='group']")!;
    const first = bar.querySelectorAll("button")[0];
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(first.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking a disabled toggle re-enables it", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    const bar = el.querySelector("[role='group']")!;
    const first = bar.querySelectorAll("button")[0];
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(first.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(first.getAttribute("aria-pressed")).toBe("true");
  });

  it("multiple sources can be disabled independently", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    const buttons = el.querySelector("[role='group']")!.querySelectorAll("button");
    act(() => {
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      buttons[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true"); // second still enabled
    expect(buttons[2].getAttribute("aria-pressed")).toBe("false");
  });

  it("disabled source is persisted in localStorage", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    const first = el.querySelector("[role='group']")!.querySelectorAll("button")[0];
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const stored = JSON.parse(localStorageMock.getItem("freePool.disabledSources") ?? "[]");
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toContain("1proxy");
  });

  it("button labels are 1proxy, Proxifly, IPLocate", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    const texts = Array.from(el.querySelector("[role='group']")!.querySelectorAll("button")).map(
      (b) => b.textContent?.trim()
    );
    expect(texts).toContain("1proxy");
    expect(texts).toContain("Proxifly");
    expect(texts).toContain("IPLocate");
  });
});

describe("FreePoolTab data loading", () => {
  it("shows 'No proxies found' message when list is empty", async () => {
    const el = renderTab();
    await waitForCondition(() => el.textContent?.includes("No proxies found") === true);
    expect(el.textContent).toMatch(/No proxies found/i);
  });

  it("calls /api/settings/free-proxies on mount", async () => {
    const mockFetch = setupFetch();
    renderTab();
    await waitForCondition(() =>
      mockFetch.mock.calls.some(([url]) => String(url).includes("/free-proxies"))
    );
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/free-proxies"))).toBe(true);
  });

  it("calls /api/settings/free-proxies/stats on mount", async () => {
    const mockFetch = setupFetch();
    renderTab();
    await waitForCondition(() =>
      mockFetch.mock.calls.some(([url]) => String(url).includes("/stats"))
    );
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/stats"))).toBe(true);
  });

  it("disabling a source re-fetches with sources= filter", async () => {
    const mockFetch = vi.fn((url: string) => {
      if (String(url).includes("/stats")) return okJson({ stats: defaultStats });
      return okJson({ items: [] });
    });
    vi.stubGlobal("fetch", mockFetch);

    const el = renderTab();
    // Wait for initial load
    await waitForCondition(() =>
      mockFetch.mock.calls.some(([url]) => String(url).includes("/free-proxies"))
    );

    const initialCallCount = mockFetch.mock.calls.length;

    const bar = el.querySelector("[role='group']")!;
    const first = bar.querySelectorAll("button")[0]; // disable 1proxy
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForCondition(() => mockFetch.mock.calls.length > initialCallCount);

    const proxiesCalls = mockFetch.mock.calls
      .slice(initialCallCount)
      .map(([url]) => String(url))
      .filter((u) => u.includes("/free-proxies?") && !u.includes("/stats"));

    expect(proxiesCalls.length).toBeGreaterThan(0);
    expect(proxiesCalls.some((u) => u.includes("sources="))).toBe(true);
  });

  it("displays stats when available", async () => {
    setupFetch([], { total: 7, inPool: 2, avgQuality: null, lastSyncAt: null });
    const el = renderTab();
    await waitForCondition(() => el.textContent?.includes("7") === true);
    expect(el.textContent).toContain("proxyFreePoolTotal");
    expect(el.textContent).toContain("proxyFreePoolInPool");
  });

  it("no longer embeds the 3-tier proxy control (moved to its own tab)", async () => {
    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);
    expect(el.textContent).not.toContain("proxyTierTitle");
  });
});

describe("FreePoolTab bulk-selection toolbar", () => {
  it("renders always-visible Select all and Delete selected buttons", async () => {
    const el = renderTab();
    await waitForCondition(
      () => el.querySelector('[data-testid="selection-toolbar-select-all"]') !== null
    );
    expect(el.querySelector('[data-testid="selection-toolbar-select-all"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="selection-toolbar-delete-selected"]')).not.toBeNull();
  });

  it("Delete selected is disabled until a proxy is selected", async () => {
    setupFetch([
      { id: "p1", source: "1proxy", host: "1.2.3.4", port: 8080, type: "http", inPool: false },
    ]);
    const el = renderTab();
    await waitForCondition(
      () => el.querySelector('[data-testid="selection-toolbar-delete-selected"]') !== null
    );
    const deleteBtn = el.querySelector(
      '[data-testid="selection-toolbar-delete-selected"]'
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });

  it("bulk delete opens a confirm modal before deleting selected proxies", async () => {
    const mockFetch = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes("/stats")) return okJson({ stats: defaultStats });
      if (init?.method === "DELETE") return okJson({});
      return okJson({
        items: [
          { id: "p1", source: "1proxy", host: "1.2.3.4", port: 8080, type: "http", inPool: false },
        ],
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const el = renderTab();
    await waitForCondition(
      () => el.querySelector('[data-testid="selection-toolbar-select-all"]') !== null
    );

    const selectAllBtn = el.querySelector('[data-testid="selection-toolbar-select-all"]')!;
    act(() => {
      selectAllBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const deleteBtn = el.querySelector('[data-testid="selection-toolbar-delete-selected"]')!;
    act(() => {
      deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Confirm modal intercepts the click — no DELETE call yet.
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(
      false
    );

    await waitForCondition(() =>
      Array.from(el.querySelectorAll("button")).some(
        (b) => b.textContent === "proxyFreePoolDeleteSelected"
      )
    );
    const confirmButtons = Array.from(el.querySelectorAll("button")).filter(
      (b) => b.textContent === "proxyFreePoolDeleteSelected"
    );
    act(() => {
      confirmButtons[confirmButtons.length - 1].dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });

    await waitForCondition(() =>
      mockFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")
    );
    expect(
      mockFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")
    ).toBe(true);
  });
});

describe("FreePoolTab sync error surfacing (#5595)", () => {
  it("renders the per-source errors the sync route returns instead of failing silently", async () => {
    const mockFetch = vi.fn((url: string) => {
      if (String(url).includes("/sync")) {
        return okJson({
          success: true,
          results: {
            proxifly: { fetched: 0, added: 0, updated: 0, errors: ["TLS handshake failed"] },
            iplocate: { fetched: 0, added: 0, updated: 0, errors: ["http: HTTP 404"] },
            "1proxy": { fetched: 5, added: 5, updated: 0, errors: [] },
          },
          lastSyncAt: "2026-06-30T00:00:00Z",
        });
      }
      if (String(url).includes("/stats")) return okJson({ stats: defaultStats });
      return okJson({ items: [] });
    });
    vi.stubGlobal("fetch", mockFetch);

    const el = renderTab();
    await waitForCondition(() => el.querySelector("[role='group']") !== null);

    const syncBtn = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("proxyFreePoolSyncAll")
    )!;
    expect(syncBtn).toBeTruthy();
    act(() => {
      syncBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // RED before the fix: handleSync discarded the response, so no error box appears.
    await waitForCondition(
      () => el.querySelector("[data-testid='free-pool-sync-errors']") !== null
    );
    const errBox = el.querySelector("[data-testid='free-pool-sync-errors']")!;
    expect(errBox.textContent).toContain("TLS handshake failed");
    expect(errBox.textContent).toContain("HTTP 404");
    // A source with no errors must not be listed.
    expect(errBox.textContent).not.toContain("1proxy");
  });
});
