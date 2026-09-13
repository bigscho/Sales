"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBar } from "@/components/ui/status-bar";
import { InviteBar } from "@/components/ui/invite-bar";
import { formatPercent } from "@/lib/utils";
import { showRateColor } from "@/lib/perf-color";

interface SetterScore {
  id: string;
  name: string;
  tier: number;
  activity: { newBookings: number };
  results: { shows: number; noShows: number; pending: number; cancelled: number; showRate: number };
  // GCal invite acceptance (prospect RSVP) — optional so older callers still render.
  invites?: { accepted: number; declined: number; captured: number };
  pendingTotal: number;
}

interface SetterLeaderboardsProps {
  scoreboard: SetterScore[];
  unattributed: {
    activity: { newBookings: number };
    results: { shows: number; noShows: number; pending: number; cancelled: number; showRate: number };
    invites?: { accepted: number; declined: number; captured: number };
    pendingTotal: number;
  };
  dimLabel?: string;
}

// Accept-rate color thresholds — same cutoffs the standalone card used.
function acceptRateColor(rate: number): string {
  return rate >= 0.4 ? "text-green-600" : rate >= 0.2 ? "text-yellow-600" : "text-red-600";
}

// The paired Show + GCal-accept bars for one row, stacked so the eye can
// compare them straight down the leaderboard. The GCal bar is a static RSVP
// breakdown (accepted / no response / declined) — the prospect's answer to the
// invite, independent of whether the demo has happened. A mostly-green accept
// bar = a firm week at a glance. Each bar keeps its own rate on its own line
// (show rate is shows-of-decided; accept rate is accepted-of-all-tracked-invites).
function ShowAndAcceptBars({
  results,
  invites,
}: {
  results: { shows: number; noShows: number; pending: number; cancelled: number; showRate: number };
  invites?: { accepted: number; declined: number; captured: number };
}) {
  const decided = results.shows + results.noShows + results.cancelled;
  const inv = invites || { accepted: 0, declined: 0, captured: 0 };
  const none = Math.max(0, inv.captured - inv.accepted - inv.declined);
  const acceptRate = inv.captured > 0 ? inv.accepted / inv.captured : 0;
  return (
    <div className="flex-1 space-y-2">
      {/* Show bar + decided-only show rate */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-[var(--muted-foreground)] w-11 flex-shrink-0">Show</span>
        <div className="flex-1">
          <StatusBar showed={results.shows} noShow={results.noShows} pending={results.pending} cancelled={results.cancelled} size="sm" />
        </div>
        <div className="w-14 text-right flex-shrink-0">
          {decided > 0 ? (
            <>
              <p className={`text-base font-bold ${showRateColor(results.showRate)}`}>{formatPercent(results.showRate)}</p>
              <p className="text-[10px] text-[var(--muted-foreground)] tabular-nums">{results.shows}/{decided}</p>
            </>
          ) : (
            <p className="text-sm font-bold text-[var(--muted-foreground)]">—</p>
          )}
        </div>
      </div>
      {/* GCal accept bar + accept rate */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-[var(--muted-foreground)] w-11 flex-shrink-0">GCal</span>
        <div className="flex-1">
          {inv.captured > 0 ? (
            <InviteBar accepted={inv.accepted} none={none} declined={inv.declined} size="sm" />
          ) : (
            <div className="h-2 rounded-full bg-[var(--muted)]" title="No calendar invites tracked yet for these demos" />
          )}
        </div>
        <div className="w-14 text-right flex-shrink-0">
          {inv.captured > 0 ? (
            <>
              <p className={`text-base font-bold ${acceptRateColor(acceptRate)}`}>{formatPercent(acceptRate)}</p>
              <p className="text-[10px] text-[var(--muted-foreground)] tabular-nums">{inv.accepted}/{inv.captured}</p>
            </>
          ) : (
            <p className="text-sm font-bold text-[var(--muted-foreground)]">—</p>
          )}
        </div>
      </div>
    </div>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];
const TIER_LABELS: Record<number, string> = { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3", 4: "Tier 4" };
const TIER_COLORS: Record<number, string> = {
  1: "bg-[var(--muted)] text-[var(--muted-foreground)]",
  2: "bg-blue-100 text-blue-700",
  3: "bg-purple-100 text-purple-700",
  4: "bg-amber-100 text-amber-700",
};

function StatBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-full bg-[var(--muted)] rounded-full h-3 overflow-hidden">
      <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SetterLeaderboards({ scoreboard, unattributed, dimLabel = "This Week" }: SetterLeaderboardsProps) {
  const activityRanked = [...scoreboard].sort((a, b) => b.activity.newBookings - a.activity.newBookings);
  const resultsRanked = [...scoreboard].sort((a, b) => b.results.shows - a.results.shows);
  const maxActivity = Math.max(...scoreboard.map((s) => s.activity.newBookings), 1);

  return (
    // Side-by-side: New Bookings (left) · Shows & GCal Acceptance (right), no
    // vertical scroll. The Shows board carries paired show + GCal-accept bars
    // per setter; they're compact (size="sm") so both boards fit half-width.
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Activity Leaderboard */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">New Bookings</CardTitle>
          <p className="text-xs text-[var(--muted-foreground)]">Ranked by bookings created {dimLabel.toLowerCase()}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {activityRanked.map((setter, idx) => (
            <div key={setter.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-[var(--muted)] hover:bg-[var(--teal-tint)] transition-colors">
              <div className="w-8 text-center flex-shrink-0">
                {idx < 3 && setter.activity.newBookings > 0 ? (
                  <span className="text-xl">{MEDALS[idx]}</span>
                ) : (
                  <span className="text-sm font-bold text-[var(--muted-foreground)]/70">#{idx + 1}</span>
                )}
              </div>
              <div className="w-20 flex-shrink-0">
                <p className="font-bold text-sm">{setter.name}</p>
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${TIER_COLORS[setter.tier] || TIER_COLORS[1]}`}>
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
                <p className="font-bold text-sm text-[var(--muted-foreground)]">Unknown</p>
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
          <CardTitle className="text-lg">Shows &amp; GCal Acceptance</CardTitle>
          <p className="text-xs text-[var(--muted-foreground)]">
            Ranked by demos showed {dimLabel.toLowerCase()} · each setter&apos;s show bar over their GCal invite-accept bar (accepted invites show ~2×)
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {resultsRanked.map((setter, idx) => (
            <div key={setter.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-[var(--muted)] hover:bg-[var(--teal-tint)] transition-colors">
              <div className="w-8 text-center flex-shrink-0">
                {idx < 3 && setter.results.shows > 0 ? (
                  <span className="text-xl">{MEDALS[idx]}</span>
                ) : (
                  <span className="text-sm font-bold text-[var(--muted-foreground)]/70">#{idx + 1}</span>
                )}
              </div>
              <div className="w-20 flex-shrink-0">
                <p className="font-bold text-sm">{setter.name}</p>
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${TIER_COLORS[setter.tier] || TIER_COLORS[1]}`}>
                  {TIER_LABELS[setter.tier] || `Tier ${setter.tier}`}
                </span>
              </div>
              <ShowAndAcceptBars results={setter.results} invites={setter.invites} />
            </div>
          ))}
          {(unattributed.results.shows + unattributed.results.noShows + unattributed.results.pending + unattributed.results.cancelled) > 0 && (
            <div className="flex items-center gap-3 p-2.5 rounded-lg bg-yellow-50/50 border border-yellow-200">
              <div className="w-8 text-center flex-shrink-0"><span className="text-lg">❓</span></div>
              <div className="w-20 flex-shrink-0">
                <p className="font-bold text-sm text-[var(--muted-foreground)]">Unknown</p>
              </div>
              <ShowAndAcceptBars results={unattributed.results} invites={unattributed.invites} />
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
