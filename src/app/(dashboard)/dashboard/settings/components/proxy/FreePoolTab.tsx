"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button, ConfirmModal } from "@/shared/components";
import SourceToggleBar, {
  type SourceId,
  ALL_SOURCE_IDS,
  loadDisabledSources,
  saveDisabledSources,
} from "./SourceToggleBar";
import FreeProxyRow, { type FreeProxyRowData } from "./FreeProxyRow";
import SelectionToolbar from "./shared/SelectionToolbar";
import StatCard from "./shared/StatCard";

type FreePoolStats = {
  total: number;
  inPool: number;
  avgQuality: number | null;
  lastSyncAt: string | null;
  bySource: Array<{ source: string; count: number }>;
};

export default function FreePoolTab() {
  const t = useTranslations("settings");
  const [proxies, setProxies] = useState<FreeProxyRowData[]>([]);
  const [stats, setStats] = useState<FreePoolStats | null>(null);
  const [disabledSources, setDisabledSources] = useState<Set<SourceId>>(new Set());
  const [filterProtocol, setFilterProtocol] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [minQuality, setMinQuality] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [runningScraper, setRunningScraper] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const [removingBad, setRemovingBad] = useState(false);
  // #4878 follow-up: surface per-source sync errors (declared here so #5595's
  // use of setSyncErrors / syncErrors in handleSync compiles and renders).
  const [syncErrors, setSyncErrors] = useState<Record<string, string[]> | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkProgressMsg, setBulkProgressMsg] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string>("");
  const [fetchingLogs, setFetchingLogs] = useState(false);
  const [scraperError, setScraperError] = useState<string | null>(null);
  const logPreRef = useRef<HTMLPreElement>(null);

  const fetchLogs = useCallback(async () => {
    setFetchingLogs(true);
    try {
      const res = await fetch("/api/settings/free-proxies/scraper/logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || "");
      }
    } catch {}
    setFetchingLogs(false);
  }, []);

  useEffect(() => {
    if (logPreRef.current) {
      logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    if (showLogs || runningScraper) {
      Promise.resolve().then(() => void fetchLogs());
      intervalId = setInterval(() => {
        void fetchLogs();
      }, 3000);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [showLogs, runningScraper, fetchLogs]);

  useEffect(() => {
    setDisabledSources(loadDisabledSources());
  }, []);

  const handleToggleSource = useCallback((source: SourceId) => {
    setDisabledSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      saveDisabledSources(next);
      return next;
    });
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const enabledSources = ALL_SOURCE_IDS.filter((s) => !disabledSources.has(s));
      if (enabledSources.length < ALL_SOURCE_IDS.length) {
        params.set("sources", enabledSources.join(","));
      }
      if (filterProtocol) params.set("protocol", filterProtocol);
      if (filterCountry) params.set("country", filterCountry);
      if (minQuality) params.set("minQuality", minQuality);
      params.set("limit", "1000");

      const [proxiesRes, statsRes] = await Promise.all([
        fetch(`/api/settings/free-proxies?${params.toString()}`),
        fetch("/api/settings/free-proxies/stats"),
      ]);
      if (proxiesRes.ok) {
        const data = await proxiesRes.json();
        setProxies(data.items || []);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats || null);
      }
    } catch {}
    setLoading(false);
  }, [disabledSources, filterProtocol, filterCountry, minQuality]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncErrors(null);
    try {
      const enabledSources = ALL_SOURCE_IDS.filter((s) => !disabledSources.has(s));
      const body = enabledSources.length < ALL_SOURCE_IDS.length ? { sources: enabledSources } : {};
      const res = await fetch("/api/settings/free-proxies/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // #5595: surface per-source errors the route already returns so a
      // partial/empty sync explains itself instead of silently showing "Total: 0".
      const data = await res.json().catch(() => null);
      if (data?.results) {
        const errs: Record<string, string[]> = {};
        for (const [src, r] of Object.entries(
          data.results as Record<string, { errors?: string[] }>
        )) {
          if (Array.isArray(r?.errors) && r.errors.length > 0) errs[src] = r.errors;
        }
        if (Object.keys(errs).length > 0) setSyncErrors(errs);
      }
      await loadData();
    } catch {}
    setSyncing(false);
  };

  const handleRunScraper = async () => {
    setRunningScraper(true);
    setShowLogs(true);
    setScraperError(null);
    try {
      const res = await fetch("/api/settings/free-proxies/scraper/start", {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        setScraperError(err.message || `Request failed (${res.status})`);
        setRunningScraper(false);
        return;
      }
      // Refresh data after a short delay to show initial progress, then again later
      setTimeout(() => void loadData(), 5000);
      setTimeout(() => {
        setRunningScraper(false);
        void loadData();
      }, 3 * 60 * 1000);
    } catch (err) {
      setScraperError(String(err));
      setRunningScraper(false);
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      const res = await fetch("/api/settings/free-proxies/test-all", {
        method: "POST",
      });
      if (!res.ok) {
        console.error("Test-all request failed:", res.status);
      }
      setTimeout(() => void loadData(), 2000);
    } catch {}
    setTestingAll(false);
  };

  const handleRemoveBad = async () => {
    setRemovingBad(true);
    try {
      const res = await fetch("/api/settings/free-proxies/remove-bad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({ removed: 0 }));
      setActionMsg(t("proxyFreePoolRemoveBadDone", { count: data.removed ?? 0 }));
      setTimeout(() => setActionMsg(null), 5000);
      await loadData();
    } catch {}
    setRemovingBad(false);
  };

  const handleAddToPool = async (id: string) => {
    setAddingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/settings/free-proxies/${id}/add-to-pool`, {
        method: "POST",
      });
      // #4878: gate on the parsed body, not just res.ok. The route used to return
      // a default 200 with { success:false } on a failed connectivity probe, which
      // flipped the row to "In Pool" optimistically even though nothing was added.
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setProxies((prev) => prev.map((p) => (p.id === id ? { ...p, inPool: true } : p)));
      }
    } catch {}
    setAddingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleDelete = async (id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/settings/free-proxies?id=${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setProxies((prev) => prev.filter((p) => p.id !== id));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    } catch {}
    setDeletingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleToggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkAdd = async (ids: string[]) => {
    if (!ids.length) return;
    setBulkProgress("Testing proxies...");
    try {
      const res = await fetch("/api/settings/free-proxies/bulk-add-to-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        setBulkProgress(`Request failed (${res.status})`);
        return;
      }
      const data = await res.json();
      setBulkProgress(`${data.succeeded ?? 0} added, ${data.failed ?? 0} failed`);
      await loadData();
      setSelected(new Set());
    } catch {}
    setTimeout(() => setBulkProgress(null), 4000);
  };

  // #4878 multi-select: bulk-delete the selected free proxies. Reuses the
  // existing per-id DELETE route (DELETE /api/settings/free-proxies?id=…)
  // rather than introducing a new endpoint, chunking to keep request bodies
  // bounded and to match the MAX_BULK_IDS convention used by the providers
  // connections hook. Confirmation happens via ConfirmModal before this runs.
  const handleBulkDelete = async (ids: string[]) => {
    if (!ids.length) return;
    setBulkDeleting(true);
    setBulkProgressMsg(t("proxyFreePoolBulkDeleteProgress", { done: 0, total: ids.length }));
    const CHUNK = 5;
    let done = 0;
    let failed = 0;
    const failedIds: string[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map(async (id) => {
          try {
            const res = await fetch(`/api/settings/free-proxies?id=${encodeURIComponent(id)}`, {
              method: "DELETE",
            });
            return res.ok;
          } catch {
            return false;
          }
        })
      );
      results.forEach((okFlag, idx) => {
        if (okFlag) done += 1;
        else {
          failed += 1;
          failedIds.push(chunk[idx]);
        }
      });
      setProxies((prev) => prev.filter((p) => !chunk.includes(p.id)));
      setBulkProgressMsg(
        t("proxyFreePoolBulkDeleteProgress", { done, total: ids.length })
      );
    }
    // keep failed ids selected so the user can review/retry
    setSelected(new Set(failedIds));
    setBulkProgressMsg(t("proxyFreePoolBulkDeleteDone", { done, failed }));
    setBulkDeleting(false);
    setTimeout(() => setBulkProgressMsg(null), 5000);
  };

  const handleToggleSelectAll = () => {
    setSelected((prev) => {
      // select only currently-visible proxies that are eligible
      // (not already in the pool — those checkboxes are disabled).
      const eligible = proxies.filter((p) => !p.inPool).map((p) => p.id);
      const allSelected = eligible.every((id) => prev.has(id)) && eligible.length > 0;
      if (allSelected) {
        const next = new Set(prev);
        for (const id of eligible) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of eligible) next.add(id);
      return next;
    });
  };

  const notInPoolProxies = proxies.filter((p) => !p.inPool);
  const eligibleIds = notInPoolProxies.map((p) => p.id);
  const allEligibleSelected =
    eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id));

  // Source colors
  const sourceColors: Record<string, string> = {
    "1proxy": "bg-violet-500/15 text-violet-400 border-violet-500/30",
    proxifly: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    iplocate: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    proxypool: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    proxyscraper: "bg-pink-500/15 text-pink-400 border-pink-500/30",
  };
  const sourceIcons: Record<string, string> = {
    "1proxy": "shield",
    proxifly: "flight",
    iplocate: "map",
    proxypool: "pool",
    proxyscraper: "search",
  };

  return (
    <div className="space-y-4">
      {stats && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard icon="dns" label={t("proxyFreePoolTotal")} value={stats.total} />
            <StatCard
              icon="cloud_done"
              label={t("proxyFreePoolInPool")}
              value={stats.inPool}
              tone="success"
            />
            <StatCard
              icon="grade"
              label={t("proxyFreePoolAvgQuality")}
              value={stats.avgQuality != null ? stats.avgQuality : "—"}
            />
            <StatCard
              icon="sync"
              label={t("lastSync")}
              value={stats.lastSyncAt ? new Date(stats.lastSyncAt).toLocaleTimeString() : "—"}
            />
          </div>
          {stats.bySource && stats.bySource.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {stats.bySource.map((s) => (
                <span key={s.source} className={`px-2 py-0.5 rounded text-[10px] font-medium border ${sourceColors[s.source] || "bg-surface-alt text-text-muted border-border"}`}>
                  <span className="material-symbols-outlined text-[10px] align-middle mr-0.5">{sourceIcons[s.source] || "public"}</span>
                  {s.source}: {s.count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SourceToggleBar disabledSources={disabledSources} onToggle={handleToggleSource} />
        <div className="flex gap-2 ml-auto flex-wrap items-center">
          <select
            value={filterProtocol}
            onChange={(e) => setFilterProtocol(e.target.value)}
            className="text-xs bg-surface-alt border border-border rounded px-2 py-1"
            aria-label={t("proxyFreePoolFilterProtocol")}
          >
            <option value="">{t("proxyFreePoolProtocol")}</option>
            {["http", "https", "socks4", "socks5"].map((p) => (
              <option key={p} value={p}>{p.toUpperCase()}</option>
            ))}
          </select>
          <input type="text" placeholder={t("proxyFreePoolCountryPlaceholder")} value={filterCountry}
            onChange={(e) => setFilterCountry(e.target.value.toUpperCase().slice(0, 2))}
            className="text-xs bg-surface-alt border border-border rounded px-2 py-1 w-28"
            aria-label={t("proxyFreePoolFilterCountry")}
          />
          <input type="number" placeholder={t("proxyFreePoolMinQualityPlaceholder")} value={minQuality}
            onChange={(e) => setMinQuality(e.target.value)} min={0} max={100}
            className="text-xs bg-surface-alt border border-border rounded px-2 py-1 w-24"
            aria-label={t("proxyFreePoolMinQualityLabel")}
          />
        </div>
      </div>

      <SelectionToolbar
        total={notInPoolProxies.length}
        selectedCount={selected.size}
        allSelected={allEligibleSelected}
        onToggleSelectAll={handleToggleSelectAll}
        onDeleteSelected={() => setConfirmBulkDelete(true)}
        deleting={bulkDeleting}
        labels={{
          selectAll: t("proxyFreePoolToggleSelectAll"),
          deselectAll: t("proxyFreePoolDeselectAll"),
          deleteSelected: t("proxyFreePoolDeleteSelected"),
          selectedCount: t("proxyFreePoolSelected", { count: selected.size }),
        }}
      >
        <Button
          size="sm"
          variant="primary"
          icon="add_circle"
          onClick={() => handleBulkAdd(Array.from(selected))}
          disabled={selected.size === 0 || bulkDeleting}
        >
          {t("proxyFreePoolAddSelected")}
        </Button>
        <Button size="sm" variant="secondary" icon="play_arrow" onClick={handleRunScraper} disabled={runningScraper}>
          {runningScraper ? t("proxyFreePoolScraping") : t("proxyFreePoolScrape")}
        </Button>
        <Button size="sm" variant={showLogs ? "primary" : "secondary"} icon="terminal" onClick={() => setShowLogs((prev) => !prev)}>
          {showLogs ? t("proxyFreePoolConsoleHide") : t("proxyFreePoolConsoleShow")}
        </Button>
        <Button size="sm" variant="secondary" icon="network_check" onClick={handleTestAll} disabled={testingAll}>
          {testingAll ? t("proxyFreePoolTesting") : t("proxyFreePoolTestAllBtn")}
        </Button>
        <Button size="sm" variant="secondary" icon="cleaning_services" onClick={handleRemoveBad} disabled={removingBad}>
          {removingBad ? t("proxyFreePoolRemoving") : t("proxyFreePoolRemoveBad")}
        </Button>
        <Button size="sm" variant="secondary" icon="sync" onClick={handleSync} disabled={syncing}>
          {syncing ? t("syncing") : t("proxyFreePoolSyncAll")}
        </Button>
      </SelectionToolbar>

      {(actionMsg || bulkProgress || bulkProgressMsg || selected.size > 0) && (
        <div className="flex items-center gap-2 p-2 bg-primary/10 rounded border border-primary/20">
          {selected.size > 0 && (
            <span className="text-xs">{t("proxyFreePoolSelected", { count: selected.size })}</span>
          )}
          {(actionMsg || bulkProgress || bulkProgressMsg) && (
            <span className="text-xs text-text-muted">
              {bulkProgressMsg ?? bulkProgress ?? actionMsg}
            </span>
          )}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={bulkDeleting}
              className="text-xs text-text-muted hover:text-text-main ml-auto"
              aria-label={t("proxyFreePoolClearSelection")}
            >
              ✕
            </button>
          )}
        </div>
      )}

      {notInPoolProxies.length > 0 && selected.size === 0 && (
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => handleBulkAdd(notInPoolProxies.slice(0, 100).map((p) => p.id))}>
            {t("proxyFreePoolAddVisible")}
          </Button>
        </div>
      )}

      {showLogs && (
        <div className="flex flex-col gap-2 p-4 bg-black/90 dark:bg-black/95 rounded-lg border border-border/80 shadow-2xl relative">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">{t("proxyFreePoolConsoleTitle")}</span>
            </div>
            <div className="flex items-center gap-3">
              {fetchingLogs && <span className="text-[10px] font-mono text-zinc-400">{t("proxyFreePoolConsoleUpdating")}</span>}
              <button type="button" onClick={() => { setLogs(""); void fetchLogs(); }}
                className="text-xs font-mono text-zinc-400 hover:text-white transition-colors" aria-label={t("proxyFreePoolConsoleClear")}>
                {t("proxyFreePoolConsoleClear")}
              </button>
            </div>
          </div>
          {scraperError && (
            <div className="text-xs font-mono text-red-400 bg-red-900/20 border border-red-800/40 rounded px-3 py-2 mb-1">
              Error: {scraperError}
            </div>
          )}
          <pre ref={logPreRef} className="font-mono text-xs overflow-auto bg-black text-emerald-400 p-3 h-64 shadow-inner whitespace-pre-wrap select-text scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
            {logs || (scraperError ? "" : t("proxyFreePoolConsoleEmpty"))}
          </pre>
        </div>
      )}

      {syncErrors && (
        <div
          className="text-xs text-red-500 flex flex-col gap-1"
          role="alert"
          data-testid="free-pool-sync-errors"
        >
          {Object.entries(syncErrors).map(([src, errs]) => (
            <span key={src}>
              {src}: {errs.join("; ")}
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt text-text-muted text-xs">
            <tr>
              <th className="px-3 py-2 text-left w-8" scope="col">
                <input
                  type="checkbox"
                  aria-label={t("proxyFreePoolToggleSelectAll")}
                  checked={allEligibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selected.size > 0 && !allEligibleSelected;
                  }}
                  onChange={handleToggleSelectAll}
                  disabled={loading || proxies.length === 0 || bulkDeleting}
                  className="rounded"
                />
              </th>
              <th className="px-3 py-2 text-left" scope="col">{t("proxyFreePoolSource")}</th>
              <th className="px-3 py-2 text-left" scope="col">{t("proxyFreePoolHostPort")}</th>
              <th className="px-3 py-2 text-left" scope="col">{t("proxyFreePoolType")}</th>
              <th className="px-3 py-2 text-left" scope="col">{t("proxyFreePoolCountry")}</th>
              <th className="px-3 py-2 text-left" scope="col">{t("proxyFreePoolQuality")}</th>
              <th className="px-3 py-2 text-left" scope="col">{t("proxyFreePoolLatency")}</th>
              <th className="px-3 py-2 text-left" scope="col" title="Successful / failed tests over time">Tests</th>
              <th className="px-3 py-2 text-left" scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-text-muted">{t("loading")}</td></tr>
            ) : proxies.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-text-muted">{t("proxyFreePoolEmpty")}</td></tr>
            ) : (
              proxies.map((p) => (
                <FreeProxyRow
                  key={p.id} proxy={p} selected={selected.has(p.id)}
                  onToggleSelect={handleToggleSelect} onAddToPool={handleAddToPool}
                  adding={addingIds.has(p.id)} onDelete={handleDelete} deleting={deletingIds.has(p.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        isOpen={confirmBulkDelete}
        onClose={() => {
          if (!bulkDeleting) setConfirmBulkDelete(false);
        }}
        onConfirm={() => {
          setConfirmBulkDelete(false);
          void handleBulkDelete(Array.from(selected));
        }}
        title={t("proxyFreePoolDeleteSelected")}
        message={t("proxyFreePoolBulkDeleteConfirm", { count: selected.size })}
        confirmText={t("proxyFreePoolDeleteSelected")}
        cancelText={t("cancel")}
        variant="danger"
        loading={bulkDeleting}
      />
    </div>
  );
}
