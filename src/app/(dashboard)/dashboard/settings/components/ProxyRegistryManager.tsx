"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, ConfirmModal } from "@/shared/components";
import { useProxyBatchOperations } from "./useProxyBatchOperations";
import { ProxyStatusBadge } from "./ProxyStatusBadge";
import { ProxyHealthCell } from "./ProxyHealthCell";
import { ProxyBatchActions } from "./ProxyBatchActions";
import { ProxyCheckboxCell } from "./ProxyCheckboxCell";
import ProxyEditModal, { type ProxyItem } from "./proxy/registry/ProxyEditModal";
import BulkAssignModal from "./proxy/registry/BulkAssignModal";
import BulkImportModal from "./proxy/registry/BulkImportModal";

type UsageInfo = {
  count: number;
  assignments: Array<{ scope: string; scopeId: string | null }>;
};

type HealthInfo = {
  proxyId: string;
  totalRequests: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  lastSeenAt: string | null;
};

type TestResult = {
  success: boolean;
  publicIp?: string;
  latencyMs?: number;
  country?: string;
  error?: string;
};

type ConfirmState = { kind: "batchDelete" } | { kind: "forceDelete"; id: string } | null;

export default function ProxyRegistryManager() {
  const t = useTranslations("proxyRegistry");
  const [items, setItems] = useState<ProxyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyItem | null>(null);

  const [usageById, setUsageById] = useState<Record<string, UsageInfo>>({});
  const [healthById, setHealthById] = useState<Record<string, HealthInfo>>({});
  const [testById, setTestById] = useState<Record<string, TestResult | null>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [forceDeleting, setForceDeleting] = useState(false);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/proxies/health?hours=24");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const entries = Array.isArray(data?.items) ? data.items : [];
      const mapped = Object.fromEntries(
        entries.map((entry: HealthInfo) => [entry.proxyId, entry])
      ) as Record<string, HealthInfo>;
      setHealthById(mapped);
    } catch {
      // ignore health loading errors in UI
    }
  }, []);

  const loadAllUsage = useCallback(async (proxyIds: string[]) => {
    if (!proxyIds.length) return;
    try {
      const results = await Promise.all(
        proxyIds.map((id) =>
          fetch(`/api/settings/proxies/assignments?proxyId=${encodeURIComponent(id)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              const rawAssignments: Array<{ scope: string; scopeId: string | null }> =
                Array.isArray(data?.items) ? data.items : [];
              // Deduplicate by scope+scopeId — prevents double-counting when both
              // a provider-scope and account-scope row exist for the same proxy
              const seen = new Set<string>();
              const assignments = rawAssignments.filter((a) => {
                const key = `${a.scope}:${a.scopeId ?? ""}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              return [id, { count: assignments.length, assignments }] as [string, UsageInfo];
            })
            .catch(() => [id, { count: 0, assignments: [] }] as [string, UsageInfo])
        )
      );
      setUsageById(Object.fromEntries(results));
    } catch {
      // ignore
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/proxies");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error?.message || t("errorLoadFailed"));
        setItems([]);
        return;
      }
      const loaded: ProxyItem[] = Array.isArray(data?.items) ? data.items : [];
      setItems(loaded);
      const ids = loaded.map((p) => p.id).filter(Boolean);
      void loadHealth();
      void loadAllUsage(ids);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || t("errorLoadFailed"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [loadHealth, loadAllUsage, t]);

  // MUST stay after the `load` const — earlier use TDZ-crashes SSR (#5918 guard).
  const {
    selectedIds,
    batchDeleting,
    autoTesting,
    batchActivating,
    toggleSelectAll: hookToggleSelectAll,
    toggleSelect,
    handleBatchDelete: hookHandleBatchDelete,
    handleBatchActivate: hookHandleBatchActivate,
    handleAutoTestAll: hookHandleAutoTestAll,
  } = useProxyBatchOperations(load);

  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  const handleBatchActivate = useCallback(() => {
    hookHandleBatchActivate(setError, "active");
  }, [hookHandleBatchActivate, setError]);

  const handleAutoTestAll = useCallback(() => {
    hookHandleAutoTestAll(setError, setTestById);
  }, [hookHandleAutoTestAll, setError, setTestById]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (item: ProxyItem) => {
    setEditing(item);
    setModalOpen(true);
  };

  const handleTestProxy = async (item: ProxyItem) => {
    if (testingId) return;
    setTestingId(item.id);
    setTestById((prev) => ({ ...prev, [item.id]: null }));
    try {
      const res = await fetch("/api/settings/proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proxyId: item.id,
          proxy: {
            type: item.type || "http",
            host: item.host,
            port: String(item.port || 8080),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestById((prev) => ({
          ...prev,
          [item.id]: { success: false, error: data?.error?.message || t("failed") },
        }));
        return;
      }
      setTestById((prev) => ({ ...prev, [item.id]: { success: true, ...data } }));
    } catch (e: any) {
      setTestById((prev) => ({ ...prev, [item.id]: { success: false, error: e?.message } }));
    } finally {
      setTestingId(null);
    }
  };

  const forceDelete = useCallback(
    async (id: string) => {
      setForceDeleting(true);
      try {
        const forceRes = await fetch(`/api/settings/proxies?id=${encodeURIComponent(id)}&force=1`, {
          method: "DELETE",
        });

        if (!forceRes.ok) {
          const forcePayload = await forceRes.json().catch(() => ({}));
          setError(forcePayload?.error?.message || t("errorDeleteFailed"));
          return;
        }

        await load();
      } catch (e: any) {
        setError(e?.message || t("errorDeleteFailed"));
      } finally {
        setForceDeleting(false);
        setConfirm(null);
      }
    },
    [load, t]
  );

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/settings/proxies?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      if (res.ok) {
        await load();
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setConfirm({ kind: "forceDelete", id });
        return;
      }

      setError(payload?.error?.message || t("errorDeleteFailed"));
    } catch (e: any) {
      setError(e?.message || t("errorDeleteFailed"));
    }
  };

  const handleMigrate = async () => {
    setMigrating(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/proxies/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error?.message || t("errorMigrateFailed"));
        return;
      }
      await load();
    } catch (e: any) {
      setError(e?.message || t("errorMigrateFailed"));
    } finally {
      setMigrating(false);
    }
  };

  return (
    <>
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-lg font-semibold">{t("title")}</h3>
            <p className="text-sm text-text-muted">{t("description")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon="select_all"
              onClick={() => hookToggleSelectAll(allSelected, items)}
              disabled={loading || items.length === 0}
              data-testid="proxy-registry-select-all"
            >
              {allSelected ? t("deselectAll") : t("selectAll")}
            </Button>
            <ProxyBatchActions
              selectedCount={selectedIds.size}
              batchDeleting={batchDeleting}
              autoTesting={autoTesting}
              batchActivating={batchActivating}
              onBatchDelete={() => setConfirm({ kind: "batchDelete" })}
              onBatchActivate={handleBatchActivate}
              onAutoTestAll={handleAutoTestAll}
            />
            <Button
              size="sm"
              variant="secondary"
              icon="upgrade"
              onClick={handleMigrate}
              loading={migrating}
              data-testid="proxy-registry-import-legacy"
            >
              {t("importLegacy")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="upload_file"
              onClick={() => setBulkImportOpen(true)}
              data-testid="proxy-registry-open-bulk-import"
            >
              {t("bulkImport")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="account_tree"
              onClick={() => setBulkOpen(true)}
              data-testid="proxy-registry-open-bulk"
            >
              {t("bulkAssign")}
            </Button>
            <Button
              size="sm"
              icon="add"
              onClick={openCreate}
              data-testid="proxy-registry-open-create"
            >
              {t("addProxy")}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-sm text-red-400">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-text-muted">{t("loading")}</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-text-muted">{t("noProxies")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted border-b border-border">
                  <th className="py-2 pr-2 w-8">
                    <input
                      type="checkbox"
                      className="accent-blue-500 w-4 h-4 cursor-pointer"
                      checked={allSelected}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            !allSelected && items.some((item) => selectedIds.has(item.id));
                      }}
                      onChange={() => hookToggleSelectAll(allSelected, items)}
                      aria-label="Select all proxies"
                    />
                  </th>
                  <th className="py-2 pr-3">{t("tableName")}</th>
                  <th className="py-2 pr-3">{t("tableStatus")}</th>
                  <th className="py-2 pr-3">{t("tableHealth")}</th>
                  <th className="py-2 pr-3">{t("tableUsage")}</th>
                  <th className="py-2">{t("tableActions")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const health = healthById[item.id];
                  return (
                    <tr key={item.id} className="border-b border-border/60">
                      <ProxyCheckboxCell
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleSelect(item.id)}
                        label={`Select ${item.name}`}
                      />
                      <td className="py-2 pr-3">
                        <div className="font-medium text-text-main">{item.name}</div>
                        {item.region && (
                          <div className="text-xs text-text-muted">{item.region}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs text-text-muted">
                        {item.type}://{item.host}:{item.port}
                      </td>
                      <td className="py-2 pr-3">
                        <ProxyStatusBadge status={item.status} />
                      </td>
                      <td className="py-2 pr-3 text-xs text-text-muted">
                        <ProxyHealthCell
                          testResult={testById[item.id] ?? undefined}
                          health={health ?? undefined}
                        />
                      </td>
                      <td className="py-2 pr-3 text-xs text-text-muted">
                        {usageById[item.id] != null
                          ? t("assignmentsCount", { count: usageById[item.id].count })
                          : t("noData")}
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="speed"
                            onClick={() => void handleTestProxy(item)}
                            loading={testingId === item.id}
                          >
                            {t("test")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="edit"
                            onClick={() => openEdit(item)}
                          >
                            {t("edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="delete"
                            onClick={() => void handleDelete(item.id)}
                            className="!text-red-400"
                          >
                            {t("delete")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ProxyEditModal
        isOpen={modalOpen}
        initial={editing}
        onClose={() => setModalOpen(false)}
        onSaved={load}
        onError={setError}
      />

      <BulkAssignModal
        isOpen={bulkOpen}
        items={items}
        onClose={() => setBulkOpen(false)}
        onDone={load}
        onError={setError}
      />

      <BulkImportModal
        isOpen={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        onDone={load}
        onError={setError}
      />

      <ConfirmModal
        isOpen={confirm !== null}
        onClose={() => {
          if (!batchDeleting && !forceDeleting) setConfirm(null);
        }}
        onConfirm={() => {
          if (confirm?.kind === "batchDelete") {
            void hookHandleBatchDelete(setError).finally(() => setConfirm(null));
          } else if (confirm?.kind === "forceDelete") {
            void forceDelete(confirm.id);
          }
        }}
        title={t("deleteSelected")}
        message={
          confirm?.kind === "forceDelete"
            ? t("errorForceDeleteConfirm")
            : t("bulkDeleteConfirm", { count: selectedIds.size })
        }
        confirmText={t("delete")}
        cancelText={t("cancel")}
        variant="danger"
        loading={batchDeleting || forceDeleting}
      />
    </>
  );
}
