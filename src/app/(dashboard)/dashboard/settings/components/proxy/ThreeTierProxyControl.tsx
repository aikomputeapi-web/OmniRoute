"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, ConfirmModal } from "@/shared/components";
import SelectionToolbar from "./shared/SelectionToolbar";

type ProxyTier = "tier1" | "tier2" | "tier3";

type FreeProxyRowWire = {
  id: string;
  tier: number;
  type: string;
  host: string;
  port: number;
  source: string;
  country_code: string | null;
  quality_score: number | null;
  latency_ms: number | null;
  in_pool: number;
  pool_proxy_id: string | null;
  test_count: number;
  success_count: number;
  consecutive_successes: number;
  consecutive_failures: number;
  last_validated: string | null;
  updated_at: string;
};

type GlobalPoolRowWire = {
  registryId: string;
  type: string;
  host: string;
  port: number;
  source: string | null;
  region: string | null;
  quality_score: number | null;
  latency_ms: number | null;
  status: string;
  updated_at: string;
  scope_id: string | null;
};

type NormalizedRow = {
  selectionKey: string;
  sourceId: string;
  tier: ProxyTier;
  provider: string;
  type: string;
  host: string;
  port: number;
  countryCode: string | null;
  qualityScore: number | null;
  latencyMs: number | null;
  successRate: number | null;
  testCount: number;
  consecutiveFailures: number;
  status: string;
  lastCheckedAt: string | null;
};

type ProxyControlSnapshot = {
  tiers: Record<ProxyTier, NormalizedRow[]>;
  counts: Record<ProxyTier, number>;
  source: string;
  globalPoolCount: number;
  lastSyncedAt: string | null;
};

const EMPTY_SNAPSHOT: ProxyControlSnapshot = {
  tiers: { tier1: [], tier2: [], tier3: [] },
  counts: { tier1: 0, tier2: 0, tier3: 0 },
  source: "unavailable",
  globalPoolCount: 0,
  lastSyncedAt: null,
};

// Tier metadata resolves through the settings i18n namespace; the rule keys are
// shared with the Overview tab's tier-rules card so the lifecycle rules have a
// single source of truth.
export const TIER_DEFS: Array<{
  id: ProxyTier;
  titleKey: string;
  descKey: string;
  ruleKey: string;
}> = [
  {
    id: "tier1",
    titleKey: "proxyTierIntakeTitle",
    descKey: "proxyTierIntakeDesc",
    ruleKey: "proxyTierIntakeRule",
  },
  {
    id: "tier2",
    titleKey: "proxyTierVerifiedTitle",
    descKey: "proxyTierVerifiedDesc",
    ruleKey: "proxyTierVerifiedRule",
  },
  {
    id: "tier3",
    titleKey: "proxyTierActiveTitle",
    descKey: "proxyTierActiveDesc",
    ruleKey: "proxyTierActiveRule",
  },
];

function formatPercent(value: number | null) {
  return typeof value === "number" ? `${value}%` : "—";
}

function formatLatency(value: number | null) {
  return typeof value === "number" ? `${value}ms` : "—";
}

function freeProxyToRow(tier: ProxyTier, raw: FreeProxyRowWire): NormalizedRow {
  const tests = Number(raw.test_count) || 0;
  const successes = Number(raw.success_count) || 0;
  return {
    selectionKey: `${tier}:${raw.id}`,
    sourceId: raw.id,
    tier,
    provider: raw.source || "free",
    type: raw.type || "http",
    host: raw.host,
    port: Number(raw.port) || 0,
    countryCode: raw.country_code ?? null,
    qualityScore: raw.quality_score ?? null,
    latencyMs: raw.latency_ms ?? null,
    successRate: tests > 0 ? Math.round((successes / tests) * 100) : null,
    testCount: tests,
    consecutiveFailures: Number(raw.consecutive_failures) || 0,
    status: raw.in_pool === 1 ? "in-pool" : tier,
    lastCheckedAt: raw.last_validated ?? null,
  };
}

function globalPoolToRow(raw: GlobalPoolRowWire): NormalizedRow {
  return {
    selectionKey: `tier3:${raw.registryId}`,
    sourceId: raw.registryId,
    tier: "tier3",
    provider: raw.source || "pool",
    type: raw.type || "http",
    host: raw.host,
    port: Number(raw.port) || 0,
    countryCode: raw.region ?? null,
    qualityScore: raw.quality_score ?? null,
    latencyMs: raw.latency_ms ?? null,
    successRate: null,
    testCount: 0,
    consecutiveFailures: 0,
    status: raw.status || "active",
    lastCheckedAt: null,
  };
}

