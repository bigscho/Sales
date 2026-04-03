"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBar } from "@/components/ui/status-bar";
import { TimeDimensionToggle } from "@/components/time-dimension-toggle";
import { useTimeDimension } from "@/lib/hooks/use-time-dimension";
import { formatPercent } from "@/lib/utils";
import { showRateColor } from "@/lib/perf-color";
import { SetterLeaderboards } from "@/components/dashboard/setter-leaderboards";

interface SetterScore {
  id: string;
  name: string;
  tier: number;
  activity: { newBookings: number };
  results: { shows: number; noShows: number; pending: number; showRate: number };
  pendingTotal: number;
}

interface ScoreboardData {
  scoreboard: SetterScore[];
  teamTotals: {
    activity: { newBookings: number };
    results: { shows: number; noShows: number; pending: number; showRate: number };
    pendingTotal: number;
  };
  unattributed: {
    activity: { newBookings: number };
    results: { shows: number; noShows: number; pending: number; showRate: number };
    pendingTotal: number;
  };
  showRateRep: { id: string; name: string; showRate: number } | null;
  dimension: string;
}

const DIMENSION_LABELS: Record<string, string> = {
  daily: "Today",
  weekly: "This Week",
  monthly: "This Month",
  all_time: "All-Time",
};

export default function ScoreboardPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const { dimension, setDimension } = useTimeDimension();
  const [data, setData] = useState<ScoreboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (weekId) params.set("weekId", weekId);
    if (dimension !== "weekly") params.set("dimension", dimension);
    fetch(`/api/scoreboard?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [weekId, dimension]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--card)] rounded-xl border animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data) return <p>Error loading scoreboard</p>;

  const { scoreboard, teamTotals, unattributed, showRateRep } = data;
  const dimLabel = DIMENSION_LABELS[dimension] || "This Week";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Setter Scoreboard</h2>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">{dimLabel} performance</p>
        </div>
        <TimeDimensionToggle value={dimension} onChange={setDimension} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">New Bookings</p>
            <p className="text-3xl font-bold tracking-tight text-[var(--teal)] mt-1">{teamTotals.activity.newBookings}</p>
            <p className="text-xs text-[var(--muted-foreground)]">booked {dimLabel.toLowerCase()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Demo Results</p>
            <StatusBar showed={teamTotals.results.shows} noShow={teamTotals.results.noShows} pending={teamTotals.results.pending} size="sm" className="mt-2" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Show Rate</p>
            <p className={`text-3xl font-bold tracking-tight mt-1 ${
              (teamTotals.results.shows + teamTotals.results.noShows) > 0 ? showRateColor(teamTotals.results.showRate) : "text-[var(--muted-foreground)]"
            }`}>
              {(teamTotals.results.shows + teamTotals.results.noShows) > 0 ? formatPercent(teamTotals.results.showRate) : "—"}
            </p>
            <p className="text-xs text-[var(--muted-foreground)]">team average</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Awaiting Confirmation</p>
            <p className="text-3xl font-bold text-yellow-600 mt-1">{teamTotals.results.pending}</p>
            <p className="text-xs text-[var(--muted-foreground)]">on calendar {dimLabel.toLowerCase()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Pending Total</p>
            <p className="text-3xl font-bold text-blue-600 mt-1">{teamTotals.pendingTotal}</p>
            <p className="text-xs text-[var(--muted-foreground)]">across all weeks</p>
          </CardContent>
        </Card>
      </div>

      {/* Two Leaderboards Side by Side */}
      <SetterLeaderboards scoreboard={scoreboard} unattributed={unattributed} dimLabel={dimLabel} />

      {/* Show Rate Rep Card */}
      {showRateRep && (
        <Card className="border-green-200 bg-green-50/30">
          <CardContent className="pt-4 pb-4 px-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Show Rate Rep</p>
                <p className="text-xl font-bold mt-1">{showRateRep.name}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-[var(--muted-foreground)]">{dimLabel}</p>
                <p className={`text-3xl font-bold ${
                  showRateRep.showRate >= 0.6 ? "text-green-600" :
                  showRateRep.showRate >= 0.4 ? "text-yellow-600" : "text-red-600"
                }`}>
                  {(teamTotals.results.shows + teamTotals.results.noShows) > 0 ? formatPercent(showRateRep.showRate) : "—"}
                </p>
              </div>
              <div className="text-sm text-[var(--muted-foreground)] max-w-xs">
                <p className="font-medium">Bonus Tiers:</p>
                <p>50%+ → $100 | 60%+ → $200 | 70%+ → $300</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
