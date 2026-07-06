"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Badge, Button, Card } from "@/shared/components";
import StatCard from "./shared/StatCard";
import { TIER_DEFS } from "./ThreeTierProxyControl";

type OverviewStats = {
  poolTotal: number | null;
  registryTotal: number | null;
  freeTotal: number | null;
  freeInPool: number | null;
  freeAvgQuality: number | null;
  tierCounts: { tier1: number; tier2: number; tier3: number } | null;
};

type AutomationSettings = {
  freeProxyAutoJobEnabled: boolean;
  freeProxyCheckIntervalMin: number | null;
  freeProxySyncIntervalMin: number | null;
} | null;

const EMPTY_STATS: OverviewStats = {
  poolTotal: null,
  registryTotal: null,
  freeTotal: null,
  freeInPool: null,
  freeAvgQuality: null,
  tierCounts: null,
};

export default function OverviewTab() {
  const t = useTranslations("settings");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [stats, setStats] = useState<OverviewStats>(EMPTY_STATS);
  const [automation, setAutomation] = useState<AutomationSettings>(null);
  const [loading, setLoading] = useState(true);

  const goToTab = useCallback(
    (tab: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", tab);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  useEffect(() => {
    let cancelled = false;
    // Every fetch fails soft — a card shows "—" instead of blocking the page.
    const load = async () => {
      setLoading(true);
      const [pool, registry, free, tiers, settings] = await Promise.all([
        fetch("/api/settings/proxies/pool")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/settings/proxies")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/settings/free-proxies/stats")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/admin/proxy-control", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/settings")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (cancelled) return;

      setStats({
        poolTotal: Array.isArray(pool?.items) ? pool.items.length : null,
        registryTotal: Array.isArray(registry?.items) ? registry.items.length : null,
        freeTotal: typeof free?.stats?.total === "number" ? free.stats.total : null,
        freeInPool: typeof free?.stats?.inPool === "number" ? free.stats.inPool : null,
        freeAvgQuality:
          typeof free?.stats?.avgQuality === "number" ? free.stats.avgQuality : null,
        tierCounts: tiers?.counts
          ? {
              tier1: Number(tiers.counts.tier1 ?? 0),
              tier2: Number(tiers.counts.tier2 ?? 0),
              tier3: Number(tiers.counts.tier3 ?? 0),
            }
          : null,
      });
      const s = settings?.settings ?? settings;
      setAutomation(
        s
          ? {
              freeProxyAutoJobEnabled:
                s.freeProxyAutoJobEnabled === true || s.freeProxyAutoJobEnabled === "true",
              freeProxyCheckIntervalMin: Number(s.freeProxyCheckIntervalMin) || null,
              freeProxySyncIntervalMin: Number(s.freeProxySyncIntervalMin) || null,
            }
          : null
      );
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const dash = (v: number | null) => (v == null ? "—" : v);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon="lan"
          label={t("proxyOverviewGlobalPool")}
          value={loading ? "…" : dash(stats.poolTotal)}
        />
        <StatCard
          icon="dns"
          label={t("proxyOverviewRegistry")}
          value={loading ? "…" : dash(stats.registryTotal)}
        />
        <StatCard
          icon="cloud_queue"
          label={t("proxyOverviewFreePool")}
          value={loading ? "…" : dash(stats.freeTotal)}
          sub={
            stats.freeInPool != null
              ? t("proxyOverviewFreeInPool", { count: stats.freeInPool })
              : undefined
          }
        />
        <StatCard
          icon="stairs"
          label={t("proxyOverviewTiers")}
          value={
            loading
              ? "…"
              : stats.tierCounts
                ? `${stats.tierCounts.tier1} / ${stats.tierCounts.tier2} / ${stats.tierCounts.tier3}`
                : "—"
          }
          sub={t("proxyOverviewTiersSub")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card padding="md">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-text-main">
                {t("proxyOverviewAutomationTitle")}
              </h3>
              <p className="text-xs text-text-muted">{t("proxyOverviewAutomationDesc")}</p>
            </div>
            {automation && (
              <Badge variant={automation.freeProxyAutoJobEnabled ? "success" : "warning"}>
                {automation.freeProxyAutoJobEnabled
                  ? t("proxyOverviewAutomationOn")
                  : t("proxyOverviewAutomationOff")}
              </Badge>
            )}
          </div>
          <div className="mt-3 flex flex-col gap-1 text-sm text-text-muted">
            <span>
              {t("proxyOverviewCheckInterval", {
                minutes: automation?.freeProxyCheckIntervalMin ?? "—",
              })}
            </span>
            <span>
              {t("proxyOverviewSyncInterval", {
                minutes: automation?.freeProxySyncIntervalMin ?? "—",
              })}
            </span>
          </div>
          <div className="mt-3">
            <Button size="sm" variant="ghost" iconRight="arrow_forward" onClick={() => goToTab("options")}>
              {t("proxyOverviewGoToOptions")}
            </Button>
          </div>
        </Card>

        <Card padding="md">
          <h3 className="text-base font-semibold text-text-main">
            {t("proxyOverviewTierRulesTitle")}
          </h3>
          <p className="text-xs text-text-muted">{t("proxyOverviewTierRulesDesc")}</p>
          <ul className="mt-3 flex flex-col gap-2">
            {TIER_DEFS.map((tier) => (
              <li key={tier.id} className="text-sm">
                <span className="font-medium text-text-main">{t(tier.titleKey)}</span>
                <span className="block text-xs text-text-muted">{t(tier.ruleKey)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button
              size="sm"
              variant="ghost"
              iconRight="arrow_forward"
              onClick={() => goToTab("tier-control")}
            >
              {t("proxyOverviewGoToTierControl")}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
