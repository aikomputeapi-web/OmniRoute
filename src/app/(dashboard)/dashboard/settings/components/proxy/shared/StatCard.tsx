"use client";

import { cn } from "@/shared/utils/cn";

interface StatCardProps {
  icon: string;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "success" | "warning" | "danger";
}

const toneClasses: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "text-primary",
  success: "text-emerald-500",
  warning: "text-amber-500",
  danger: "text-red-500",
};

export default function StatCard({ icon, label, value, sub, tone = "default" }: StatCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-surface p-4 shadow-sm">
      <span
        className={cn("material-symbols-outlined text-[28px]", toneClasses[tone])}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-tight text-text-main">{value}</div>
        <div className="truncate text-xs text-text-muted">{label}</div>
        {sub && <div className="truncate text-[10px] text-text-muted/80">{sub}</div>}
      </div>
    </div>
  );
}
