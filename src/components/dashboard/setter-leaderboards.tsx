"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercent } from "@/lib/utils";

interface SetterScore {
  id: string;
  name: string;
  tier: number;
  activity: { newBookings: number };
  results: { shows: number; noShows: number; pending: number; showRate: number };
  pendingTotal: number;
}

interface SetterLeaderboardsProps {
  scoreboard: SetterScore[];
  unattributed: {
    activity: { newBookings: number };
    results: { shows: number; noShows: number; pending: number; showRate: number };
    pendingTotal: number;
  };
  dimLabel?: string;
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

export function SetterLeaderboards({ scoreboard, unattributed, dimLabel = "This Week" }: SetterLeaderboardsProps) {
  const activityRanked = [...scoreboard].sort((a, b) => b.activity.newBookings - a.activity.newBookings);
  const resultsRanked = [...scoreboard].sort((a, b) => b.results.shows - a.results.shows);
  const maxActivity = Math.max(...scoreboard.map((s) => s.activity.newBookings), 1);
  const maxShows = Math.max(...scoreboard.map((s) => s.results.shows), 1);

  return (
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
                  {setter.pendingTotal > 0 && (
                    <span className="text-sm text-blue-600">{setter.pendingTotal} pending total</span>
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
  );
}
