"use client";
import { useState, useEffect } from "react";
import { Card, Button, Toggle } from "@/shared/components";
import { useTranslations } from "next-intl";

export default function OptionsTab() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form values
  const [enabled, setEnabled] = useState(false);
  const [checkInterval, setCheckInterval] = useState(15);
  const [syncInterval, setSyncInterval] = useState(60);
  const [countryFilter, setCountryFilter] = useState("US");
  const [minQuality, setMinQuality] = useState(40);
  const [minTests, setMinTests] = useState(5);
  const [minSuccessRate, setMinSuccessRate] = useState(100);
  const [autoElevate, setAutoElevate] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          setEnabled(data.freeProxyAutoJobEnabled === true);
          setCheckInterval(data.freeProxyCheckIntervalMin ?? 15);
          setSyncInterval(data.freeProxySyncIntervalMin ?? 60);
          setCountryFilter(data.freeProxyCountryFilter ?? "US");
          setMinQuality(data.freeProxyMinQuality ?? 40);
          setMinTests(data.freeProxyMinTests ?? 5);
          setMinSuccessRate(data.freeProxyMinSuccessRate ?? 100);
          setAutoElevate(data.freeProxyAutoElevate !== false);
        } else {
          setError("Failed to load proxy settings");
        }
      } catch (err) {
        setError("Failed to load proxy settings");
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          freeProxyAutoJobEnabled: enabled,
          freeProxyCheckIntervalMin: Number(checkInterval),
          freeProxySyncIntervalMin: Number(syncInterval),
          freeProxyCountryFilter: countryFilter.trim().toUpperCase(),
          freeProxyMinQuality: Number(minQuality),
          freeProxyMinTests: Number(minTests),
          freeProxyMinSuccessRate: Number(minSuccessRate),
          freeProxyAutoElevate: autoElevate,
        }),
      });

      if (res.ok) {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error?.message || "Failed to update proxy settings");
      }
    } catch (err) {
      setError("An unexpected error occurred while saving");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-text-muted">{t("loading")}</div>;
  }

  return (
    <div className="space-y-6">
      <Card className="p-0 overflow-hidden">
        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-border/50 pb-4">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-xl text-primary" aria-hidden="true">
                settings_suggest
              </span>
              <div>
                <h2 className="text-lg font-bold">{t("freeProxyOptionsTab")}</h2>
                <p className="text-xs text-text-muted">
                  Configure validation checks, search schedules, and filtering for free proxies
                </p>
              </div>
            </div>
            <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
          </div>

          {enabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold" htmlFor="checkInterval">
                  {t("freeProxyCheckIntervalLabel") || "Check Interval (Minutes)"}
                </label>
                <input
                  id="checkInterval"
                  type="number"
                  min={1}
                  max={1440}
                  value={checkInterval}
                  onChange={(e) => setCheckInterval(Math.max(1, Number(e.target.value)))}
                  className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                />
                <span className="text-xs text-text-muted">
                  {t("freeProxyCheckIntervalDesc") ||
                    "How often to check if proxies in the pool are still working."}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold" htmlFor="syncInterval">
                  {t("freeProxySyncIntervalLabel") || "Sync Interval (Minutes)"}
                </label>
                <input
                  id="syncInterval"
                  type="number"
                  min={1}
                  max={1440}
                  value={syncInterval}
                  onChange={(e) => setSyncInterval(Math.max(1, Number(e.target.value)))}
                  className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                />
                <span className="text-xs text-text-muted">
                  {t("freeProxySyncIntervalDesc") ||
                    "How often to sync new proxies and promote the best one."}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold" htmlFor="countryFilter">
                  {t("freeProxyCountryFilterLabel") || "Country Filter"}
                </label>
                <input
                  id="countryFilter"
                  type="text"
                  maxLength={10}
                  placeholder="US"
                  value={countryFilter}
                  onChange={(e) => setCountryFilter(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono uppercase"
                />
                <span className="text-xs text-text-muted">
                  {t("freeProxyCountryFilterDesc") ||
                    "Only proxies matching this code are stored (default: US)."}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold" htmlFor="minQuality">
                  {t("freeProxyMinQualityLabelSettings") || "Minimum Proxy Quality"}
                </label>
                <input
                  id="minQuality"
                  type="number"
                  min={0}
                  max={100}
                  value={minQuality}
                  onChange={(e) =>
                    setMinQuality(Math.min(100, Math.max(0, Number(e.target.value))))
                  }
                  className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                />
                <span className="text-xs text-text-muted">
                  {t("freeProxyMinQualityDesc") ||
                    "Minimum quality score (0-100) to accept when promoting."}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold" htmlFor="minTests">
                  {t("freeProxyMinTestsLabelSettings") || "Minimum Validation Tests"}
                </label>
                <input
                  id="minTests"
                  type="number"
                  min={1}
                  max={100}
                  value={minTests}
                  onChange={(e) => setMinTests(Math.max(1, Number(e.target.value)))}
                  className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                />
                <span className="text-xs text-text-muted">
                  {t("freeProxyMinTestsDesc") ||
                    "Minimum number of validation runs before promotion."}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-semibold" htmlFor="minSuccessRate">
                  {t("freeProxyMinSuccessRateLabelSettings") || "Required Success Rate (%)"}
                </label>
                <input
                  id="minSuccessRate"
                  type="number"
                  min={0}
                  max={100}
                  value={minSuccessRate}
                  onChange={(e) =>
                    setMinSuccessRate(Math.min(100, Math.max(0, Number(e.target.value))))
                  }
                  className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                />
                <span className="text-xs text-text-muted">
                  {t("freeProxyMinSuccessRateDesc") ||
                    "Percent success required (100 means worked every time)."}
                </span>
              </div>

              <div className="flex items-center gap-3 pt-4 col-span-1 md:col-span-2">
                <input
                  id="autoElevate"
                  type="checkbox"
                  checked={autoElevate}
                  onChange={(e) => setAutoElevate(e.target.checked)}
                  className="w-4 h-4 rounded text-primary focus:ring-primary border-black/10 dark:border-white/10"
                />
                <div className="flex flex-col gap-0.5">
                  <label
                    className="text-sm font-semibold/80 select-none cursor-pointer"
                    htmlFor="autoElevate"
                  >
                    {t("freeProxyAutoElevateLabelSettings") || "Auto-Elevate Vetted Proxies"}
                  </label>
                  <span className="text-xs text-text-muted">
                    {t("freeProxyAutoElevateDesc") ||
                      "Automatically promote candidates to active pool once fully vetted."}
                  </span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-sm text-emerald-400">
              {tc("saved") || "Saved successfully"}
            </div>
          )}

          <div className="flex justify-end pt-4 border-t border-border/30">
            <Button size="sm" variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
