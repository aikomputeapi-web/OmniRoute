// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";

const { default: SelectionToolbar } = await import(
  "@/app/(dashboard)/dashboard/settings/components/proxy/shared/SelectionToolbar"
);

const LABELS = {
  selectAll: "Select all",
  deselectAll: "Deselect all",
  deleteSelected: "Delete selected",
  selectedCount: "2 selected",
};

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function renderToolbar(props: Partial<React.ComponentProps<typeof SelectionToolbar>> = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const defaultProps: React.ComponentProps<typeof SelectionToolbar> = {
    total: 5,
    selectedCount: 0,
    allSelected: false,
    onToggleSelectAll: vi.fn(),
    onDeleteSelected: vi.fn(),
    labels: LABELS,
    ...props,
  };
  act(() => {
    root.render(<SelectionToolbar {...defaultProps} />);
  });
  containers.push({ root, el });
  return { el, props: defaultProps };
}

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
});

describe("SelectionToolbar", () => {
  it("shows Select all when nothing is selected", () => {
    const { el } = renderToolbar({ allSelected: false });
    const selectBtn = el.querySelector('[data-testid="selection-toolbar-select-all"]')!;
    expect(selectBtn.textContent).toContain("Select all");
  });

  it("shows Deselect all when everything is selected", () => {
    const { el } = renderToolbar({ allSelected: true, selectedCount: 5 });
    const selectBtn = el.querySelector('[data-testid="selection-toolbar-select-all"]')!;
    expect(selectBtn.textContent).toContain("Deselect all");
  });

  it("disables Delete selected when selectedCount is 0", () => {
    const { el } = renderToolbar({ selectedCount: 0 });
    const deleteBtn = el.querySelector(
      '[data-testid="selection-toolbar-delete-selected"]'
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });

  it("enables Delete selected once something is selected", () => {
    const { el } = renderToolbar({ selectedCount: 2 });
    const deleteBtn = el.querySelector(
      '[data-testid="selection-toolbar-delete-selected"]'
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(false);
  });

  it("invokes onToggleSelectAll when the select-all button is clicked", () => {
    const onToggleSelectAll = vi.fn();
    const { el } = renderToolbar({ onToggleSelectAll });
    const btn = el.querySelector('[data-testid="selection-toolbar-select-all"]')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleSelectAll).toHaveBeenCalledTimes(1);
  });

  it("invokes onDeleteSelected when Delete selected is clicked and enabled", () => {
    const onDeleteSelected = vi.fn();
    const { el } = renderToolbar({ selectedCount: 3, onDeleteSelected });
    const btn = el.querySelector('[data-testid="selection-toolbar-delete-selected"]')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons when total is 0", () => {
    const { el } = renderToolbar({ total: 0, selectedCount: 0 });
    const selectBtn = el.querySelector(
      '[data-testid="selection-toolbar-select-all"]'
    ) as HTMLButtonElement;
    expect(selectBtn.disabled).toBe(true);
  });

  it("hides the selected-count text when nothing is selected", () => {
    const { el } = renderToolbar({ selectedCount: 0 });
    expect(el.querySelector('[data-testid="selection-toolbar-count"]')).toBeNull();
  });

  it("shows the selected-count text once something is selected", () => {
    const { el } = renderToolbar({ selectedCount: 2 });
    const count = el.querySelector('[data-testid="selection-toolbar-count"]');
    expect(count?.textContent).toBe("2 selected");
  });

  it("renders extra children actions passed through", () => {
    const { el } = renderToolbar({ children: <button data-testid="extra-action">Extra</button> });
    expect(el.querySelector('[data-testid="extra-action"]')).not.toBeNull();
  });
});
