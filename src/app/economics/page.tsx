"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TimeDimensionToggle } from "@/components/time-dimension-toggle";
import { type TimeDimension } from "@/lib/time-range";
import { formatCents, formatDateShort, formatPercent, computeShowRate } from "@/lib/utils";

interface EconPeriod {
  label: string;
  start: string;
  end: string;
  bookedCalls: number;
  shows: number;
  closes: number;
  cohortCashCents: number;
  landedCashCents: number;
  unmatchedNewCents: number;
  cashPerCallCents: number;
  cashPerShowCents: number;
  cashPerCloseCents: number;
}

interface UnmatchedNewPayment {
  id: string;
  paidAt: string;
  name: string;
  email: string | null;
  amountCents: number;
}

interface EconDetail {
  demoRows: {
    id: string;
    demoDate: string;
    prospectName: string;
    setterName: string | null;
    closerName: string | null;
    status: string;
    dealStatus: string | null;
    upfrontCents: number;
  }[];
  setters: {
    id: string;
    name: string;
    bookedCalls: number;
    shows: number;
    noShows: number;
    cancelled: number;
    cashCents: number;
  }[];
  landedRows: {
    id: string;
    paidAt: string;
    prospectName: string;
    amountCents: number;
    counted: boolean;
    excludedReason: string | null;
    override: string | null;
  }[];
  refundRows: {
    id: string;
    refundedAt: string | null;
    prospectName: string;
    refundedCents: number;
  }[];
  unlinkedRows: {
    id: string;
    paidAt: string;
    name: string;
    email: string | null;
    amountCents: number;
    isNew: boolean;
  }[];
  closedRows: {
    id: string;
    prospectName: string;
    closedAt: string | null;
    closerName: string | null;
    demoDate: string | null;
    demoInPeriod: boolean;
  }[];
  activeClosers: { id: string; name: string }[];
}

interface DemoSearchResult {
  id: string;
  prospectName: string;
  demoDate: string;
  status: string;
  closerName: string | null;
  dealStatus: string | null;
}

const DEMO_STATUS_LABELS: Record<string, string> = {
  showed: "Showed",
  no_show: "No-Show",
  pending: "Pending",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled →",
};

