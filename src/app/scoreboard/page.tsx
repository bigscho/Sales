"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBar } from "@/components/ui/status-bar";
import { TimeDimensionToggle } from "@/components/time-dimension-toggle";
import { useTimeDimension } from "@/lib/hooks/use-time-dimension";
import { formatPercent } from "@/lib/utils";
import { showRateColor, closeRateColor } from "@/lib/perf-color";
import { SetterLeaderboards } from "@/components/dashboard/setter-leaderboards";

interface CloserScore {
  id: string;
  name: string;
  demos: number;
  shows: number;
  noShows: number;
  pending: number;
  cancelled: number;
  showRate: number;
  closes: number;
  closeRate: number;
}

interface SetterScore {
  id: string;
  name: string;
  tier: number;
  activity: { newBookings: number };
  results: { shows: number; noShows: number; pending: number; cancelled: number; showRate: number };
  pendingTotal: number;
}

interface ScoreboardData {
  scoreboard: SetterScore[];
  closerBoard: CloserScore[];
  teamTotals: {
    activity: { newBookings: number; asBooked?: number };
    results: { shows: number; noShows: number; pending: number; cancelled: number; showRate: number };
    pendingTotal: number;
  };
  unattributed: {
    activity: { newBookings: number };
    results: { shows: number; noShows: number; pending: number; cancelled: number; showRate: number };
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

  const { scoreboard, closerBoard, teamTotals, unattributed, showRateRep } = data;
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
            <p className="text-xs text-[var(--muted-foreground)]">
              booked {dimLabel.toLowerCase()}
              {teamTotals.activity.asBooked !== undefined && teamTotals.activity.asBooked !== teamTotals.activity.newBookings
                ? ` · ${teamTotals.activity.asBooked} as-booked`
                : ""}
            </p>
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
              (teamTotals.results.shows + teamTotals.results.noShows + teamTotals.results.cancelled) > 0 ? showRateColor(teamTotals.results.showRate) : "text-[var(--muted-foreground)]"
            }`}>
              {(teamTotals.results.shows + teamTotals.results.noShows + teamTotals.results.cancelled) > 0 ? formatPercent(teamTotals.results.showRate) : "—"}
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

      {/* Closer Performance — demos run, show rate on their calendar, closes, close rate. No cash here. */}
      {closerBoard && closerBoard.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Closer Performance — {dimLabel}</h3>
          <div className="bg-[var(--card)] rounded-xl border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--muted)] border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Closer</th>
                  <th className="text-right p-3 font-medium">Demos</th>
                  <th className="text-right p-3 font-medium">Shows</th>
                  <th className="text-right p-3 font-medium">No-Shows</th>
                  <th className="text-right p-3 font-medium">Show Rate</th>
                  <th className="text-right p-3 font-medium">Closes</th>
                  <th className="text-right p-3 font-medium">Close Rate</th>
                </tr>
              </thead>
              <tbody>
                {closerBoard.map((c) => {
                  const rateDenom = c.shows + c.noShows + c.cancelled;
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{c.name}</td>
                      <td className="p-3 text-right">{c.demos}</td>
                      <td className="p-3 text-right text-green-600 font-medium">{c.shows}</td>
                      <td className="p-3 text-right text-red-600">{c.noShows}</td>
                      <td className={`p-3 text-right font-medium ${rateDenom > 0 ? showRateColor(c.showRate) : ""}`}>
                        {rateDenom > 0 ? formatPercent(c.showRate) : "—"}
                      </td>
                      <td className="p-3 text-right font-medium">{c.closes}</td>
                      <td className={`p-3 text-right font-medium ${c.shows > 0 ? closeRateColor(c.closeRate) : ""}`}>
                        {c.shows > 0 ? formatPercent(c.closeRate) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                  {(teamTotals.results.shows + teamTotals.results.noShows + teamTotals.results.cancelled) > 0 ? formatPercent(showRateRep.showRate) : "—"}
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
