"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface KPICardProps {
  title: string;
  value: string;
  valueClassName?: string;
  subtitle?: string | React.ReactNode;
  detail?: React.ReactNode;
  trend?: { value: number; label: string };
  className?: string;
}

export function KPICard({ title, value, valueClassName, subtitle, detail, trend, className }: KPICardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card
      className={cn(
        "cursor-pointer transition-all hover:shadow-md",
        expanded && "ring-2 ring-[var(--primary)]",
        className
      )}
      onClick={() => detail && setExpanded(!expanded)}
    >
      <div className="p-5">
        <div className="flex items-center justify-between h-5 mb-1">
          <p className="text-sm font-medium text-[var(--muted-foreground)] truncate">{title}</p>
          {detail && (
            <span className="text-xs text-[var(--muted-foreground)] flex-shrink-0 ml-1">
              {expanded ? "▲" : "▼"}
            </span>
          )}
        </div>
        <p className={cn("text-2xl font-bold tracking-tight leading-8", valueClassName || "text-[var(--teal)]")}>{value}</p>
        {subtitle && (
          typeof subtitle === "string"
            ? <p className="text-xs text-[var(--muted-foreground)] mt-1">{subtitle}</p>
            : <div className="mt-1">{subtitle}</div>
        )}
        {trend && (
          <div className="flex items-center gap-1 mt-2">
            <span
              className={cn(
                "text-xs font-medium",
                trend.value > 0 ? "text-green-600" : trend.value < 0 ? "text-red-600" : "text-[var(--muted-foreground)]"
              )}
            >
              {trend.value > 0 ? "↑" : trend.value < 0 ? "↓" : "→"} {Math.abs(trend.value).toFixed(1)}%
            </span>
            <span className="text-xs text-[var(--muted-foreground)]">{trend.label}</span>
          </div>
        )}
      </div>
      {expanded && detail && (
        <div className="border-t border-[var(--border)] p-5 bg-[var(--muted)] rounded-b-xl max-h-80 overflow-y-auto">
          {detail}
        </div>
      )}
    </Card>
  );
}