export default function EconomicsPage() {
  const [granularity, setGranularity] = useState<TimeDimension>("weekly");
  const [periods, setPeriods] = useState<EconPeriod[]>([]);
  const [unmatchedNew, setUnmatchedNew] = useState<UnmatchedNewPayment[]>([]);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<EconDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setSelected(0);
    setDetail(null);
    fetch(`/api/economics?granularity=${granularity}`)
      .then((r) => r.json())
      .then((d) => { setPeriods(d.periods || []); setUnmatchedNew(d.unmatchedNewQueue || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [granularity]);

  const period = periods[selected] || null;
  const prior = periods[selected + 1] || null;

  const loadDetail = useCallback((p: EconPeriod) => {
    setDetailLoading(true);
    fetch(`/api/economics?detail=true&start=${encodeURIComponent(p.start)}&end=${encodeURIComponent(p.end)}`)
      .then((r) => r.json())
      .then((d) => { setDetail(d); setDetailLoading(false); })
      .catch(() => setDetailLoading(false));
  }, []);

  useEffect(() => {
    if (period) loadDetail(period);
  }, [period, loadDetail]);

  // Reconcile action: write the verdict/match via the audited payments PATCH,
  // then refetch the series — the detail refetches itself because the period
  // object identity changes, so every number on screen moves together.
  const reconcile = useCallback(async (paymentId: string, patch: Record<string, unknown>) => {
    setSaving(paymentId);
    try {
      await fetch("/api/payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId, ...patch }),
      });
      const d = await fetch(`/api/economics?granularity=${granularity}`).then((r) => r.json());
      setPeriods(d.periods || []);
      setUnmatchedNew(d.unmatchedNewQueue || []);
    } finally {
      setSaving(null);
    }
  }, [granularity]);

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--card)] rounded-xl border animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Sales Economics</h2>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            New cash landed in the period ÷ the calls, shows, and closes that happened in it
          </p>
        </div>
        <TimeDimensionToggle
          value={granularity}
          onChange={setGranularity}
          options={["weekly", "monthly", "all_time"]}
        />
      </div>

      {/* Unmatched new-client cash: one quiet line, not an alarm. Amber only when
          the SELECTED period has some (that's actionable now); the historical
          backlog is a gray aside. The reconcile drawer is where the work happens. */}
      {period && (period.unmatchedNewCents > 0 || unmatchedNew.length > 0) && (
        <div
          className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
            period.unmatchedNewCents > 0
              ? "border-yellow-300 bg-yellow-50 dark:bg-yellow-950/30 dark:border-yellow-700"
              : "border-[var(--border)] bg-[var(--card)]"
          }`}
        >
          <p className={period.unmatchedNewCents > 0 ? "text-yellow-800 dark:text-yellow-200" : "text-[var(--muted-foreground)]"}>
            {period.unmatchedNewCents > 0
              ? <>⚠ {formatCents(period.unmatchedNewCents)} of unmatched new-client cash in {period.label} isn&apos;t counted yet</>
              : <>No unmatched new cash in {period.label}</>}
            <span className="text-[var(--muted-foreground)]">
              {" "}· {formatCents(unmatchedNew.reduce((s, u) => s + u.amountCents, 0))} all-time backlog (mostly pre-tracking / Farm subs — use All-Time to sweep it)
            </span>
          </p>
          <button
            onClick={() => setReconcileOpen(true)}
            className="shrink-0 text-sm font-medium px-3 py-1 rounded-md border bg-[var(--card)] hover:bg-[var(--muted)]"
          >
            Reconcile →
          </button>
        </div>
      )}

      {period && (
        <>
          {/* Headline tiles for the selected period */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatTile
              label="Cash / booked call"
              valueCents={period.cashPerCallCents}
              context={`${period.bookedCalls} calls · ${period.label}`}
              priorCents={prior?.cashPerCallCents}
              priorLabel={prior?.label}
            />
            <StatTile
              label="Cash / show"
              valueCents={period.cashPerShowCents}
              context={`${period.shows} shows · ${period.label}`}
              priorCents={prior?.cashPerShowCents}
              priorLabel={prior?.label}
            />
            <StatTile
              label="Cash / close"
              valueCents={period.cashPerCloseCents}
              context={`${period.closes} closes · ${period.label}`}
              priorCents={prior?.cashPerCloseCents}
              priorLabel={prior?.label}
            />
            <StatTile
              label="Cash collected (landed)"
              valueCents={period.landedCashCents}
              context={`hit the bank ${granularity === "all_time" ? "all-time" : "in " + period.label}`}
              priorCents={prior?.landedCashCents}
              priorLabel={prior?.label}
              warning={period.unmatchedNewCents > 0 ? `+ ${formatCents(period.unmatchedNewCents)} unmatched new cash not counted` : undefined}
            />
          </div>

          {/* Period history */}
          {granularity !== "all_time" && (
            <div>
              <h3 className="text-lg font-semibold mb-2">
                By {granularity === "weekly" ? "week" : "month"}
                <span className="text-sm font-normal text-[var(--muted-foreground)] ml-2">click a row to inspect it</span>
              </h3>
              <div className="bg-[var(--card)] rounded-xl border overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm [font-variant-numeric:tabular-nums]">
                  <thead className="bg-[var(--muted)] border-b">
                    <tr>
                      <th className="text-left p-3 font-medium">Period</th>
                      <th className="text-right p-3 font-medium">Booked</th>
                      <th className="text-right p-3 font-medium">Shows</th>
                      <th className="text-right p-3 font-medium">Closes</th>
                      <th className="text-right p-3 font-medium">Cash/Call</th>
                      <th className="text-right p-3 font-medium">Cash/Show</th>
                      <th className="text-right p-3 font-medium">Cash/Close</th>
                      <th className="text-right p-3 font-medium" title="Upfront cash this period's demos have produced so far — restates upward as late closes land">Cohort Cash</th>
                      <th className="text-right p-3 font-medium" title="Cash that hit the bank in this period, net of refunds — never restates">Landed Cash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p, i) => (
                      <tr
                        key={p.label}
                        onClick={() => setSelected(i)}
                        className={`border-b last:border-0 cursor-pointer hover:bg-[var(--muted)]/50 ${i === selected ? "bg-[var(--muted)]/40 font-medium" : ""}`}
                      >
                        <td className="p-3 whitespace-nowrap">{p.label}</td>
                        <td className="p-3 text-right">{p.bookedCalls}</td>
                        <td className="p-3 text-right">{p.shows}</td>
                        <td className="p-3 text-right">{p.closes}</td>
                        <td className="p-3 text-right">{p.bookedCalls > 0 ? formatCents(p.cashPerCallCents) : "—"}</td>
                        <td className="p-3 text-right">{p.shows > 0 ? formatCents(p.cashPerShowCents) : "—"}</td>
                        <td className="p-3 text-right">{p.closes > 0 ? formatCents(p.cashPerCloseCents) : "—"}</td>
                        <td className="p-3 text-right">{formatCents(p.cohortCashCents)}</td>
                        <td className="p-3 text-right">{formatCents(p.landedCashCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mt-2">
                Per-X metrics = <span className="font-medium">landed cash</span> (new money that hit the bank in the period, net of refunds) ÷ the
                period&apos;s own activity: booked calls and shows by demo date, closes by close date. This shows new revenue THE WEEK it arrives and
                never restates — the trade-off is that late-collected cash divides over a different week&apos;s demos than the ones that earned it.
                Cohort Cash is the reference column for that: what each week&apos;s demos eventually produced (it grows as late closes land).
              </p>
            </div>
          )}

          {/* Receipts for the selected period */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">Receipts — {period.label}</h3>
              <button
                onClick={() => setReconcileOpen(true)}
                className="text-sm font-medium px-3 py-1.5 rounded-lg border bg-[var(--card)] hover:bg-[var(--muted)]"
              >
                Reconcile transactions{detail ? ` (${detail.landedRows.length + detail.unlinkedRows.length})` : ""}
              </button>
            </div>
            {detailLoading && <p className="text-sm text-[var(--muted-foreground)]">Loading receipts…</p>}
            {detail && !detailLoading && (
              <div className="space-y-5">
                {/* Setter economics */}
                <div>
                  <p className="font-medium text-sm mb-1">
                    Setter economics — cash landed this period via their bookings ÷ their activity this period
                  </p>
                  <div className="bg-[var(--card)] rounded-xl border overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm [font-variant-numeric:tabular-nums]">
                      <thead className="bg-[var(--muted)] border-b">
                        <tr>
                          <th className="text-left p-2.5 font-medium">Setter</th>
                          <th className="text-right p-2.5 font-medium">Booked Calls</th>
                          <th className="text-right p-2.5 font-medium">Shows</th>
                          <th className="text-right p-2.5 font-medium">Show Rate</th>
                          <th className="text-right p-2.5 font-medium">Cash Landed</th>
                          <th className="text-right p-2.5 font-medium">Cash/Call</th>
                          <th className="text-right p-2.5 font-medium">Cash/Show</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.setters.map((s) => {
                          const rateDenom = s.shows + s.noShows + s.cancelled;
                          return (
                            <tr key={s.id} className={`border-b last:border-0 ${s.id === "unattributed" || s.id === "other" || s.id === "organic" ? "text-[var(--muted-foreground)]" : ""}`}>
                              <td className="p-2.5">{s.name}</td>
                              <td className="p-2.5 text-right">{s.bookedCalls}</td>
                              <td className="p-2.5 text-right">{s.shows}</td>
                              <td className="p-2.5 text-right" title="shows ÷ (shows + no-shows + cancelled), pending excluded — same definition as the scoreboard">
                                {rateDenom > 0 ? formatPercent(computeShowRate(s.shows, s.noShows, s.cancelled)) : "—"}
                              </td>
                              <td className="p-2.5 text-right">{formatCents(s.cashCents)}</td>
                              <td className="p-2.5 text-right">{s.bookedCalls > 0 ? formatCents(Math.round(s.cashCents / s.bookedCalls)) : "—"}</td>
                              <td className="p-2.5 text-right">{s.shows > 0 ? formatCents(Math.round(s.cashCents / s.shows)) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Cohort demo rows */}
                <div>
                  <p className="font-medium text-sm mb-1">
                    Demos in this period ({detail.demoRows.length} rows) — the cohort behind booked/shows/closes and the per-X tiles
                  </p>
                  <div className="bg-[var(--card)] rounded-xl border overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full min-w-[560px] text-xs [font-variant-numeric:tabular-nums]">
                      <thead className="bg-[var(--muted)] border-b sticky top-0">
                        <tr>
                          <th className="text-left p-2 font-medium">Date</th>
                          <th className="text-left p-2 font-medium">Prospect</th>
                          <th className="text-left p-2 font-medium">Setter</th>
                          <th className="text-left p-2 font-medium">Closer</th>
                          <th className="text-left p-2 font-medium">Demo</th>
                          <th className="text-left p-2 font-medium">Deal</th>
                          <th className="text-right p-2 font-medium">Upfront Cash</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.demoRows.map((d) => (
                          <tr key={d.id} className={`border-b last:border-0 ${d.status === "rescheduled" ? "text-[var(--muted-foreground)] line-through" : ""}`}>
                            <td className="p-2 whitespace-nowrap">{formatDateShort(d.demoDate)}</td>
                            <td className="p-2">{d.prospectName}</td>
                            <td className="p-2">{d.setterName || <span className="text-[var(--muted-foreground)]">—</span>}</td>
                            <td className="p-2">{d.closerName || <span className="text-[var(--muted-foreground)]">—</span>}</td>
                            <td className="p-2">{DEMO_STATUS_LABELS[d.status] || d.status}</td>
                            <td className="p-2">{d.dealStatus ? d.dealStatus.replace("_", " ") : "—"}</td>
                            <td className={`p-2 text-right ${d.upfrontCents > 0 ? "text-green-600 font-medium" : "text-[var(--muted-foreground)]"}`}>
                              {d.upfrontCents > 0 ? formatCents(d.upfrontCents) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Closes in this period (by close date) */}
                <div>
                  <p className="font-medium text-sm mb-1">
                    Deals closed-won this period ({detail.closedRows.length}) — the closes denominator
                  </p>
                  {detail.closedRows.length === 0 ? (
                    <p className="text-sm text-[var(--muted-foreground)]">None.</p>
                  ) : (
                    <div className="bg-[var(--card)] rounded-xl border overflow-x-auto">
                      <table className="w-full min-w-[560px] text-xs [font-variant-numeric:tabular-nums]">
                        <thead className="bg-[var(--muted)] border-b">
                          <tr>
                            <th className="text-left p-2 font-medium">Closed</th>
                            <th className="text-left p-2 font-medium">Client</th>
                            <th className="text-left p-2 font-medium">Closer</th>
                            <th className="text-left p-2 font-medium">Demo ran</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.closedRows.map((d) => (
                            <tr key={d.id} className="border-b last:border-0">
                              <td className="p-2 whitespace-nowrap">{d.closedAt ? formatDateShort(d.closedAt) : "—"}</td>
                              <td className="p-2">{d.prospectName}</td>
                              <td className="p-2">{d.closerName || "—"}</td>
                              <td className="p-2">
                                {d.demoDate ? formatDateShort(d.demoDate) : <span className="text-[var(--muted-foreground)]">no demo (organic)</span>}
                                {d.demoDate && !d.demoInPeriod && (
                                  <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700">demo outside this period</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Landed payments */}
                <div>
                  <p className="font-medium text-sm mb-1">
                    Payments landed in this period — behind the &quot;Cash collected (landed)&quot; tile
                  </p>
                  <p className="text-xs text-[var(--muted-foreground)] mb-1 [font-variant-numeric:tabular-nums]">
                    Total money in: {formatCents(
                      detail.landedRows.reduce((s, p) => s + p.amountCents, 0) +
                      detail.unlinkedRows.reduce((s, p) => s + p.amountCents, 0)
                    )}
                    {" = "}{formatCents(detail.landedRows.filter((p) => p.counted).reduce((s, p) => s + p.amountCents, 0))} counted new
                    {" · "}{formatCents(detail.landedRows.filter((p) => !p.counted).reduce((s, p) => s + p.amountCents, 0))} reorders/excluded
                    {" · "}{formatCents(detail.unlinkedRows.reduce((s, p) => s + p.amountCents, 0))} unlinked
                  </p>
                  <div className="bg-[var(--card)] rounded-xl border overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full min-w-[560px] text-xs [font-variant-numeric:tabular-nums]">
                      <thead className="bg-[var(--muted)] border-b sticky top-0">
                        <tr>
                          <th className="text-left p-2 font-medium">Landed</th>
                          <th className="text-left p-2 font-medium">Client</th>
                          <th className="text-right p-2 font-medium">Amount</th>
                          <th className="text-left p-2 font-medium">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.landedRows.filter((p) => p.counted).map((p) => (
                          <tr key={p.id} className="border-b last:border-0">
                            <td className="p-2 whitespace-nowrap">{formatDateShort(p.paidAt)}</td>
                            <td className="p-2">{p.prospectName}</td>
                            <td className="p-2 text-right font-medium text-green-600">{formatCents(p.amountCents)}</td>
                            <td className="p-2 text-[var(--muted-foreground)]">counted</td>
                          </tr>
                        ))}
                        {detail.refundRows.map((r) => (
                          <tr key={r.id} className="border-b last:border-0">
                            <td className="p-2 whitespace-nowrap">{r.refundedAt ? formatDateShort(r.refundedAt) : "—"}</td>
                            <td className="p-2">{r.prospectName}</td>
                            <td className="p-2 text-right font-medium text-red-600">−{formatCents(r.refundedCents)}</td>
                            <td className="p-2 text-red-600">refund</td>
                          </tr>
                        ))}
                        {detail.landedRows.filter((p) => !p.counted).map((p) => (
                          <tr key={p.id} className="border-b last:border-0 text-[var(--muted-foreground)]">
                            <td className="p-2 whitespace-nowrap">{formatDateShort(p.paidAt)}</td>
                            <td className="p-2">{p.prospectName}</td>
                            <td className="p-2 text-right line-through">{formatCents(p.amountCents)}</td>
                            <td className="p-2">not counted — {p.excludedReason}</td>
                          </tr>
                        ))}
                        {detail.unlinkedRows.map((p) => (
                          <tr key={p.id} className={`border-b last:border-0 ${p.isNew ? "text-yellow-700 dark:text-yellow-400" : "text-[var(--muted-foreground)]"}`}>
                            <td className="p-2 whitespace-nowrap">{formatDateShort(p.paidAt)}</td>
                            <td className="p-2">{p.name}</td>
                            <td className={`p-2 text-right ${p.isNew ? "font-medium" : "line-through"}`}>{formatCents(p.amountCents)}</td>
                            <td className="p-2">
                              {p.isNew
                                ? "⚠ unmatched NEW cash — counts nowhere, match it on the Demos page"
                                : "unlinked — returning client (would be excluded anyway)"}
                            </td>
                          </tr>
                        ))}
                        <tr className="font-semibold">
                          <td className="p-2" colSpan={2}>Total (matches the landed tile)</td>
                          <td className={`p-2 text-right ${period.landedCashCents >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {formatCents(period.landedCashCents)}
                          </td>
                          <td />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {reconcileOpen && period && detail && (
        <ReconcileDrawer
          periodLabel={period.label}
          detail={detail}
          saving={saving}
          onClose={() => setReconcileOpen(false)}
          onReconcile={reconcile}
        />
      )}
    </div>
  );
}

