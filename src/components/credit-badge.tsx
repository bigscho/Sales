"use client";

import { useEffect, useState } from "react";

interface CreditBadgeProps {
  setterId?: string;
  balance?: number; // if provided, skip fetch
  size?: "sm" | "md";
}

export function CreditBadge({ setterId, balance: propBalance, size = "sm" }: CreditBadgeProps) {
  const [balance, setBalance] = useState<number | null>(propBalance ?? null);

  useEffect(() => {
    if (propBalance !== undefined) {
      setBalance(propBalance);
      return;
    }
    if (!setterId) return;

    fetch(`/api/credits?setterId=${setterId}`)
      .then(r => r.json())
      .then(data => setBalance(data.balance ?? 0))
      .catch(() => setBalance(0));
  }, [setterId, propBalance]);

  if (balance === null) return null;

  if (size === "md") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-2xl font-bold tracking-tight text-[var(--teal)]">
          {balance.toLocaleString()}
        </span>
        <span className="text-sm text-[var(--muted-foreground)]">credits</span>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-[var(--teal-tint)] text-[var(--teal)]">
      📲 {balance.toLocaleString()}
    </span>
  );
}
