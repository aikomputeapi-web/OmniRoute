"use client";
import { useState } from "react";

export interface FreeProxyRowData {
  id: string;
  source: string;
  host: string;
  port: number;
  type: string;
  countryCode: string | null;
  qualityScore: number | null;
  latencyMs: number | null;
  anonymity: string | null;
  inPool: boolean;
  testCount?: number;
  successCount?: number;
}

interface FreeProxyRowProps {
  proxy: FreeProxyRowData;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onAddToPool: (id: string) => void;
  adding: boolean;
  onDelete: (id: string) => void;
  deleting: boolean;
}

export default function FreeProxyRow({
  proxy,
  selected,
  onToggleSelect,
  onAddToPool,
  adding,
  onDelete,
  deleting,
}: FreeProxyRowProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number } | null>(null);

  const qualityColor =
    proxy.qualityScore == null
      ? "text-text-muted"
      : proxy.qualityScore >= 80
        ? "text-emerald-400"
        : proxy.qualityScore >= 50
          ? "text-yellow-400"
          : "text-red-400";

  const sourceColors: Record<string, string> = {
    "1proxy": "bg-violet-500/15 text-violet-400 border-violet-500/30",
    proxifly: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    iplocate: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    proxypool: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    proxyscraper: "bg-pink-500/15 text-pink-400 border-pink-500/30",
  };
  const sourceColor = sourceColors[proxy.source] || "bg-surface-alt text-text-muted border-border";

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const start = Date.now();
      const res = await fetch("/api/settings/proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proxy: { type: proxy.type, host: proxy.host, port: String(proxy.port) },
        }),
      });
      const latencyMs = Date.now() - start;
      setTestResult({ ok: res.ok, latencyMs });
    } catch {
      setTestResult({ ok: false });
    }
    setTesting(false);
  };

  return (
    <tr className="border-b border-border/50 hover:bg-surface-alt/30 text-sm">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(proxy.id)}
          className="rounded"
          disabled={proxy.inPool}
          aria-label={`Select ${proxy.host}:${proxy.port}`}
        />
      </td>
      <td className="px-3 py-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${sourceColor}`}>
          {proxy.source}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {proxy.host}:{proxy.port}
      </td>
      <td className="px-3 py-2 uppercase text-xs">{proxy.type}</td>
      <td className="px-3 py-2 text-xs">{proxy.countryCode || "—"}</td>
      <td className={`px-3 py-2 text-xs font-semibold ${qualityColor}`}>
        {proxy.qualityScore != null ? proxy.qualityScore : "—"}
      </td>
      <td className="px-3 py-2 text-xs">
        {testResult && !testResult.ok ? (
          <span className="text-red-400">✗ fail</span>
        ) : testResult?.ok ? (
          <span className="text-emerald-400">{testResult.latencyMs}ms</span>
        ) : (
          proxy.latencyMs != null ? `${proxy.latencyMs}ms` : "—"
        )}
      </td>
      <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" title="Successful / failed tests over time">
        {proxy.testCount != null && proxy.testCount > 0 ? (
          <span>
            <span className="text-emerald-400">{proxy.successCount ?? 0}</span>
            <span className="text-text-muted"> / </span>
            <span className="text-red-400">{proxy.testCount - (proxy.successCount ?? 0)}</span>
          </span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleTest}
            disabled={testing}
            aria-label={`Test ${proxy.host}:${proxy.port}`}
            className="px-1.5 py-0.5 rounded text-[10px] bg-surface-alt text-text-muted border border-border hover:border-primary/30 disabled:opacity-50"
          >
            {testing ? "..." : "Test"}
          </button>
          {proxy.inPool ? (
            <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              in pool
            </span>
          ) : (
            <>
              <button
                onClick={() => onAddToPool(proxy.id)}
                disabled={adding || deleting}
                aria-label={`Add ${proxy.host}:${proxy.port} to pool`}
                className="px-2 py-0.5 rounded text-xs bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 disabled:opacity-50"
              >
                {adding ? "..." : "⊕"}
              </button>
              <button
                onClick={() => onDelete(proxy.id)}
                disabled={adding || deleting}
                aria-label={`Delete ${proxy.host}:${proxy.port}`}
                className="px-2 py-0.5 rounded text-xs bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-50 flex items-center justify-center font-bold"
              >
                {deleting ? "..." : "✕"}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
