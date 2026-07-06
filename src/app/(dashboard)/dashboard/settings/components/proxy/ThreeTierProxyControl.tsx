"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/shared/components";

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

const TIERS: Array<{ id: ProxyTier; label: string; description: string }> = [
  {
    id: "tier1",
    label: "Tier 1 — Intake",
    description: "Newly discovered proxies being tested before verification. Deleted after 5 consecutive failures.",
  },
  {
    id: "tier2",
    label: "Tier 2 — Verified",
    description: "Working proxies waiting to be proven solid before joining the active pool. Demoted to Tier 1 after 3 consecutive failures.",
  },
  {
    id: "tier3",
    label: "Tier 3 — Active Pool",
    description: "Active global proxy pool eligible for production traffic. A single failed test drops to Tier 2, a second drops to Tier 1.",
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
  rows,
  selected,
  onToggleRow,
  onToggleTier,
}: {
  label: string;
  description: string;
  rows: NormalizedRow[];
  selected: Set<string>;
  onToggleRow: (selectionKey: string) => void;
  onToggleTier: (rows: NormalizedRow[]) => void;
}) {
  const selectedInTier = rows.filter((row) => selected.has(row.selectionKey)).length;
  const allSelected = rows.length > 0 && selectedInTier === rows.length;
  const someSelected = selectedInTier > 0 && !allSelected;

  return (
    <div className="rounded border border-border overflow-hidden bg-surface/40">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b border-border bg-surface-alt/60">
        <div>
          <div className="text-sm font-semibold text-text-main">{label}</div>
          <div className="text-xs text-text-muted">{description}</div>
        </div>
        <div className="text-xs text-text-muted">
          {selectedInTier}/{rows.length} selected
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt text-text-muted text-xs">
            <tr>
              <th className="px-3 py-2 text-left w-8">
                <input
                  type="checkbox"
                  aria-label={`Select all ${label} proxies`}
                  checked={allSelected}
                  disabled={rows.length === 0}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={() => onToggleTier(rows)}
                  className="rounded"
                />
              </th>
              <th className="px-3 py-2 text-left">Proxy</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Country</th>
              <th className="px-3 py-2 text-left">Quality</th>
              <th className="px-3 py-2 text-left">Success</th>
              <th className="px-3 py-2 text-left">Latency</th>
              <th className="px-3 py-2 text-left">Tests</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-text-muted">
                  No proxies in this tier.
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
  const [snapshot, setSnapshot] = useState<ProxyControlSnapshot>(EMPTY_SNAPSHOT);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

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
        setActionMsg(`Failed to load proxy tiers (${res.status})`);
        return;
      }
      const body = await res.json();
      setSnapshot(normalizeSnapshot(body));
      setActionMsg(null);
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : "Failed to load proxy tiers");
    } finally {
      setLoading(false);
    }
  }, []);

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
  const partiallySelected = selected.size > 0 && !allSelected;

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
    if (action === "remove") {
      const ok = window.confirm(
        `Delete ${selectionKeys.length} selected prox${selectionKeys.length === 1 ? "y" : "ies"}?`
      );
      if (!ok) return;
    }

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
        setActionMsg(body?.error || `Action failed (${res.status})`);
        return;
      }
      const applied = Number(body?.applied ?? 0);
      const skipped = Number(body?.skipped ?? 0);
      setActionMsg(`${action}: ${applied} applied, ${skipped} skipped`);
      setSelected(new Set());
      await loadSnapshot();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="space-y-3 rounded border border-border bg-surface/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-main">3-Tier Proxy Control</h2>
          <p className="text-xs text-text-muted">
            Select and manage proxies across Tier 1 intake, Tier 2 verified, and Tier 3 active pool.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-text-main px-2 py-1 rounded border border-border bg-surface-alt/60">
            <input
              type="checkbox"
              aria-label="Select all proxies across all tiers"
              checked={allSelected}
              disabled={loading || allRows.length === 0 || acting}
              ref={(el) => {
                if (el) el.indeterminate = partiallySelected;
              }}
              onChange={toggleAll}
              className="rounded"
            />
            Select all
          </label>
          <span className="text-xs text-text-muted">
            {selected.size}/{allRows.length} selected
          </span>
          <Button size="sm" variant="secondary" onClick={loadSnapshot} disabled={loading || acting}>
            Refresh
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void runAction("promote")} disabled={acting || selected.size === 0}>
            Promote
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void runAction("demote")} disabled={acting || selected.size === 0}>
            Demote
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void runAction("quarantine")} disabled={acting || selected.size === 0}>
            Quarantine
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="delete"
            onClick={() => void runAction("remove")}
            disabled={acting || selected.size === 0}
            className="!text-red-400"
          >
            Delete selected
          </Button>
        </div>
      </div>

      {actionMsg && (
        <div className="text-xs text-text-muted px-2 py-1 rounded border border-border bg-surface-alt/40">
          {actionMsg}
        </div>
      )}

      {loading ? (
        <div className="px-3 py-8 text-center text-text-muted">Loading proxy tiers…</div>
      ) : (
        <div className="space-y-3">
          {TIERS.map((tier) => (
            <TierTable
              key={tier.id}
              label={tier.label}
              description={tier.description}
              rows={snapshot.tiers[tier.id]}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleTier={toggleTier}
            />
          ))}
        </div>
      )}
    </div>
  );
}
