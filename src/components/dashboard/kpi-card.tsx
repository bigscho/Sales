"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface KPICardProps {
  title: string;
  value: string;
  subtitle?: string;
  detail?: React.ReactNode;
  trend?: { value: number; label: string };
  className?: string;
}

export function KPICard({ title, value, subtitle, detail, trend, className }: KPICardProps) {
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
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium text-[var(--muted-foreground)]">{title}</p>
          {detail && (
            <span className="text-xs text-[var(--muted-foreground)]">
              {expanded ? "▲ collapse" : "▼ drill down"}
            </span>
          )}
        </div>
        <p className="text-2xl font-bold">{value}</p>
        {subtitle && (
          <p className="text-xs text-[var(--muted-foreground)] mt-1">{subtitle}</p>
        )}
        {trend && (
          <div className="flex items-center gap-1 mt-2">
            <span
              className={cn(
                "text-xs font-medium",
                trend.value > 0 ? "text-green-600" : trend.value < 0 ? "text-red-600" : "text-gray-500"
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
