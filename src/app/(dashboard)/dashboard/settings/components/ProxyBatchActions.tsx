"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/shared/components";

interface ProxyBatchActionsProps {
  selectedCount: number;
  batchDeleting: boolean;
  autoTesting: boolean;
  batchActivating: boolean;
  onBatchDelete: () => void;
  onBatchActivate: () => void;
  onAutoTestAll: () => void;
}

export function ProxyBatchActions({
  selectedCount,
  batchDeleting,
  autoTesting,
  batchActivating,
  onBatchDelete,
  onBatchActivate,
  onAutoTestAll,
}: ProxyBatchActionsProps) {
  const t = useTranslations("proxyRegistry");

  return (
    <>
      {selectedCount > 0 && (
        <span className="text-xs text-text-muted">
          {t("batchSelectedCount", { count: selectedCount })}
        </span>
      )}
      <Button
        size="sm"
        variant="secondary"
        icon="check_circle"
        onClick={onBatchActivate}
        loading={batchActivating}
        disabled={selectedCount === 0 || batchActivating}
        data-testid="proxy-registry-batch-activate"
      >
        {selectedCount > 0
          ? t("batchActivateSelected", { count: selectedCount })
          : t("activateSelected")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon="delete"
        onClick={onBatchDelete}
        loading={batchDeleting}
        disabled={selectedCount === 0 || batchDeleting}
        className="!text-red-400 !border-red-500/30"
        data-testid="proxy-registry-batch-delete"
      >
        {selectedCount > 0
          ? t("batchDeleteSelected", { count: selectedCount })
          : t("deleteSelected")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon="network_check"
        onClick={onAutoTestAll}
        loading={autoTesting}
        data-testid="proxy-registry-test-all"
      >
        {t("testAll")}
      </Button>
    </>
  );
}
