"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercent } from "@/lib/utils";

interface SetterScore {
  id: string;
  name: string;
  tier: number;
  week: { bookings: number; shows: number; noShows: number; pending: number; showRate: number };
  allTime: { bookings: number; shows: number; noShows: number; showRate: number };
}

interface ShowRateRep {
  id: string;
  name: string;
  weekShowRate: number;
  allTimeShowRate: number;
}

interface ScoreboardData {
  scoreboard: SetterScore[];
  weekTotal: { bookings: number; shows: number; noShows: number; pending: number };
  allTimeTotal: { bookings: number; shows: number; noShows: number };
  unattributed: {
    week: { bookings: number; shows: number; noShows: number; pending: number };
    allTime: { bookings: number; shows: number; noShows: number };
  };
  showRateRep: ShowRateRep | null;
}

const MEDALS = ["🥇", "🥈", "🥉"];
const TIER_LABELS: Record<number, string> = { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3", 4: "Tier 4" };
const TIER_COLORS: Record<number, string> = {
  1: "bg-gray-100 text-gray-600",
  2: "bg-blue-100 text-blue-700",
  3: "bg-purple-100 text-purple-700",
  4: "bg-amber-100 text-amber-700",
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
  const [data, setData] = useState<ScoreboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    setLoading(true);
    fetch(`/api/scoreboard${weekId ? `?weekId=${weekId}` : ""}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [weekId]);

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

  const { scoreboard, weekTotal, allTimeTotal, unattributed, showRateRep } = data;
  const maxWeekBookings = Math.max(...scoreboard.map((s) => s.week.bookings), 1);
  const maxAllTimeBookings = Math.max(...scoreboard.map((s) => s.allTime.bookings), 1);

  const teamWeekShowRate = weekTotal.bookings > 0 ? weekTotal.shows / weekTotal.bookings : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Setter Scoreboard</h2>
        <p className="text-sm text-gray-500 mt-1">
          This week + all-time performance
        </p>
      </div>

      {/* Team Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">This Week</p>
            <p className="text-3xl font-bold mt-1">{weekTotal.bookings}</p>
            <p className="text-xs text-gray-500">demos booked</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Showed</p>
            <p className="text-3xl font-bold text-green-600 mt-1">{weekTotal.shows}</p>
            <p className="text-xs text-gray-500">of {weekTotal.bookings} booked</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Show Rate</p>
            <p className={`text-3xl font-bold mt-1 ${
              teamWeekShowRate >= 0.6 ? "text-green-600" :
              teamWeekShowRate >= 0.4 ? "text-yellow-600" : "text-red-600"
            }`}>
              {weekTotal.bookings > 0 ? formatPercent(teamWeekShowRate) : "—"}
            </p>
            <p className="text-xs text-gray-500">team average</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Pending</p>
            <p className="text-3xl font-bold text-yellow-600 mt-1">{weekTotal.pending}</p>
            <p className="text-xs text-gray-500">need review</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">All-Time</p>
            <p className="text-3xl font-bold mt-1">{allTimeTotal.bookings}</p>
            <p className="text-xs text-gray-500">{formatPercent(allTimeTotal.bookings > 0 ? allTimeTotal.shows / allTimeTotal.bookings : 0)} show rate</p>
          </CardContent>
        </Card>
      </div>

      {/* Setter Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle>Setter Rankings — This Week</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {scoreboard.map((setter, idx) => (
            <div key={setter.id} className="flex items-center gap-4 p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
              {/* Rank */}
              <div className="w-10 text-center flex-shrink-0">
                {idx < 3 && setter.week.bookings > 0 ? (
                  <span className="text-2xl">{MEDALS[idx]}</span>
                ) : (
                  <span className="text-lg font-bold text-gray-400">#{idx + 1}</span>
                )}
              </div>

              {/* Name + Tier */}
              <div className="w-28 flex-shrink-0">
                <p className="font-bold text-base">{setter.name}</p>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TIER_COLORS[setter.tier] || TIER_COLORS[1]}`}>
                  {TIER_LABELS[setter.tier] || `Tier ${setter.tier}`}
                </span>
              </div>

              {/* This Week Stats */}
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-sm font-semibold w-24">
                    {setter.week.bookings} booked
                  </span>
                  <span className="text-sm text-green-600 w-20">{setter.week.shows} showed</span>
                  <span className="text-sm text-red-600 w-20">{setter.week.noShows} no-show</span>
                  {setter.week.pending > 0 && (
                    <span className="text-sm text-yellow-600">{setter.week.pending} pending</span>
                  )}
                </div>
                <StatBar value={setter.week.bookings} max={maxWeekBookings} color="bg-green-500" />
              </div>

              {/* Show Rate */}
              <div className="w-20 text-right flex-shrink-0">
                <p className={`text-xl font-bold ${
                  setter.week.showRate >= 0.6 ? "text-green-600" :
                  setter.week.showRate >= 0.4 ? "text-yellow-600" :
                  setter.week.bookings === 0 ? "text-gray-400" : "text-red-600"
                }`}>
                  {setter.week.bookings > 0 ? formatPercent(setter.week.showRate) : "—"}
                </p>
                <p className="text-[10px] text-gray-500">show rate</p>
              </div>
            </div>
          ))}

          {/* Unattributed */}
          {unattributed.week.bookings > 0 && (
            <div className="flex items-center gap-4 p-3 rounded-lg bg-yellow-50/50 border border-yellow-200">
              <div className="w-10 text-center flex-shrink-0">
                <span className="text-lg">❓</span>
              </div>
              <div className="w-28 flex-shrink-0">
                <p className="font-bold text-base text-gray-500">Unknown</p>
                <span className="text-[10px] text-yellow-600">Needs attribution</span>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-sm font-semibold w-24">{unattributed.week.bookings} booked</span>
                  <span className="text-sm text-green-600 w-20">{unattributed.week.shows} showed</span>
                  <span className="text-sm text-red-600 w-20">{unattributed.week.noShows} no-show</span>
                </div>
                <StatBar value={unattributed.week.bookings} max={maxWeekBookings} color="bg-yellow-400" />
              </div>
              <div className="w-20 text-right flex-shrink-0">
                <p className="text-xl font-bold text-yellow-600">
                  {unattributed.week.bookings > 0 ? formatPercent(unattributed.week.shows / unattributed.week.bookings) : "—"}
                </p>
                <p className="text-[10px] text-gray-500">show rate</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* All-Time Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle>All-Time Stats</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                <th className="text-left p-3 font-medium">Setter</th>
                <th className="text-center p-3 font-medium">Tier</th>
                <th className="text-right p-3 font-medium">Bookings</th>
                <th className="text-right p-3 font-medium">Shows</th>
                <th className="text-right p-3 font-medium">No-Shows</th>
                <th className="text-right p-3 font-medium">Show Rate</th>
                <th className="p-3 w-48"></th>
              </tr>
            </thead>
            <tbody>
              {[...scoreboard].sort((a, b) => b.allTime.bookings - a.allTime.bookings).map((setter) => (
                <tr key={setter.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="p-3 font-medium">{setter.name}</td>
                  <td className="p-3 text-center">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TIER_COLORS[setter.tier] || TIER_COLORS[1]}`}>
                      {setter.tier}
                    </span>
                  </td>
                  <td className="p-3 text-right font-semibold">{setter.allTime.bookings}</td>
                  <td className="p-3 text-right text-green-600">{setter.allTime.shows}</td>
                  <td className="p-3 text-right text-red-600">{setter.allTime.noShows}</td>
                  <td className="p-3 text-right">
                    <span className={`font-bold ${
                      setter.allTime.showRate >= 0.6 ? "text-green-600" :
                      setter.allTime.showRate >= 0.4 ? "text-yellow-600" :
                      setter.allTime.bookings === 0 ? "text-gray-400" : "text-red-600"
                    }`}>
                      {setter.allTime.bookings > 0 ? formatPercent(setter.allTime.showRate) : "—"}
                    </span>
                  </td>
                  <td className="p-3">
                    <StatBar value={setter.allTime.bookings} max={maxAllTimeBookings} color="bg-blue-400" />
                  </td>
                </tr>
              ))}
              {unattributed.allTime.bookings > 0 && (
                <tr className="border-b last:border-0 bg-yellow-50/30">
                  <td className="p-3 font-medium text-gray-500">Unattributed</td>
                  <td className="p-3 text-center">—</td>
                  <td className="p-3 text-right font-semibold">{unattributed.allTime.bookings}</td>
                  <td className="p-3 text-right text-green-600">{unattributed.allTime.shows}</td>
                  <td className="p-3 text-right text-red-600">{unattributed.allTime.noShows}</td>
                  <td className="p-3 text-right text-yellow-600 font-bold">
                    {formatPercent(unattributed.allTime.shows / unattributed.allTime.bookings)}
                  </td>
                  <td className="p-3">
                    <StatBar value={unattributed.allTime.bookings} max={maxAllTimeBookings} color="bg-yellow-400" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

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
                <p className="text-xs text-gray-500">This Week</p>
                <p className={`text-3xl font-bold ${
                  showRateRep.weekShowRate >= 0.6 ? "text-green-600" :
                  showRateRep.weekShowRate >= 0.4 ? "text-yellow-600" : "text-red-600"
                }`}>
                  {weekTotal.bookings > 0 ? formatPercent(showRateRep.weekShowRate) : "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">All-Time</p>
                <p className={`text-3xl font-bold ${
                  showRateRep.allTimeShowRate >= 0.6 ? "text-green-600" :
                  showRateRep.allTimeShowRate >= 0.4 ? "text-yellow-600" : "text-red-600"
                }`}>
                  {allTimeTotal.bookings > 0 ? formatPercent(showRateRep.allTimeShowRate) : "—"}
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