function ReconcileDrawer({
  periodLabel,
  detail,
  saving,
  onClose,
  onReconcile,
}: {
  periodLabel: string;
  detail: EconDetail;
  saving: string | null;
  onClose: () => void;
  onReconcile: (paymentId: string, patch: Record<string, unknown>) => void;
}) {
  const rows = [
    ...detail.landedRows.map((p) => ({ kind: "linked" as const, ...p })),
    ...detail.unlinkedRows.map((p) => ({ kind: "unlinked" as const, ...p })),
  ].sort((a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime());

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-[var(--card)] border-l shadow-xl flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <p className="font-semibold">Reconcile — {periodLabel}</p>
            <p className="text-xs text-[var(--muted-foreground)]">
              Every transaction this period. Verdicts here are final — they flow into cash, the scoreboard, and commission, audit-logged.
            </p>
          </div>
          <button onClick={onClose} className="text-xl px-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]">×</button>
        </div>
        <div className="flex-1 overflow-y-auto divide-y">
          {rows.map((r) => (
            <div key={r.id} className={`p-3 text-sm ${saving === r.id ? "opacity-50" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{r.kind === "linked" ? r.prospectName : r.name}</p>
                  <p className="text-xs text-[var(--muted-foreground)]">{formatDateShort(r.paidAt)}</p>
                </div>
                <p className="font-semibold [font-variant-numeric:tabular-nums]">{formatCents(r.amountCents)}</p>
              </div>

              {r.kind === "linked" ? (
                <>
                  <p className={`text-xs mt-1 ${r.counted ? "text-green-600" : "text-[var(--muted-foreground)]"}`}>
                    {r.counted ? "✓ counted as new revenue" : `✗ not counted — ${r.excludedReason}`}
                    {r.override && <span className="ml-1 px-1 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px]">reconciled by hand</span>}
                  </p>
                  <div className="flex gap-1 mt-1.5">
                    <VerdictButton
                      label="New revenue"
                      active={r.override === "include"}
                      disabled={saving !== null}
                      onClick={() => onReconcile(r.id, { upfrontOverride: r.override === "include" ? null : "include" })}
                    />
                    <VerdictButton
                      label="Not new"
                      active={r.override === "exclude"}
                      disabled={saving !== null}
                      onClick={() => onReconcile(r.id, { upfrontOverride: r.override === "exclude" ? null : "exclude" })}
                    />
                    {r.override && (
                      <VerdictButton label="Auto" active={false} disabled={saving !== null} onClick={() => onReconcile(r.id, { upfrontOverride: null })} />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className={`text-xs mt-1 ${r.isNew ? "text-yellow-700 dark:text-yellow-400" : "text-[var(--muted-foreground)]"}`}>
                    {r.isNew ? "⚠ new client, unmatched — counts nowhere" : "unlinked — returning client"}
                    {r.email ? ` · ${r.email}` : ""}
                  </p>
                  <MatchControls
                    paymentId={r.id}
                    closers={detail.activeClosers}
                    disabled={saving !== null}
                    onReconcile={onReconcile}
                  />
                </>
              )}
            </div>
          ))}
          {detail.refundRows.map((r) => (
            <div key={r.id} className="p-3 text-sm text-red-600">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{r.prospectName}</p>
                  <p className="text-xs">refund · {r.refundedAt ? formatDateShort(r.refundedAt) : "—"}</p>
                </div>
                <p className="font-semibold [font-variant-numeric:tabular-nums]">−{formatCents(r.refundedCents)}</p>
              </div>
            </div>
          ))}
          {rows.length === 0 && detail.refundRows.length === 0 && (
            <p className="p-4 text-sm text-[var(--muted-foreground)]">No transactions this period.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Matcher for an unlinked payment: search demos across ALL weeks (late cash
// usually belongs to a past demo), or declare it organic — no demo — under a
// chosen closer. Organic keeps per-demo economics clean by design: the cash
// counts (landed, closer scoreboard, commission) but no cohort inherits it.
function MatchControls({
  paymentId,
  closers,
  disabled,
  onReconcile,
}: {
  paymentId: string;
  closers: { id: string; name: string }[];
  disabled: boolean;
  onReconcile: (paymentId: string, patch: Record<string, unknown>) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DemoSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/economics?demoSearch=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d) => { setResults(d.demos || []); setSearching(false); })
        .catch(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="mt-1.5 space-y-1.5">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Match to a demo — search any week by name…"
        disabled={disabled}
        className="w-full text-xs border rounded px-1.5 py-1 bg-[var(--card)]"
      />
      {searching && <p className="text-[10px] text-[var(--muted-foreground)]">searching…</p>}
      {results.length > 0 && (
        <div className="border rounded divide-y max-h-40 overflow-y-auto">
          {results.map((d) => (
            <button
              key={d.id}
              disabled={disabled}
              onClick={() => onReconcile(paymentId, { matchToDemoId: d.id })}
              className="w-full text-left text-xs px-1.5 py-1 hover:bg-[var(--muted)] disabled:opacity-50"
            >
              <span className="font-medium">{d.prospectName}</span> — {formatDateShort(d.demoDate)} · {d.status.replace("_", " ")}
              {d.closerName ? ` · ${d.closerName}` : ""}
              {d.dealStatus ? <span className="text-[var(--muted-foreground)]"> · deal {d.dealStatus.replace("_", " ")}</span> : ""}
            </button>
          ))}
        </div>
      )}
      {query.trim().length >= 2 && !searching && results.length === 0 && (
        <p className="text-[10px] text-[var(--muted-foreground)]">no demos match &quot;{query.trim()}&quot;</p>
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-[var(--muted-foreground)] shrink-0">or organic (no demo) —</span>
        <select
          className="flex-1 text-xs border rounded px-1.5 py-1 bg-[var(--card)]"
          defaultValue=""
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value && confirm("Count this as organic new revenue (no demo) under the selected closer? It will flow into their cash and commission. Audit-logged.")) {
              onReconcile(paymentId, { organicCloserId: e.target.value });
            } else {
              e.target.value = "";
            }
          }}
        >
          <option value="">new revenue under closer…</option>
          {closers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function VerdictButton({ label, active, disabled, onClick }: { label: string; active: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-xs px-2 py-1 rounded-md border font-medium ${
        active
          ? "bg-[var(--foreground)] text-[var(--background)] border-transparent"
          : "bg-[var(--card)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      }`}
    >
      {label}
    </button>
  );
}

function StatTile({
  label,
  valueCents,
  context,
  priorCents,
  priorLabel,
  warning,
}: {
  label: string;
  valueCents: number;
  context: string;
  priorCents?: number;
  priorLabel?: string;
  warning?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">{label}</p>
        <p className={`text-2xl md:text-3xl font-bold tracking-tight mt-1 ${valueCents > 0 ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}`}>
          {valueCents !== 0 ? formatCents(valueCents) : "—"}
        </p>
        <p className="text-xs text-[var(--muted-foreground)]">{context}</p>
        {priorCents !== undefined && priorLabel && (
          <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
            prior ({priorLabel}): {priorCents !== 0 ? formatCents(priorCents) : "—"}
          </p>
        )}
        {warning && <p className="text-xs text-yellow-700 dark:text-yellow-400 font-medium mt-0.5">⚠ {warning}</p>}
      </CardContent>
    </Card>
  );
}
