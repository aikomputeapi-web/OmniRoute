"use client";

import type { ReactNode } from "react";
import { Button } from "@/shared/components";

export interface SelectionToolbarLabels {
  selectAll: string;
  deselectAll: string;
  deleteSelected: string;
  selectedCount: string;
}

interface SelectionToolbarProps {
  total: number;
  selectedCount: number;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onDeleteSelected: () => void;
  deleting?: boolean;
  labels: SelectionToolbarLabels;
  children?: ReactNode;
}

/**
 * Shared bulk-selection toolbar for pool-style proxy tables. Select All and
 * Delete Selected stay visible at all times (Delete disabled at 0 selected)
 * so bulk actions are discoverable before anything is checked.
 */
export default function SelectionToolbar({
  total,
  selectedCount,
  allSelected,
  onToggleSelectAll,
  onDeleteSelected,
  deleting = false,
  labels,
  children,
}: SelectionToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        icon="select_all"
        onClick={onToggleSelectAll}
        disabled={total === 0 || deleting}
        data-testid="selection-toolbar-select-all"
      >
        {allSelected ? labels.deselectAll : labels.selectAll}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon="delete"
        onClick={onDeleteSelected}
        loading={deleting}
        disabled={selectedCount === 0 || deleting}
        className="!text-red-400 !border-red-500/30"
        data-testid="selection-toolbar-delete-selected"
      >
        {labels.deleteSelected}
      </Button>
      {selectedCount > 0 && (
        <span className="text-xs text-text-muted" data-testid="selection-toolbar-count">
          {labels.selectedCount}
        </span>
      )}
      {children}
    </div>
  );
}
