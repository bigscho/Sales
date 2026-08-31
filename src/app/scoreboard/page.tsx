"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBar } from "@/components/ui/status-bar";
import { TimeDimensionToggle } from "@/components/time-dimension-toggle";
import { useTimeDimension } from "@/lib/hooks/use-time-dimension";
import { formatPercent, formatDateShort, formatCents, computeShowRate } from "@/lib/utils";
import { showRateColor, closeRateColor } from "@/lib/perf-color";
import { SetterLeaderboards } from "@/components/dashboard/setter-leaderboards";
import { useSession } from "@/components/app-shell";

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
  cashCents: number;
}

interface CloserDetailDemo {
  id: string;
  demoDate: string;
  prospectName: string;
  setterName: string;
  leadSource: string;
  status: string;
  countsAs: string;
}

interface CloserDetailClose {
  id: string;
  prospectName: string;
  closedAt: string | null;
  leadSource: string;
  demoDate: string | null;
  demoInPeriod: boolean;
}

interface CloserDetailPayment {
  id: string;
  paidAt: string;
  prospectName: string;
  dealId: string;
  leadSource: string;
  amountCents: number;
  counted: boolean;
  excludedReason: string | null;
}

interface CloserDetailRefund {
  id: string;
  refundedAt: string | null;
  paidAt: string;
  prospectName: string;
  dealId: string;
  leadSource: string;
  refundedCents: number;
}

interface CloserDetail {
  closer: { id: string; name: string };
  demos: CloserDetailDemo[];
  closes: CloserDetailClose[];
  cash: {
    payments: CloserDetailPayment[];
    refunds: CloserDetailRefund[];
    totalCents: number;
  };
  activeClosers: { id: string; name: string }[];
  tallies: {
    demos: number;
    shows: number;
    noShows: number;
    pending: number;
    cancelled: number;
    rescheduled: number;
    showRate: number;
    closes: number;
    closeRate: number;
  };
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
  unattributedCashCents: number;
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

type BoardView = "setters" | "closers";

export default function ScoreboardPage() {
  const searchParams = useSearchParams();
  const session = useSession();
  const isAdmin = !!session?.isAdmin;
  const weekId = searchParams.get("weekId") || "";
  const [view, setView] = useState<BoardView>(
    searchParams.get("view") === "closers" ? "closers" : "setters"
  );
  const { dimension, setDimension } = useTimeDimension();
  const [data, setData] = useState<ScoreboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedCloser, setExpandedCloser] = useState<string | null>(null);
  const [closerDetail, setCloserDetail] = useState<CloserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchDetail = useCallback((closerId: string) => {
    setDetailLoading(true);
    const params = new URLSearchParams({ closerId });
    if (weekId) params.set("weekId", weekId);
    if (dimension !== "weekly") params.set("dimension", dimension);
    fetch(`/api/scoreboard?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => { setCloserDetail(d); setDetailLoading(false); })
      .catch(() => setDetailLoading(false));
  }, [weekId, dimension]);

  const toggleCloserDetail = useCallback((closerId: string) => {
    if (expandedCloser === closerId) {
      setExpandedCloser(null);
      setCloserDetail(null);
      return;
    }
    setExpandedCloser(closerId);
    setCloserDetail(null);
    fetchDetail(closerId);
  }, [expandedCloser, fetchDetail]);

  // Admin reassigns a deal's cash to a different closer straight from the
  // drill-down. Writes the existing audited /api/deals PATCH, then refreshes
  // both the board and the open detail so the numbers move in front of you.
  const reassignDeal = useCallback(async (dealId: string, closerId: string) => {
    await fetch("/api/deals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId, closerId }),
    });
    // Silent board refresh (no skeleton flash), then refresh the open panel.
    const params = new URLSearchParams();
    if (weekId) params.set("weekId", weekId);
    if (dimension !== "weekly") params.set("dimension", dimension);
    fetch(`/api/scoreboard?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {});
    if (expandedCloser) fetchDetail(expandedCloser);
  }, [weekId, dimension, expandedCloser, fetchDetail]);

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
  // Collapse any open drill-down when the period changes — its rows are stale.
  useEffect(() => { setExpandedCloser(null); setCloserDetail(null); }, [weekId, dimension]);

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

  const { scoreboard, closerBoard, teamTotals, unattributed } = data;
  const dimLabel = DIMENSION_LABELS[dimension] || "This Week";

