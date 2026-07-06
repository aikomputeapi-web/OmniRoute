"use client";
import { useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import OverviewTab from "./proxy/OverviewTab";
import GlobalConfigTab from "./proxy/GlobalConfigTab";
import ProxyPoolTab from "./proxy/ProxyPoolTab";
import FreePoolTab from "./proxy/FreePoolTab";
import ThreeTierProxyControl from "./proxy/ThreeTierProxyControl";
import OptionsTab from "./proxy/OptionsTab";
import DocumentationTab from "./proxy/DocumentationTab";

type TabId =
  | "overview"
  | "global-config"
  | "proxy-pool"
  | "free-pool"
  | "tier-control"
  | "options"
  | "documentation";

const TABS: Array<{ id: TabId; labelKey: string }> = [
  { id: "overview", labelKey: "proxyOverviewTab" },
  { id: "global-config", labelKey: "proxyGlobalConfigTab" },
  { id: "proxy-pool", labelKey: "proxyPoolTab" },
  { id: "free-pool", labelKey: "freePoolTab" },
  { id: "tier-control", labelKey: "proxyTierControlTab" },
  { id: "options", labelKey: "proxyOptionsTab" },
  { id: "documentation", labelKey: "proxyDocumentationTab" },
];

export default function ProxyTab() {
  const t = useTranslations("settings");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab = useMemo<TabId>(() => {
    const tabParam = searchParams.get("tab") as TabId | null;
    return tabParam && TABS.some((tab) => tab.id === tabParam) ? tabParam : "overview";
  }, [searchParams]);

  const handleTabChange = (tab: TabId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex gap-1 border-b border-border overflow-x-auto"
        role="tablist"
        aria-label={t("proxySubTabsAria")}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {activeTab === "overview" && <OverviewTab />}
        {activeTab === "global-config" && <GlobalConfigTab />}
        {activeTab === "proxy-pool" && <ProxyPoolTab />}
        {activeTab === "free-pool" && <FreePoolTab />}
        {activeTab === "tier-control" && <ThreeTierProxyControl />}
        {activeTab === "options" && <OptionsTab />}
        {activeTab === "documentation" && <DocumentationTab />}
      </div>
    </div>
  );
}
