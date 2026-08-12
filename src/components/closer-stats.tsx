"use client";

import { useEffect, useState } from "react";
import { formatCents } from "@/lib/utils";

interface RangePerf {
  demos: number;
  shows: number;
  noShows: number;
  cancelled: number;
  pending: number;
  showRate: number | null;
  closes: number;
  closeRate: number | null;
}

interface CloserStats {
  closer: { id: string; name: string };
  monthLabel: string;
  activity: {
    demosShowed: number;
    fedDemosShowed: number;
    closes: number;
    fedCloses: number;
    selfCloses: number;
    fedCloseRate: number | null;
  };
  performance: { week: RangePerf; month: RangePerf };
  money: {
    rates: { fed: number; self: number };
    month: { fedCashCents: number; selfCashCents: number; commissionCents: number; clawbackCents: number };
    week: { fedCashCents: number; selfCashCents: number; commissionCents: number; clawbackCents: number };
    projectedBase: { amountCents: number; note: string };
  } | null;
}

// "My Numbers" — the closer's own contract scoreboard: MTD closes, fed close
// rate (drives the base quality floor), cash split, commission, projected base.
export function CloserStatsPanel({ closerId }: { closerId?: string }) {
  const [stats, setStats] = useState<CloserStats | null>(null);

  useEffect(() => {
    const params = closerId ? `?closerId=${closerId}` : "";
    fetch(`/api/closer/stats${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setStats(data && !data.error ? data : null))
      .catch(() => setStats(null));
  }, [closerId]);

  if (!stats) return null;

  const { activity, money } = stats;
  const ratePct = activity.fedCloseRate !== null ? (activity.fedCloseRate * 100).toFixed(1) : null;
  const rateOk = activity.fedCloseRate !== null && activity.fedCloseRate >= 0.25;
  const monthCommission = money ? money.month.commissionCents + money.month.clawbackCents : 0;
  const weekCommission = money ? money.week.commissionCents + money.week.clawbackCents : 0;

  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
  const { week, month } = stats.performance;

  const tiles: { label: string; value: string; sub?: string; accent?: string }[] = [
    {
      label: "Closes MTD",
      value: `${activity.closes}`,
      sub: `${activity.fedCloses} fed · ${activity.selfCloses} self${activity.closes < 20 ? " — base needs 20" : " ✓"}`,
      accent: activity.closes >= 20 ? "text-green-600" : undefined,
    },
    {
      label: "My Show Rate",
      value: pct(month.showRate),
      sub: `${month.shows}/${month.shows + month.noShows + month.cancelled} this month · ${pct(week.showRate)} this week`,
      accent: month.showRate === null ? undefined : month.showRate >= 0.5 ? "text-green-600" : "text-red-600",
    },
    {
      label: "My Close Rate",
      value: pct(month.closeRate),
      sub: `${month.closes} of ${month.shows} shows · ${pct(week.closeRate)} this week`,
      accent: month.closeRate === null ? undefined : month.closeRate >= 0.25 ? "text-green-600" : "text-red-600",
    },
    {
      label: "Fed Close Rate",
      value: ratePct !== null ? `${ratePct}%` : "—",
      sub: `${activity.fedCloses} of ${activity.fedDemosShowed} fed demos showed`,
      accent: ratePct === null ? undefined : rateOk ? "text-green-600" : "text-red-600",
    },
  ];

  if (money) {
    tiles.push(
      {
        label: "New Cash MTD",
        value: formatCents(money.month.fedCashCents + money.month.selfCashCents),
        sub: `fed ${formatCents(money.month.fedCashCents)} · self ${formatCents(money.month.selfCashCents)}`,
      },
      {
        label: "Commission MTD",
        value: formatCents(monthCommission),
        sub: `this week ${formatCents(weekCommission)}${money.month.clawbackCents < 0 ? ` · clawback ${formatCents(money.month.clawbackCents)}` : ""}`,
        accent: "text-green-600",
      },
      {
        label: "Projected Base",
        value: formatCents(money.projectedBase.amountCents),
        sub: money.projectedBase.note,
        accent: money.projectedBase.amountCents > 0 ? "text-green-600" : "text-red-600",
      },
    );
  }

  return (
    <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
      <div className="px-4 py-2.5 border-b bg-[var(--muted)] flex items-center justify-between">
        <h3 className="text-sm font-semibold">My Numbers — {stats.monthLabel}</h3>
        {money && (
          <span className="text-xs text-[var(--muted-foreground)]">
            {Math.round(money.rates.fed * 100)}% fed / {Math.round(money.rates.self * 100)}% self-sourced
          </span>
        )}
      </div>
      <div className={`grid grid-cols-2 md:grid-cols-4 ${tiles.length > 4 ? "xl:grid-cols-7" : "xl:grid-cols-4"} divide-x divide-[var(--border)]`}>
        {tiles.map((t) => (
          <div key={t.label} className="p-4">
            <p className="text-xs text-[var(--muted-foreground)] mb-1">{t.label}</p>
            <p className={`text-xl font-bold ${t.accent || ""}`}>{t.value}</p>
            {t.sub && <p className="text-xs text-[var(--muted-foreground)] mt-1">{t.sub}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