  // Closer-view summary cards, derived from the same closerBoard rows the
  // table shows — a card can never disagree with the table beneath it.
  const closerTotals = closerBoard.reduce(
    (acc, c) => ({
      demos: acc.demos + c.demos,
      shows: acc.shows + c.shows,
      noShows: acc.noShows + c.noShows,
      cancelled: acc.cancelled + c.cancelled,
      closes: acc.closes + c.closes,
      cashCents: acc.cashCents + c.cashCents,
    }),
    { demos: 0, shows: 0, noShows: 0, cancelled: 0, closes: 0, cashCents: 0 }
  );
  const closerRateDenom = closerTotals.shows + closerTotals.noShows + closerTotals.cancelled;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="inline-flex rounded-lg border bg-[var(--muted)] p-0.5">
            {(["setters", "closers"] as BoardView[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${
                  view === v
                    ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                <span className="sm:hidden">{v === "setters" ? "Setters" : "Closers"}</span>
                <span className="hidden sm:inline">{v === "setters" ? "Setter Scoreboard" : "Closer Scoreboard"}</span>
              </button>
            ))}
          </div>
          <p className="hidden sm:block text-sm text-[var(--muted-foreground)]">{dimLabel} performance</p>
        </div>
        <TimeDimensionToggle value={dimension} onChange={setDimension} />
      </div>

      {view === "setters" && (
      <>
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
            <StatusBar showed={teamTotals.results.shows} noShow={teamTotals.results.noShows} pending={teamTotals.results.pending} cancelled={teamTotals.results.cancelled} size="sm" className="mt-2" />
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
      </>
      )}

      {/* Closer Scoreboard — demos booked onto their calendars, show rate, closes, close rate, cash collected. */}
      {view === "closers" && (
        <>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Demos Booked</p>
              <p className="text-3xl font-bold tracking-tight text-[var(--teal)] mt-1">{closerTotals.demos}</p>
              <p className="text-xs text-[var(--muted-foreground)]">on closer calendars {dimLabel.toLowerCase()}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Shows</p>
              <p className="text-3xl font-bold tracking-tight text-green-600 mt-1">{closerTotals.shows}</p>
              <p className="text-xs text-[var(--muted-foreground)]">{closerTotals.noShows} no-shows</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Show Rate</p>
              <p className={`text-3xl font-bold tracking-tight mt-1 ${closerRateDenom > 0 ? showRateColor(computeShowRate(closerTotals.shows, closerTotals.noShows, closerTotals.cancelled)) : "text-[var(--muted-foreground)]"}`}>
                {closerRateDenom > 0 ? formatPercent(computeShowRate(closerTotals.shows, closerTotals.noShows, closerTotals.cancelled)) : "—"}
              </p>
              <p className="text-xs text-[var(--muted-foreground)]">across all closers</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Closes</p>
              <p className="text-3xl font-bold tracking-tight mt-1">{closerTotals.closes}</p>
              <p className="text-xs text-[var(--muted-foreground)]">
                {closerTotals.shows > 0 ? `${formatPercent(closerTotals.closes / closerTotals.shows)} close rate` : "—"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Cash Collected</p>
              <p className={`text-2xl md:text-3xl font-bold tracking-tight mt-1 ${closerTotals.cashCents > 0 ? "text-green-600" : closerTotals.cashCents < 0 ? "text-red-600" : "text-[var(--muted-foreground)]"}`}>
                {closerTotals.cashCents !== 0 ? formatCents(closerTotals.cashCents) : "—"}
              </p>
              <p className="text-xs text-[var(--muted-foreground)]">upfront cash landed {dimLabel.toLowerCase()}</p>
            </CardContent>
          </Card>
        </div>

        {closerBoard.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">No closer activity {dimLabel.toLowerCase()}.</p>
        ) : (
        <div>
          <div className="bg-[var(--card)] rounded-xl border overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-[var(--muted)] border-b">
                <tr>
                  <th className="text-left p-3 font-medium whitespace-nowrap">Closer</th>
                  <th className="text-right p-3 font-medium whitespace-nowrap">Demos</th>
                  <th className="text-right p-3 font-medium whitespace-nowrap">Shows</th>
                  <th className="text-right p-3 font-medium whitespace-nowrap">No-Shows</th>
                  <th className="text-right p-3 font-medium whitespace-nowrap">Show Rate</th>
                  <th className="text-right p-3 font-medium whitespace-nowrap">Closes</th>
                  <th className="text-right p-3 font-medium whitespace-nowrap">Close Rate</th>
                  <th className="text-right p-3 font-medium" title="Upfront cash landed this period, net of refunds — same rule as commission">Cash Collected</th>
                </tr>
              </thead>
              <tbody>
                {closerBoard.map((c) => {
                  const rateDenom = c.shows + c.noShows + c.cancelled;
                  const isExpanded = expandedCloser === c.id;
                  return (
                    <CloserRowGroup
                      key={c.id}
                      closer={c}
                      rateDenom={rateDenom}
                      isExpanded={isExpanded}
                      detail={isExpanded ? closerDetail : null}
                      detailLoading={isExpanded && detailLoading}
                      onToggle={() => toggleCloserDetail(c.id)}
                      isAdmin={isAdmin}
                      onReassign={reassignDeal}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.unattributedCashCents !== 0 && (
            <p className="text-xs text-yellow-700 mt-2">
              ⚠ {formatCents(data.unattributedCashCents)} of upfront cash this period isn&apos;t assigned to any closer
              {isAdmin ? " — set the closer on the deal (Deals page) to attribute it." : "."}
            </p>
          )}
        </div>
        )}
        </>
      )}

      {/* Show Rate Rep card removed per Colin 2026-08-13 — it displayed his
          bonus comp to the whole team. His pay lives on the Payroll page. */}
    </div>
  );
}

const DEMO_STATUS_STYLES: Record<string, string> = {
  showed: "bg-green-100 text-green-700",
  no_show: "bg-red-100 text-red-700",
  pending: "bg-yellow-100 text-yellow-700",
  cancelled: "bg-gray-200 text-gray-600",
  rescheduled: "bg-gray-100 text-gray-400 line-through",
};

const DEMO_STATUS_LABELS: Record<string, string> = {
  showed: "Showed",
  no_show: "No-Show",
  pending: "Pending",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled →",
};

function CloserRowGroup({
  closer: c,
  rateDenom,
  isExpanded,
  detail,
  detailLoading,
  onToggle,
  isAdmin,
  onReassign,
}: {
  closer: CloserScore;
  rateDenom: number;
  isExpanded: boolean;
  detail: CloserDetail | null;
  detailLoading: boolean;
  onToggle: () => void;
  isAdmin: boolean;
  onReassign: (dealId: string, closerId: string) => void;
}) {
  return (
    <>
      <tr
        className={`border-b last:border-0 cursor-pointer hover:bg-[var(--muted)]/50 ${isExpanded ? "bg-[var(--muted)]/40" : ""}`}
        onClick={onToggle}
        title="Click to see the demos and closes behind these numbers"
      >
        <td className="p-3 font-medium">
          <span className="inline-block w-4 text-[var(--muted-foreground)]">{isExpanded ? "▾" : "▸"}</span>
          {c.name}
        </td>
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
        <td className={`p-3 text-right font-medium ${c.cashCents > 0 ? "text-green-600" : c.cashCents < 0 ? "text-red-600" : "text-[var(--muted-foreground)]"}`}>
          {c.cashCents !== 0 ? formatCents(c.cashCents) : "—"}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b last:border-0 bg-[var(--muted)]/20">
          <td colSpan={8} className="p-0">
            {detailLoading && (
              <p className="p-4 text-sm text-[var(--muted-foreground)]">Loading detail…</p>
            )}
            {detail && <CloserDetailPanel detail={detail} isAdmin={isAdmin} onReassign={onReassign} />}
          </td>
        </tr>
      )}
    </>
  );
}

function CloserDetailPanel({
  detail,
  isAdmin,
  onReassign,
}: {
  detail: CloserDetail;
  isAdmin: boolean;
  onReassign: (dealId: string, closerId: string) => void;
}) {
  const t = detail.tallies;
  const rateDenom = t.shows + t.noShows + t.cancelled;
  const countedPayments = detail.cash.payments.filter((p) => p.counted);
  const excludedPayments = detail.cash.payments.filter((p) => !p.counted);
  const collectedCents = countedPayments.reduce((s, p) => s + p.amountCents, 0);
  const refundedCents = detail.cash.refunds.reduce((s, r) => s + r.refundedCents, 0);
  return (
    <div className="p-4 space-y-4 text-sm">
      {/* The math, spelled out from the rows below */}
      <div className="rounded-lg border bg-[var(--card)] p-3 space-y-1 font-mono text-xs">
        <p>
          <span className="font-semibold">Demos = {t.demos}</span>
          {"  ("}{t.shows} showed + {t.noShows} no-show + {t.pending} pending + {t.cancelled} cancelled{")"}
          {t.rescheduled > 0 && (
            <span className="text-[var(--muted-foreground)]"> · {t.rescheduled} rescheduled row{t.rescheduled === 1 ? "" : "s"} not counted</span>
          )}
        </p>
        <p>
          <span className="font-semibold">Show Rate</span> = {t.shows} showed ÷ ({t.shows} showed + {t.noShows} no-show + {t.cancelled} cancelled) ={" "}
          {rateDenom > 0 ? formatPercent(t.showRate) : "— (nothing decided yet)"}
          <span className="text-[var(--muted-foreground)]"> · pending excluded until confirmed</span>
        </p>
        <p>
          <span className="font-semibold">Close Rate</span> = {t.closes} close{t.closes === 1 ? "" : "s"} ÷ {t.shows} show{t.shows === 1 ? "" : "s"} ={" "}
          {t.shows > 0 ? formatPercent(t.closeRate) : "—"}
          <span className="text-[var(--muted-foreground)]"> · closes count by close date, so a close here may come from an earlier period&apos;s demo</span>
        </p>
        <p>
          <span className="font-semibold">Cash Collected</span> = {formatCents(collectedCents)} landed
          {refundedCents > 0 && <> − {formatCents(refundedCents)} refunded</>} = {formatCents(detail.cash.totalCents)}
          <span className="text-[var(--muted-foreground)]"> · upfront cash only (within 24h of the deal&apos;s first payment), counted the day it lands — same rule as commission</span>
        </p>
      </div>

      {/* Every demo behind the count */}
      <div>
        <p className="font-semibold mb-1">Demos on {detail.closer.name}&apos;s calendar this period ({detail.demos.length} rows)</p>
        {detail.demos.length === 0 ? (
          <p className="text-[var(--muted-foreground)]">None.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[var(--muted-foreground)]">
              <tr className="border-b">
                <th className="text-left py-1 pr-3 font-medium">Date</th>
                <th className="text-left py-1 pr-3 font-medium">Prospect</th>
                <th className="text-left py-1 pr-3 font-medium">Set by</th>
                <th className="text-left py-1 pr-3 font-medium">Source</th>
                <th className="text-left py-1 pr-3 font-medium">Status</th>
                <th className="text-left py-1 font-medium">Counts as</th>
              </tr>
            </thead>
            <tbody>
              {detail.demos.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDateShort(d.demoDate)}</td>
                  <td className={`py-1 pr-3 ${d.status === "rescheduled" ? "text-[var(--muted-foreground)] line-through" : ""}`}>{d.prospectName}</td>
                  <td className="py-1 pr-3">{d.setterName}</td>
                  <td className="py-1 pr-3 uppercase text-[10px] tracking-wide">{d.leadSource === "self_sourced" ? "Self" : "Fed"}</td>
                  <td className="py-1 pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${DEMO_STATUS_STYLES[d.status] || "bg-gray-100"}`}>
                      {DEMO_STATUS_LABELS[d.status] || d.status}
                    </span>
                  </td>
                  <td className="py-1 text-[var(--muted-foreground)]">{d.countsAs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Every close behind the count */}
      <div>
        <p className="font-semibold mb-1">Deals closed-won this period ({detail.closes.length})</p>
        {detail.closes.length === 0 ? (
          <p className="text-[var(--muted-foreground)]">None.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[var(--muted-foreground)]">
              <tr className="border-b">
                <th className="text-left py-1 pr-3 font-medium">Closed</th>
                <th className="text-left py-1 pr-3 font-medium">Client</th>
                <th className="text-left py-1 pr-3 font-medium">Source</th>
                <th className="text-left py-1 font-medium">Demo ran</th>
              </tr>
            </thead>
            <tbody>
              {detail.closes.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{d.closedAt ? formatDateShort(d.closedAt) : "—"}</td>
                  <td className="py-1 pr-3">{d.prospectName}</td>
                  <td className="py-1 pr-3 uppercase text-[10px] tracking-wide">{d.leadSource === "self_sourced" ? "Self" : "Fed"}</td>
                  <td className="py-1">
                    {d.demoDate ? formatDateShort(d.demoDate) : <span className="text-[var(--muted-foreground)]">no linked demo</span>}
                    {!d.demoInPeriod && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700">
                        {d.demoDate ? "demo outside this period" : "counts toward closes, not show rate"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Every payment behind the cash number — counted, excluded (with reason), and refunds */}
      <div>
        <p className="font-semibold mb-1">
          Cash collected this period ({countedPayments.length} payment{countedPayments.length === 1 ? "" : "s"}
          {detail.cash.refunds.length > 0 ? `, ${detail.cash.refunds.length} refund${detail.cash.refunds.length === 1 ? "" : "s"}` : ""})
        </p>
        {countedPayments.length === 0 && excludedPayments.length === 0 && detail.cash.refunds.length === 0 ? (
          <p className="text-[var(--muted-foreground)]">No payments landed on {detail.closer.name}&apos;s deals this period.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[var(--muted-foreground)]">
              <tr className="border-b">
                <th className="text-left py-1 pr-3 font-medium">Landed</th>
                <th className="text-left py-1 pr-3 font-medium">Client</th>
                <th className="text-left py-1 pr-3 font-medium">Source</th>
                <th className="text-right py-1 pr-3 font-medium">Amount</th>
                <th className="text-left py-1 font-medium">{isAdmin ? "Credited to / reassign" : "Notes"}</th>
              </tr>
            </thead>
            <tbody>
              {countedPayments.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDateShort(p.paidAt)}</td>
                  <td className="py-1 pr-3">{p.prospectName}</td>
                  <td className="py-1 pr-3 uppercase text-[10px] tracking-wide">{p.leadSource === "self_sourced" ? "Self" : "Fed"}</td>
                  <td className="py-1 pr-3 text-right font-medium text-green-600">{formatCents(p.amountCents)}</td>
                  <td className="py-1">
                    {isAdmin ? (
                      <ReassignSelect
                        dealId={p.dealId}
                        currentCloserId={detail.closer.id}
                        closers={detail.activeClosers}
                        onReassign={onReassign}
                      />
                    ) : (
                      <span className="text-[var(--muted-foreground)]">counted</span>
                    )}
                  </td>
                </tr>
              ))}
              {detail.cash.refunds.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{r.refundedAt ? formatDateShort(r.refundedAt) : "—"}</td>
                  <td className="py-1 pr-3">{r.prospectName}</td>
                  <td className="py-1 pr-3 uppercase text-[10px] tracking-wide">{r.leadSource === "self_sourced" ? "Self" : "Fed"}</td>
                  <td className="py-1 pr-3 text-right font-medium text-red-600">−{formatCents(r.refundedCents)}</td>
                  <td className="py-1 text-red-600">refund (collected {formatDateShort(r.paidAt)})</td>
                </tr>
              ))}
              {excludedPayments.map((p) => (
                <tr key={p.id} className="border-b last:border-0 text-[var(--muted-foreground)]">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDateShort(p.paidAt)}</td>
                  <td className="py-1 pr-3">{p.prospectName}</td>
                  <td className="py-1 pr-3 uppercase text-[10px] tracking-wide">{p.leadSource === "self_sourced" ? "Self" : "Fed"}</td>
                  <td className="py-1 pr-3 text-right line-through">{formatCents(p.amountCents)}</td>
                  <td className="py-1">not counted — {p.excludedReason}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-1.5 pr-3" colSpan={3}>Total (matches the board cell)</td>
                <td className={`py-1.5 pr-3 text-right ${detail.cash.totalCents >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCents(detail.cash.totalCents)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Deal-level closer reassignment, inline on the payment row. Moving a deal
// moves ALL its cash (and its close) to the new closer — audit-logged via the
// existing /api/deals PATCH.
function ReassignSelect({
  dealId,
  currentCloserId,
  closers,
  onReassign,
}: {
  dealId: string;
  currentCloserId: string;
  closers: { id: string; name: string }[];
  onReassign: (dealId: string, closerId: string) => void;
}) {
  return (
    <select
      className="text-xs border rounded px-1 py-0.5 bg-[var(--card)]"
      value={currentCloserId}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = e.target.value;
        if (next && next !== currentCloserId && confirm("Move this deal (all its cash + its close) to the selected closer? This is audit-logged.")) {
          onReassign(dealId, next);
        } else {
          e.target.value = currentCloserId;
        }
      }}
    >
      {closers.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}
