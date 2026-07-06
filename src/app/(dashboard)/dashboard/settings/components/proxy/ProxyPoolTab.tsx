"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/shared/components";
import { useTranslations } from "next-intl";
import ProxyRegistryManager from "../ProxyRegistryManager";
import VercelRelayModal from "./VercelRelayModal";
import DenoRelayModal from "./DenoRelayModal";
import CloudflareRelayModal from "./CloudflareRelayModal";

export default function ProxyPoolTab() {
  const t = useTranslations("settings");
  const [vercelModalOpen, setVercelModalOpen] = useState(false);
  const [denoModalOpen, setDenoModalOpen] = useState(false);
  const [cloudflareModalOpen, setCloudflareModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [removingBad, setRemovingBad] = useState(false);
  const [importingBest, setImportingBest] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showVercelRelay = process.env.NEXT_PUBLIC_VERCEL_RELAY_ENABLED !== "false";
  const showDenoRelay = process.env.NEXT_PUBLIC_DENO_RELAY_ENABLED !== "false";
  const showCloudflareRelay = process.env.NEXT_PUBLIC_CLOUDFLARE_RELAY_ENABLED !== "false";
  const showAnyRelay = showVercelRelay || showDenoRelay || showCloudflareRelay;

  // Close the dropdown on outside click — mirrors the upstream PR-1437
  // grouped-button UX so adding more relay backends does not blow up the
  // toolbar horizontally.
  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menuOpen]);

  useEffect(() => {
    return () => {
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    };
  }, []);

  const showActionMsg = useCallback((msg: string) => {
    setActionMsg(msg);
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    msgTimerRef.current = setTimeout(() => setActionMsg(null), 5000);
  }, []);

  const handleVercelDeployed = (_poolProxyId: string, relayUrl: string) => {
    showActionMsg(`${t("vercelRelaySuccess")}: ${relayUrl}`);
  };

  const handleCloudflareDeployed = (_poolProxyId: string, relayUrl: string) => {
    showActionMsg(`${t("cloudflareRelaySuccess")}: ${relayUrl}`);
  };

  const handleRemoveBad = useCallback(async () => {
    setRemovingBad(true);
    try {
      const res = await fetch("/api/settings/proxies/egress", { method: "POST" });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const removed = data?.report?.filter((r: { alive?: boolean }) => !r.alive)?.length ?? 0;
        showActionMsg(t("proxyPoolMaintenanceValidated", { count: removed }));
      } else {
        showActionMsg(t("proxyPoolMaintenanceFailed"));
      }
    } catch {
      showActionMsg(t("proxyPoolMaintenanceError"));
    }
    setRemovingBad(false);
  }, [showActionMsg, t]);

  const handleImportBestFromFree = useCallback(async () => {
    setImportingBest(true);
    try {
      const res = await fetch("/api/settings/free-proxies/sync", { method: "POST" });
      if (res.ok) {
        showActionMsg(t("proxyPoolMaintenanceImported"));
      } else {
        showActionMsg(t("proxyPoolMaintenanceFailed"));
      }
    } catch {
      showActionMsg(t("proxyPoolMaintenanceError"));
    }
    setImportingBest(false);
  }, [showActionMsg, t]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="cleaning_services"
            onClick={handleRemoveBad}
            loading={removingBad}
            disabled={removingBad}
            data-testid="proxy-pool-remove-bad"
          >
            {removingBad ? t("proxyPoolTestAllRemoveBadRunning") : t("proxyPoolTestAllRemoveBad")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="cloud_download"
            onClick={handleImportBestFromFree}
            loading={importingBest}
            disabled={importingBest}
            data-testid="proxy-pool-import-best"
          >
            {importingBest ? t("proxyPoolImportBestRunning") : t("proxyPoolImportBest")}
          </Button>
        </div>
        {showAnyRelay && (
          <div className="relative" ref={menuRef}>
            <Button
              size="sm"
              variant="secondary"
              icon="rocket_launch"
              onClick={() => setMenuOpen((v) => !v)}
              data-testid="proxy-pool-deploy-relay"
            >
              {t("deployRelayButton")}
            </Button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-surface p-1 shadow-xl">
                {showVercelRelay && (
                  <button
                    type="button"
                    onClick={() => {
                      setVercelModalOpen(true);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm hover:bg-surface-alt"
                  >
                    <span
                      className="material-symbols-outlined text-[20px] text-primary"
                      aria-hidden="true"
                    >
                      cloud_upload
                    </span>
                    {t("vercelRelayButton")}
                  </button>
                )}
                {showDenoRelay && (
                  <button
                    type="button"
                    onClick={() => {
                      setDenoModalOpen(true);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm hover:bg-surface-alt"
                  >
                    <span
                      className="material-symbols-outlined text-[20px] text-primary"
                      aria-hidden="true"
                    >
                      terminal
                    </span>
                    {t("denoRelayButton")}
                  </button>
                )}
                {showCloudflareRelay && (
                  <button
                    type="button"
                    onClick={() => {
                      setCloudflareModalOpen(true);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm hover:bg-surface-alt"
                  >
                    <span
                      className="material-symbols-outlined text-[20px] text-primary"
                      aria-hidden="true"
                    >
                      cloud
                    </span>
                    {t("cloudflareRelayButton")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {actionMsg && (
        <div
          className="rounded border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-400"
          role="status"
        >
          {actionMsg}
        </div>
      )}

      <ProxyRegistryManager />
      <VercelRelayModal
        isOpen={vercelModalOpen}
        onClose={() => setVercelModalOpen(false)}
        onDeployed={handleVercelDeployed}
      />
      <DenoRelayModal
        isOpen={denoModalOpen}
        onClose={() => setDenoModalOpen(false)}
        onDeployed={handleVercelDeployed}
      />
      <CloudflareRelayModal
        isOpen={cloudflareModalOpen}
        onClose={() => setCloudflareModalOpen(false)}
        onDeployed={handleCloudflareDeployed}
      />
    </div>
  );
}