function normalizeSnapshot(payload: any): ProxyControlSnapshot {
  const t1 = Array.isArray(payload?.tiers?.tier1)
    ? (payload.tiers.tier1 as FreeProxyRowWire[]).map((r) => freeProxyToRow("tier1", r))
    : [];
  const t2 = Array.isArray(payload?.tiers?.tier2)
    ? (payload.tiers.tier2 as FreeProxyRowWire[]).map((r) => freeProxyToRow("tier2", r))
    : [];
  const t3 = Array.isArray(payload?.tiers?.tier3)
    ? (payload.tiers.tier3 as GlobalPoolRowWire[]).map(globalPoolToRow)
    : [];
  return {
    tiers: { tier1: t1, tier2: t2, tier3: t3 },
    counts: {
      tier1: Number(payload?.counts?.tier1 ?? t1.length),
      tier2: Number(payload?.counts?.tier2 ?? t2.length),
      tier3: Number(payload?.counts?.tier3 ?? t3.length),
    },
    source: String(payload?.source ?? "omniroute"),
    globalPoolCount: Number(payload?.globalPoolCount ?? t3.length),
    lastSyncedAt: typeof payload?.lastSyncedAt === "string" ? payload.lastSyncedAt : null,
  };
}

function TierTable({
  label,
  description,
  rule,
  rows,
  selected,
  onToggleRow,
  onToggleTier,
}: {
  label: string;
  description: string;
  rule: string;
  rows: NormalizedRow[];
  selected: Set<string>;
  onToggleRow: (selectionKey: string) => void;
  onToggleTier: (rows: NormalizedRow[]) => void;
}) {
  const t = useTranslations("settings");
  const selectedInTier = rows.filter((row) => selected.has(row.selectionKey)).length;
  const allSelected = rows.length > 0 && selectedInTier === rows.length;
  const someSelected = selectedInTier > 0 && !allSelected;

  return (
    <div className="rounded border border-border overflow-hidden bg-surface/40">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b border-border bg-surface-alt/60">
        <div>
          <div className="text-sm font-semibold text-text-main">{label}</div>
          <div className="text-xs text-text-muted">{description}</div>
          <div className="text-[11px] text-amber-500/90">
            <span className="material-symbols-outlined text-[11px] align-middle mr-0.5" aria-hidden="true">
              gavel
            </span>
            {rule}
          </div>
        </div>
        <div className="text-xs text-text-muted">
          {t("proxyTierSelectedOf", { selected: selectedInTier, total: rows.length })}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt text-text-muted text-xs">
            <tr>
              <th className="px-3 py-2 text-left w-8">
                <input
                  type="checkbox"
                  aria-label={t("proxyTierSelectAllInTier", { tier: label })}
                  checked={allSelected}
                  disabled={rows.length === 0}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={() => onToggleTier(rows)}
                  className="rounded"
                />
              </th>
              <th className="px-3 py-2 text-left">{t("proxyTierColProxy")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColSource")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColType")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColCountry")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColQuality")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColSuccess")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColLatency")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColTests")}</th>
              <th className="px-3 py-2 text-left">{t("proxyTierColStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-text-muted">
                  {t("proxyTierEmpty")}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.selectionKey} className="border-t border-border/50 hover:bg-surface-alt/30">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.host}:${row.port}`}
                      checked={selected.has(row.selectionKey)}
                      onChange={() => onToggleRow(row.selectionKey)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                    {row.host}:{row.port}
                    <div className="text-[10px] text-text-muted">{row.sourceId}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">{row.provider || "—"}</td>
                  <td className="px-3 py-2 text-xs uppercase">{row.type || "http"}</td>
                  <td className="px-3 py-2 text-xs">{row.countryCode || "—"}</td>
                  <td className="px-3 py-2 text-xs font-semibold">{row.qualityScore ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{formatPercent(row.successRate)}</td>
                  <td className="px-3 py-2 text-xs">{formatLatency(row.latencyMs)}</td>
                  <td className="px-3 py-2 text-xs font-mono">{row.testCount ?? 0}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className="px-2 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary">
                      {row.status || row.tier}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ThreeTierProxyControl() {
  const t = useTranslations("settings");
  const [snapshot, setSnapshot] = useState<ProxyControlSnapshot>(EMPTY_SNAPSHOT);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const allRows = useMemo(
    () => [...snapshot.tiers.tier1, ...snapshot.tiers.tier2, ...snapshot.tiers.tier3],
    [snapshot]
  );
  const validKeys = useMemo(() => new Set(allRows.map((row) => row.selectionKey)), [allRows]);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/proxy-control", { cache: "no-store" });
      if (!res.ok) {
        setActionMsg(t("proxyTierLoadFailed", { status: res.status }));
        return;
      }
      const body = await res.json();
      setSnapshot(normalizeSnapshot(body));
      setActionMsg(null);
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : t("proxyTierLoadFailed", { status: 0 }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  // Drop selection keys that no longer exist after a refresh; keeps Set in sync.
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (validKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [validKeys]);

  const allSelected = allRows.length > 0 && allRows.every((row) => selected.has(row.selectionKey));

  function toggleRow(selectionKey: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(selectionKey)) next.delete(selectionKey);
      else next.add(selectionKey);
      return next;
    });
  }

  function toggleTier(rows: NormalizedRow[]) {
    setSelected((prev) => {
      const allTierSelected = rows.length > 0 && rows.every((row) => prev.has(row.selectionKey));
      const next = new Set(prev);
      for (const row of rows) {
        if (allTierSelected) next.delete(row.selectionKey);
        else next.add(row.selectionKey);
      }
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const row of allRows) next.delete(row.selectionKey);
      } else {
        for (const row of allRows) next.add(row.selectionKey);
      }
      return next;
    });
  }

  async function runAction(action: "promote" | "demote" | "quarantine" | "remove") {
    const selectionKeys = Array.from(selected);
    if (selectionKeys.length === 0) return;

    setActing(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/admin/proxy-control/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, selectionKeys }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionMsg(body?.error || t("proxyTierActionFailed", { status: res.status }));
        return;
      }
      const applied = Number(body?.applied ?? 0);
      const skipped = Number(body?.skipped ?? 0);
      setActionMsg(t("proxyTierActionResult", { action, applied, skipped }));
      setSelected(new Set());
      await loadSnapshot();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : t("proxyTierActionFailed", { status: 0 }));
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="space-y-3 rounded border border-border bg-surface/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-main">{t("proxyTierTitle")}</h2>
          <p className="text-xs text-text-muted">{t("proxyTierDescription")}</p>
        </div>
        <SelectionToolbar
          total={allRows.length}
          selectedCount={selected.size}
          allSelected={allSelected}
          onToggleSelectAll={toggleAll}
          onDeleteSelected={() => setConfirmDelete(true)}
          deleting={acting}
          labels={{
            selectAll: t("proxyTierSelectAll"),
            deselectAll: t("proxyTierDeselectAll"),
            deleteSelected: t("proxyTierDeleteSelected"),
            selectedCount: t("proxyTierSelectedOf", {
              selected: selected.size,
              total: allRows.length,
            }),
          }}
        >
          <Button
            size="sm"
            variant="secondary"
            icon="upgrade"
            onClick={() => void runAction("promote")}
            disabled={acting || selected.size === 0}
          >
            {t("proxyTierPromote")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="south"
            onClick={() => void runAction("demote")}
            disabled={acting || selected.size === 0}
          >
            {t("proxyTierDemote")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="report"
            onClick={() => void runAction("quarantine")}
            disabled={acting || selected.size === 0}
          >
            {t("proxyTierQuarantine")}
          </Button>
          <Button size="sm" variant="secondary" icon="refresh" onClick={loadSnapshot} disabled={loading || acting}>
            {t("proxyTierRefresh")}
          </Button>
        </SelectionToolbar>
      </div>

      {actionMsg && (
        <div className="text-xs text-text-muted px-2 py-1 rounded border border-border bg-surface-alt/40">
          {actionMsg}
        </div>
      )}

      {loading ? (
        <div className="px-3 py-8 text-center text-text-muted">{t("proxyTierLoading")}</div>
      ) : (
        <div className="space-y-3">
          {TIER_DEFS.map((tier) => (
            <TierTable
              key={tier.id}
              label={t(tier.titleKey)}
              description={t(tier.descKey)}
              rule={t(tier.ruleKey)}
              rows={snapshot.tiers[tier.id]}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleTier={toggleTier}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmDelete}
        onClose={() => {
          if (!acting) setConfirmDelete(false);
        }}
        onConfirm={() => {
          setConfirmDelete(false);
          void runAction("remove");
        }}
        title={t("proxyTierDeleteSelected")}
        message={t("proxyTierConfirmDelete", { count: selected.size })}
        confirmText={t("proxyTierDeleteSelected")}
        cancelText={t("cancel")}
        variant="danger"
        loading={acting}
      />
    </div>
  );
}
