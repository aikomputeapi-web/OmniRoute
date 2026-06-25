"use client";
import { useState, useCallback } from "react";
import { Button } from "@/shared/components";
import { useTranslations } from "next-intl";
import ProxyRegistryManager from "../ProxyRegistryManager";
import VercelRelayModal from "./VercelRelayModal";

export default function ProxyPoolTab() {
  const t = useTranslations("settings");
  const [relayModalOpen, setRelayModalOpen] = useState(false);
  const [removingBad, setRemovingBad] = useState(false);
  const [importingBest, setImportingBest] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const showVercelRelay = process.env.NEXT_PUBLIC_VERCEL_RELAY_ENABLED !== "false";

  const handleDeployed = (_poolProxyId: string, relayUrl: string) => {
    alert(`${t("vercelRelaySuccess")}: ${relayUrl}`);
  };

  const handleRemoveBad = useCallback(async () => {
    setRemovingBad(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/settings/proxies/egress", {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        const removed = data.report?.filter((r: any) => !r.alive)?.length || 0;
        setActionMsg(`Validated pool: ${removed} dead proxies marked.`);
      } else {
        setActionMsg("Validation failed.");
      }
    } catch {
      setActionMsg("Validation error.");
    }
    setRemovingBad(false);
    setTimeout(() => setActionMsg(null), 5000);
  }, []);

  const handleImportBestFromFree = useCallback(async () => {
    setImportingBest(true);
    setActionMsg(null);
    try {
      const res = await fetch("/api/settings/free-proxies/sync", {
        method: "POST",
      });
      if (res.ok) {
        setActionMsg("Synced free proxy sources. New candidates will auto-elevate on next check cycle.");
      } else {
        setActionMsg("Sync request sent.");
      }
    } catch {
      setActionMsg("Sync error.");
    }
    setImportingBest(false);
    setTimeout(() => setActionMsg(null), 5000);
  }, []);

  return (
    <div className="space-y-4">
      {/* Action Buttons Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            icon="cleaning_services"
            onClick={handleRemoveBad}
            loading={removingBad}
            disabled={removingBad}
          >
            {removingBad ? "Validating..." : "Test All & Remove Bad"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="cloud_download"
            onClick={handleImportBestFromFree}
            loading={importingBest}
            disabled={importingBest}
          >
            {importingBest ? "Syncing..." : "Import Best from Free Pool"}
          </Button>
        </div>
        {showVercelRelay && (
          <Button
            size="sm"
            variant="secondary"
            icon="cloud_upload"
            onClick={() => setRelayModalOpen(true)}
          >
            {t("vercelRelayButton")}
          </Button>
        )}
      </div>

      {actionMsg && (
        <div className="px-3 py-2 rounded text-sm bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
          {actionMsg}
        </div>
      )}

      <ProxyRegistryManager />
      <VercelRelayModal
        isOpen={relayModalOpen}
        onClose={() => setRelayModalOpen(false)}
        onDeployed={handleDeployed}
      />
    </div>
  );
}
