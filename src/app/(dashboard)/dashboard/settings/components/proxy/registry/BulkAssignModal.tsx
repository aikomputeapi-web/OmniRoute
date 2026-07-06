"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Modal } from "@/shared/components";
import type { ProxyItem } from "./ProxyEditModal";

interface BulkAssignModalProps {
  isOpen: boolean;
  items: ProxyItem[];
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (msg: string | null) => void;
}

export default function BulkAssignModal({
  isOpen,
  items,
  onClose,
  onDone,
  onError,
}: BulkAssignModalProps) {
  const t = useTranslations("proxyRegistry");
  const [bulkScope, setBulkScope] = useState("provider");
  const [bulkScopeIds, setBulkScopeIds] = useState("");
  const [bulkProxyId, setBulkProxyId] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);

  useEffect(() => {
    if (items.length > 0 && !bulkProxyId) {
      setBulkProxyId(items[0].id);
    }
  }, [items, bulkProxyId]);

  const handleBulkAssign = async () => {
    setBulkSaving(true);
    onError(null);
    try {
      const scopeIds =
        bulkScope === "global"
          ? []
          : bulkScopeIds
              .split(/[\n,]/g)
              .map((part) => part.trim())
              .filter(Boolean);

      const res = await fetch("/api/settings/proxies/bulk-assign", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: bulkScope,
          scopeIds,
          proxyId: bulkProxyId || null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(payload?.error?.message || t("errorBulkFailed"));
        return;
      }

      setBulkScopeIds("");
      onClose();
      await onDone();
    } catch (e: any) {
      onError(e?.message || t("errorBulkFailed"));
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!bulkSaving) onClose();
      }}
      title={t("bulkProxyAssignment")}
      maxWidth="lg"
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelScope")}</label>
            <select
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={bulkScope}
              onChange={(e) => setBulkScope(e.target.value)}
            >
              <option value="global">{t("scopeGlobal")}</option>
              <option value="provider">{t("scopeProvider")}</option>
              <option value="account">{t("scopeAccount")}</option>
              <option value="combo">{t("scopeCombo")}</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelProxy")}</label>
            <select
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={bulkProxyId}
              onChange={(e) => setBulkProxyId(e.target.value)}
            >
              <option value="">{t("clearAssignment")}</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.type}://{item.host}:{item.port})
                </option>
              ))}
            </select>
          </div>
        </div>

        {bulkScope !== "global" && (
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("bulkLabelScopeIds")}</label>
            <textarea
              data-testid="proxy-registry-bulk-scopeids-input"
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              rows={5}
              value={bulkScopeIds}
              onChange={(e) => setBulkScopeIds(e.target.value)}
              placeholder={t("bulkScopeIdsPlaceholder")}
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            icon="done_all"
            onClick={handleBulkAssign}
            loading={bulkSaving}
            data-testid="proxy-registry-bulk-apply"
          >
            {t("bulkApply")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
