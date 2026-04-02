"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeDimensionToggle } from "@/components/time-dimension-toggle";
import { useTimeDimension } from "@/lib/hooks/use-time-dimension";
import { formatPercent } from "@/lib/utils";

interface SetterScore {
  id: string;
  name: string;
  tier: number;
  activity: { newBookings: number };
  results: { shows: number; noShows: number; pending: number; showRate: number };
  ahead: number;
}

interface ScoreboardData {
  scoreboard: SetterScore[];
  teamTotals: {
    activity: { newBookings: number };
    results: { shows: number; noShows: number; pending: number; showRate: number };
    ahead: number;
  };
  unattributed: {
    activity: { newBookings: number };
    results: { shows: number; noShows: number; pending: number; showRate: number };
    ahead: number;
  };
  showRateRep: { id: string; name: string; showRate: number } | null;
  dimension: string;
}

const MEDALS = ["🥇", "🥈", "🥉"];
const TIER_LABELS: Record<number, string> = { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3", 4: "Tier 4" };
const TIER_COLORS: Record<number, string> = {
  1: "bg-gray-100 text-gray-600",
  2: "bg-blue-100 text-blue-700",
  3: "bg-purple-100 text-purple-700",
  4: "bg-amber-100 text-amber-700",
};

const DIMENSION_LABELS: Record<string, string> = {
  daily: "Today",
  weekly: "This Week",
  monthly: "This Month",
  all_time: "All-Time",
};

function StatBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
      <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

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
          <div key={i} className="h-24 bg-white rounded-xl border animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data) return <p>Error loading scoreboard</p>;

  const { scoreboard, teamTotals, unattributed, showRateRep } = data;
  const dimLabel = DIMENSION_LABELS[dimension] || "This Week";

  // Sort for each leaderboard
  const activityRanked = [...scoreboard].sort((a, b) => b.activity.newBookings - a.activity.newBookings);
  const resultsRanked = [...scoreboard].sort((a, b) => b.results.shows - a.results.shows);
  const maxActivity = Math.max(...scoreboard.map((s) => s.activity.newBookings), 1);
  const maxShows = Math.max(...scoreboard.map((s) => s.results.shows), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Setter Scoreboard</h2>
          <p className="text-sm text-gray-500 mt-1">{dimLabel} performance</p>
        </div>
        <TimeDimensionToggle value={dimension} onChange={setDimension} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">New Bookings</p>
            <p className="text-3xl font-bold mt-1">{teamTotals.activity.newBookings}</p>
            <p className="text-xs text-gray-500">booked {dimLabel.toLowerCase()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Shows</p>
            <p className="text-3xl font-bold text-green-600 mt-1">{teamTotals.results.shows}</p>
            <p className="text-xs text-gray-500">
              of {teamTotals.results.shows + teamTotals.results.noShows} confirmed
              {teamTotals.results.pending > 0 ? ` (${teamTotals.results.pending} pending)` : ""}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Show Rate</p>
            <p className={`text-3xl font-bold mt-1 ${
              teamTotals.results.showRate >= 0.6 ? "text-green-600" :
              teamTotals.results.showRate >= 0.4 ? "text-yellow-600" : "text-red-600"
            }`}>
              {(teamTotals.results.shows + teamTotals.results.noShows) > 0 ? formatPercent(teamTotals.results.showRate) : "—"}
            </p>
            <p className="text-xs text-gray-500">team average</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Awaiting Confirmation</p>
            <p className="text-3xl font-bold text-yellow-600 mt-1">{teamTotals.results.pending}</p>
            <p className="text-xs text-gray-500">on calendar {dimLabel.toLowerCase()}</p>
          </CardContent>
        </Card>
        {dimension !== "all_time" && (
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Ahead</p>
              <p className="text-3xl font-bold text-blue-600 mt-1">{teamTotals.ahead}</p>
              <p className="text-xs text-gray-500">booked beyond {dimLabel.toLowerCase()}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Two Leaderboards Side by Side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity Leaderboard */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">New Bookings</CardTitle>
            <p className="text-xs text-gray-500">Ranked by bookings created {dimLabel.toLowerCase()}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {activityRanked.map((setter, idx) => (
              <div key={setter.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
                <div className="w-8 text-center flex-shrink-0">
                  {idx < 3 && setter.activity.newBookings > 0 ? (
                    <span className="text-xl">{MEDALS[idx]}</span>
                  ) : (
                    <span className="text-sm font-bold text-gray-400">#{idx + 1}</span>
                  )}
                </div>
                <div className="w-20 flex-shrink-0">
                  <p className="font-bold text-sm">{setter.name}</p>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TIER_COLORS[setter.tier] || TIER_COLORS[1]}`}>
                    {TIER_LABELS[setter.tier] || `Tier ${setter.tier}`}
                  </span>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold">{setter.activity.newBookings}</span>
                  </div>
                  <StatBar value={setter.activity.newBookings} max={maxActivity} color="bg-blue-500" />
                </div>
              </div>
            ))}
            {unattributed.activity.newBookings > 0 && (
              <div className="flex items-center gap-3 p-2.5 rounded-lg bg-yellow-50/50 border border-yellow-200">
                <div className="w-8 text-center flex-shrink-0"><span className="text-lg">❓</span></div>
                <div className="w-20 flex-shrink-0">
                  <p className="font-bold text-sm text-gray-500">Unknown</p>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold">{unattributed.activity.newBookings}</span>
                  </div>
                  <StatBar value={unattributed.activity.newBookings} max={maxActivity} color="bg-yellow-400" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Results Leaderboard */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Shows</CardTitle>
            <p className="text-xs text-gray-500">Ranked by demos showed {dimLabel.toLowerCase()}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {resultsRanked.map((setter, idx) => (
              <div key={setter.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
                <div className="w-8 text-center flex-shrink-0">
                  {idx < 3 && setter.results.shows > 0 ? (
                    <span className="text-xl">{MEDALS[idx]}</span>
                  ) : (
                    <span className="text-sm font-bold text-gray-400">#{idx + 1}</span>
                  )}
                </div>
                <div className="w-20 flex-shrink-0">
                  <p className="font-bold text-sm">{setter.name}</p>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TIER_COLORS[setter.tier] || TIER_COLORS[1]}`}>
                    {TIER_LABELS[setter.tier] || `Tier ${setter.tier}`}
                  </span>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm text-green-600">{setter.results.shows} showed</span>
                    <span className="text-sm text-red-600">{setter.results.noShows} no-show</span>
                    {setter.results.pending > 0 && (
                      <span className="text-sm text-yellow-600">{setter.results.pending} pending</span>
                    )}
                    {setter.ahead > 0 && (
                      <span className="text-sm text-blue-600">{setter.ahead} ahead</span>
                    )}
                  </div>
                  <StatBar value={setter.results.shows} max={maxShows} color="bg-green-500" />
                </div>
                <div className="w-16 text-right flex-shrink-0">
                  <p className={`text-lg font-bold ${
                    setter.results.showRate >= 0.6 ? "text-green-600" :
                    setter.results.showRate >= 0.4 ? "text-yellow-600" :
                    (setter.results.shows + setter.results.noShows) === 0 ? "text-gray-400" : "text-red-600"
                  }`}>
                    {(setter.results.shows + setter.results.noShows) > 0 ? formatPercent(setter.results.showRate) : "—"}
                  </p>
                </div>
              </div>
            ))}
            {(unattributed.results.shows + unattributed.results.noShows + unattributed.results.pending) > 0 && (
              <div className="flex items-center gap-3 p-2.5 rounded-lg bg-yellow-50/50 border border-yellow-200">
                <div className="w-8 text-center flex-shrink-0"><span className="text-lg">❓</span></div>
                <div className="w-20 flex-shrink-0">
                  <p className="font-bold text-sm text-gray-500">Unknown</p>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm text-green-600">{unattributed.results.shows} showed</span>
                    <span className="text-sm text-red-600">{unattributed.results.noShows} no-show</span>
                  </div>
                  <StatBar value={unattributed.results.shows} max={maxShows} color="bg-yellow-400" />
                </div>
                <div className="w-16 text-right flex-shrink-0">
                  <p className="text-lg font-bold text-yellow-600">
                    {(unattributed.results.shows + unattributed.results.noShows) > 0 ? formatPercent(unattributed.results.showRate) : "—"}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Show Rate Rep Card */}
      {showRateRep && (
        <Card className="border-green-200 bg-green-50/30">
          <CardContent className="pt-4 pb-4 px-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Show Rate Rep</p>
                <p className="text-xl font-bold mt-1">{showRateRep.name}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">{dimLabel}</p>
                <p className={`text-3xl font-bold ${
                  showRateRep.showRate >= 0.6 ? "text-green-600" :
                  showRateRep.showRate >= 0.4 ? "text-yellow-600" : "text-red-600"
                }`}>
                  {(teamTotals.results.shows + teamTotals.results.noShows) > 0 ? formatPercent(showRateRep.showRate) : "—"}
                </p>
              </div>
              <div className="text-sm text-gray-600 max-w-xs">
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
