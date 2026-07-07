// @vitest-environment jsdom
//
// Regression test for the provider detail page crash (upstream merge 5ff4a7e3e):
// ConnectionsListPanel rendered JSX for a Gemini auth-file feature
// (onOpenApplyGeminiModal / applyingGeminiAuthId / onExportGeminiAuthFile /
// exportingGeminiAuthId) whose props, hook state, and ConnectionRow support do
// not exist anywhere in the repo. The identifiers were bare runtime lookups, so
// the file compiled but every provider detail page with >= 1 connection threw
// `ReferenceError: applyingGeminiAuthId is not defined` during React render.
//
// The panel must render its connection rows without throwing — that is the
// whole assertion. ConnectionRow is mocked because prop expressions on it are
// evaluated by the panel at createElement time, which is exactly where the
// orphaned identifiers exploded.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../components/ConnectionRow", () => ({
  default: (props: any) => <div data-testid="connection-row">{props.connection?.id}</div>,
}));

vi.mock("@/shared/components", () => ({
  Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  DistributeProxiesButton: ({ children }: any) => <button>{children}</button>,
}));

import ConnectionsListPanel from "../components/ConnectionsListPanel";

const noop = () => {};
const t = (key: string) => key;

function buildProps(overrides: Record<string, unknown> = {}) {
  return {
    connections: [
      {
        id: "conn-1",
        provider: "kiro",
        name: "primary",
        email: "user@example.com",
        isActive: true,
        authType: "oauth",
        priority: 1,
      },
    ] as any[],
    providerId: "kiro",
    isCcCompatible: false,
    isOAuth: true,
    codexGlobalServiceMode: "off",
    selectedIds: new Set<string>(),
    batchUpdating: null,
    batchRetesting: false,
    batchDeleting: false,
    batchTesting: false,
    retestingId: null,
    refreshingId: null,
    distributingProxies: false,
    healthFilter: "all",
    page: 1,
    PAGE_SIZE: 25,
    connProxyMap: {},
    proxyConfig: null,
    applyingCodexAuthId: null,
    exportingCodexAuthId: null,
    applyingClaudeAuthId: null,
    exportingClaudeAuthId: null,
    emailsVisible: true,
    setSelectedIds: noop,
    setPage: noop,
    setHealthFilter: noop,
    handleDelete: noop,
    handleUpdateConnectionStatus: noop,
    handleToggleRateLimit: noop,
    handleToggleClaudeExtraUsage: noop,
    handleToggleCliproxyapiMode: noop,
    handleToggleCodexLimit: noop,
    handleToggleProxyEnabled: noop,
    handleTogglePerKeyProxyEnabled: noop,
    handleRetestConnection: noop,
    handleRefreshToken: noop,
    handleSwapPriority: noop,
    handleBatchSetActive: noop,
    handleBatchDeleteOpenModal: noop,
    handleBatchRetest: noop,
    handleToggleSelectOne: noop,
    handleToggleSelectAll: noop,
    handleDistributeProxies: noop,
    cpaProviderEnabled: false,
    onOpenEditModal: noop,
    onOpenOAuth: noop,
    onSetProxyTarget: noop,
    onOpenApplyCodexModal: noop,
    onExportCodexAuthFile: noop,
    onOpenApplyClaudeModal: noop,
    onExportClaudeAuthFile: noop,
    gateConnectionFlow: (cb: () => void) => cb(),
    t,
    ...overrides,
  } as any;
}

function renderPanel(props: any) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ConnectionsListPanel {...props} />);
  });
  return { container, root };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("ConnectionsListPanel — renders connection rows without throwing", () => {
  it("renders a connection for a generic provider", () => {
    const { container, root } = renderPanel(buildProps());
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    expect(container.querySelectorAll('[data-testid="connection-row"]').length).toBe(1);
    expect(container.textContent).toContain("conn-1");
  });

  it("renders a connection for the gemini-cli provider", () => {
    const { container, root } = renderPanel(
      buildProps({
        providerId: "gemini-cli",
        connections: [
          {
            id: "gem-1",
            provider: "gemini-cli",
            email: "user@example.com",
            isActive: true,
            authType: "oauth",
            priority: 1,
          },
        ],
      })
    );
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    expect(container.querySelectorAll('[data-testid="connection-row"]').length).toBe(1);
    expect(container.textContent).toContain("gem-1");
  });
});
