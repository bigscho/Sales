"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBar } from "@/components/ui/status-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import { useSession } from "@/components/app-shell";
import { CloserStatsPanel } from "@/components/closer-stats";


interface TeamMember { id: string; name: string; role: string }

interface DemoRecord {
  id: string;
  status: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  notes: string | null;
  hasFirefliesRecording: boolean;
  booking: {
    id: string;
    prospectName: string;
    prospectEmail: string | null;
    prospectPhone: string | null;
    demoDate: string;
    createdAt: string;
    source: string;
    leadSource: string;
    setter: { id: string; name: string } | null;
  };
  closer: { id: string; name: string } | null;
  deal: { id: string; status: string } | null;
}

interface DayLockRecord {
  id: string;
  date: string;
  dayOfWeek: number;
  demoCount: number;
  showCount: number;
  noShowCount: number;
  cashCents: number;
}

interface PaymentRecord {
  id: string;
  amountCents: number;
  refundedCents: number;
  customerName: string | null;
  customerEmail: string | null;
  paidAt: string;
  status: string;
  revenueType: string;
  revenueTypeOverride: string | null;
  customerStatus: string;
  customerStatusOverride: string | null;
  matchStatus: string;
  isSubscription: boolean;
}

const statusOptions = [
  { value: "pending", label: "Pending" },
  { value: "showed", label: "Showed" },
  { value: "no_show", label: "No Show" },
  { value: "cancelled", label: "Cancelled" },
  // Frozen originals of rescheduled bookings (immutable-history model) — the
  // meeting moved to a successor row; this row is history, not a live demo.
  { value: "rescheduled", label: "Rescheduled →" },
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Cash net of refunds — refunded money is not collected
function netCents(p: { amountCents: number; refundedCents?: number; status?: string }): number {
  if (p.status === "failed") return 0;
  return p.amountCents - (p.refundedCents || 0);
}

// Sales views show UPFRONT cash only (charges within 24h of a deal's first
// payment, first-time clients) — renewals/reorders live in Stripe.
const UPFRONT_WINDOW_MS = 24 * 60 * 60 * 1000;

function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return fullName;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr).getDay();
}

function getDateLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function toDateKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function DemosPage() {
  const searchParams = useSearchParams();
  const session = useSession();
  // Closers get a read-mostly view: their own demos, status + FED/SELF edits
  // only — no deletes, locks, bulk ops, setter reassignment, or payment edits.
  const isCloser = session?.role === "closer" && !session?.isAdmin;
  const weekId = searchParams.get("weekId") || "";
  const setterFilter = searchParams.get("setter") || "";
  const [demos, setDemos] = useState<DemoRecord[]>([]);
  const [todayBookings, setTodayBookings] = useState<DemoRecord[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [dayLocks, setDayLocks] = useState<DayLockRecord[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<number>(new Date().getDay());
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [matchingPaymentId, setMatchingPaymentId] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<number>>(new Set());
  const initialLoad = useRef(true);

  const loadData = useCallback(() => {
    if (!weekId) return;
    // Only show skeleton on very first load — subsequent refreshes update silently
    if (initialLoad.current) setLoading(true);
    const demoParams = new URLSearchParams({ weekId });
    if (setterFilter) demoParams.set("setter", setterFilter);
    Promise.all([
      fetch(`/api/demos?${demoParams}`).then((r) => r.json()),
      fetch("/api/team").then((r) => r.json()),
      fetch(`/api/demos/lock?weekId=${weekId}`).then((r) => r.json()),
      fetch(`/api/deals?weekId=${weekId}`).then((r) => r.json()),
      fetch("/api/demos/today").then((r) => r.json()),
    ]).then(([demoData, teamData, lockData, dealData, todayData]) => {
      setDemos(demoData.demos || []);
      setTodayBookings(todayData.demos || []);
      setTeam(teamData.members || []);
      setDayLocks(lockData.dayLocks || []);
      const allPayments: PaymentRecord[] = [];
      for (const deal of dealData.deals || []) {
        const pays: PaymentRecord[] = (deal.payments || []).filter((p: PaymentRecord) => p.status !== "failed");
        if (pays.length === 0) continue;
        const first = pays.reduce((a, b) => (new Date(a.paidAt) <= new Date(b.paidAt) ? a : b));
        // Reorder deal (existing client's repeat purchase) — not sales cash
        if ((first.customerStatusOverride || first.customerStatus) === "returning") continue;
        const firstMs = new Date(first.paidAt).getTime();
        for (const p of pays) {
          // Later charges (renewals / additional orders) are Stripe's story, not the sales feed's
          if (new Date(p.paidAt).getTime() - firstMs > UPFRONT_WINDOW_MS) continue;
          allPayments.push({ ...p, customerName: deal.prospectName, customerEmail: deal.prospectEmail });
        }
      }
      // Unmatched payments stay visible — they're the match work-queue — unless clearly returning revenue
      for (const p of dealData.unlinkedPayments || []) {
        if ((p.customerStatusOverride || p.customerStatus) === "returning") continue;
        allPayments.push(p);
      }
      setPayments(allPayments);
      setLoading(false);
      initialLoad.current = false;
    });
  }, [weekId, setterFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh from database every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => { loadData(); }, 60000);
    return () => clearInterval(interval);
  }, [loadData]);

  const updateDemo = async (demoId: string, data: Record<string, unknown>) => {
    const res = await fetch("/api/demos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoId, ...data }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || "Failed to update");
      return;
    }
    loadData();
  };

  const bulkMarkDay = async (dayDemos: DemoRecord[], status: string) => {
    const pendingIds = dayDemos.filter((d) => d.status === "pending").map((d) => d.id);
    if (pendingIds.length === 0) return;
    await fetch("/api/demos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bulk_confirm", demoIds: pendingIds, status }),
    });
    loadData();
  };

  const lockDay = async (dayDate: string) => {
    const res = await fetch("/api/demos/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekId, date: dayDate }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Failed to lock day");
      return;
    }
    if (data.weekConfirmed) {
      alert("All days locked — week confirmed!");
    }
    loadData();
  };

  const unlockDay = async (dayDate: string) => {
    await fetch("/api/demos/lock", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekId, date: dayDate }),
    });
    loadData();
  };

  const deleteDemo = async (demoId: string, prospectName: string) => {
    const warning =
      `DELETE "${prospectName}"?\n\n` +
      `This permanently removes the booking AND blocks gcal_sync from ever recreating it.\n\n` +
      `If the prospect didn't show — use "No Show" instead.\n` +
      `If they cancelled — use "Cancelled" instead.\n\n` +
      `Only click OK if this row is genuinely a duplicate or junk that should never come back.`;
    if (!confirm(warning)) return;
    const res = await fetch("/api/demos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoId }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || "Failed to delete");
      return;
    }
    loadData();
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (demosList: DemoRecord[]) => {
    const allIds = demosList.map((d) => d.id);
    const allSelected = allIds.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        allIds.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const bulkAction = async (action: "showed" | "no_show" | "delete") => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (action === "delete") {
      // Show prospect names so the operator can sanity-check what's about to vanish.
      const selected = demos.filter((d) => ids.includes(d.id));
      const names = selected.map((d) => d.booking.prospectName).join(", ");
      const warning =
        `DELETE ${ids.length} demo(s)?\n\n` +
        `Prospects: ${names}\n\n` +
        `This permanently removes the bookings AND blocks gcal_sync from ever recreating them.\n\n` +
        `If you meant to mark them as no-shows — use "Mark No Show" instead.\n\n` +
        `Type DELETE to confirm:`;
      const confirmation = prompt(warning);
      if (confirmation !== "DELETE") return;
      for (const id of ids) {
        await fetch("/api/demos", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ demoId: id }),
        });
      }
    } else {
      await fetch("/api/demos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk_confirm", demoIds: ids, status: action }),
      });
    }
    setSelectedIds(new Set());
    loadData();
  };

  const addDemo = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await fetch("/api/demos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        weekId,
        prospectName: form.get("prospectName"),
        prospectEmail: form.get("prospectEmail"),
        setterId: form.get("setterId") || null,
        closerId: form.get("closerId") || null,
        demoDate: form.get("demoDate"),
      }),
    });
    setShowAddForm(false);
    loadData();
  };

  if (!weekId) return <p className="text-[var(--muted-foreground)]">Select a week first</p>;

  const setters = team.filter((m) => m.role === "setter");
  const closers = team.filter((m) => m.role === "closer");

  // Group demos by day
  const demosByDay: Record<number, DemoRecord[]> = {};
  for (let i = 0; i < 7; i++) demosByDay[i] = [];
  for (const demo of demos) {
    const day = getDayOfWeek(demo.booking.demoDate);
    demosByDay[day].push(demo);
  }

  // Build lock lookup
  const locksByDay: Record<number, DayLockRecord> = {};
  for (const lock of dayLocks) {
    locksByDay[lock.dayOfWeek] = lock;
  }

  // Get actual date keys for each day of the week (for payment matching)
  const weekDates: Record<number, string> = {};
  const weekDateKeys: Record<number, string> = {};
  for (const demo of demos) {
    const day = getDayOfWeek(demo.booking.demoDate);
    if (!weekDates[day]) {
      weekDates[day] = demo.booking.demoDate;
      weekDateKeys[day] = toDateKey(demo.booking.demoDate);
    }
  }

  // Overall stats
  const totalShowed = demos.filter((d) => d.status === "showed").length;
  const totalNoShow = demos.filter((d) => d.status === "no_show").length;
  const totalPending = demos.filter((d) => d.status === "pending").length;

  // Selected day data
  const selectedDemos = demosByDay[selectedDay] || [];
  const selectedLock = locksByDay[selectedDay];
  const selectedDayDate = weekDates[selectedDay];
  const selectedDateKey = weekDateKeys[selectedDay];

  // Payment filtering: match by actual date, not just day-of-week
  const selectedPayments = payments.filter((p) => toDateKey(p.paidAt) === selectedDateKey);

  const selectedShowed = selectedDemos.filter((d) => d.status === "showed").length;
  const selectedNoShow = selectedDemos.filter((d) => d.status === "no_show").length;
  const selectedPending = selectedDemos.filter((d) => d.status === "pending").length;
  // Demos and payments to display based on view mode
  const displayPayments = viewMode === "week" ? payments : selectedPayments;
  const displayShowed = viewMode === "week" ? totalShowed : selectedShowed;
  const displayNoShow = viewMode === "week" ? totalNoShow : selectedNoShow;
  const displayPending = viewMode === "week" ? totalPending : selectedPending;

  // Helper to render the demo table
  const renderDemoTable = (demosToShow: DemoRecord[], isWeekView: boolean) => (
    <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 border-b px-4 py-2 flex items-center justify-between">
          <span className="text-sm font-medium text-blue-700">{selectedIds.size} selected</span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => bulkAction("showed")}>Mark Showed</Button>
            <Button size="sm" variant="destructive" onClick={() => bulkAction("no_show")}>Mark No Show</Button>
            <Button size="sm" variant="ghost" onClick={() => bulkAction("delete")}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear</Button>
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: "800px" }}>
        <thead className="bg-[var(--muted)] border-b">
          <tr>
            {!isCloser && (
              <th className="p-2 pl-3 w-8">
                <input
                  type="checkbox"
                  checked={demosToShow.length > 0 && demosToShow.every((d) => selectedIds.has(d.id))}
                  onChange={() => toggleSelectAll(demosToShow)}
                  className="rounded"
                />
              </th>
            )}
            {isWeekView && <th className="text-left p-2 font-medium w-12 text-xs">Day</th>}
            <th className="text-left p-2 font-medium">Prospect</th>
            <th className="text-left p-2 font-medium w-16">Time</th>
            <th className="text-left p-2 font-medium w-24">Setter</th>
            <th className="text-left p-2 font-medium w-16">Closer</th>
            <th className="text-left p-2 font-medium w-14">Source</th>
            <th className="text-left p-2 font-medium w-20">Status</th>
            <th className="text-left p-2 font-medium whitespace-nowrap">Confirmed By</th>
            {!isCloser && <th className="p-2 w-8"></th>}
          </tr>
        </thead>
        <tbody>
          {demosToShow.map((demo) => {
            const demoDay = getDayOfWeek(demo.booking.demoDate);
            const dayLock = locksByDay[demoDay];
            return (
              <tr key={demo.id} className={`border-b last:border-0 ${
                selectedIds.has(demo.id) ? "bg-blue-50/50" :
                demo.status === "showed" ? "bg-green-50/30" :
                demo.status === "no_show" ? "bg-red-50/30" :
                demo.status === "pending" ? "bg-yellow-50/30" : ""
              }`}>
                {!isCloser && (
                  <td className="p-2 pl-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(demo.id)}
                      onChange={() => toggleSelect(demo.id)}
                      className="rounded"
                    />
                  </td>
                )}
                {isWeekView && (
                  <td className="p-2 text-xs font-medium text-[var(--muted-foreground)]">
                    {DAY_NAMES[demoDay]}
                  </td>
                )}
                <td className="p-2">
                  <div className="font-medium truncate max-w-[160px]">{demo.booking.prospectName}</div>
                  {demo.booking.prospectEmail && (
                    <div className="text-xs text-[var(--muted-foreground)] truncate max-w-[160px]">{demo.booking.prospectEmail}</div>
                  )}
                </td>
                <td className="p-2 text-[var(--muted-foreground)] whitespace-nowrap">
                  {new Date(demo.booking.demoDate).toLocaleTimeString("en-US", {
                    hour: "numeric", minute: "2-digit", hour12: true,
                  })}
                </td>
                <td className="p-2">
                  {isCloser ? (
                    <span className="text-xs">{demo.booking.setter?.name || "—"}</span>
                  ) : (
                    <select
                      value={demo.booking.setter?.id || ""}
                      onChange={(e) => updateDemo(demo.id, { setterId: e.target.value || null })}
                      disabled={!!dayLock}
                      className={`border rounded px-2 py-1 text-xs ${dayLock ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      <option value="">—</option>
                      {setters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                </td>
                <td className="p-2">{demo.closer?.name || "—"}</td>
                <td className="p-2">
                  <button
                    onClick={() => {
                      if (dayLock) return;
                      updateDemo(demo.id, { leadSource: demo.booking.leadSource === "self_sourced" ? "fed" : "self_sourced" });
                    }}
                    disabled={!!dayLock}
                    title={demo.booking.leadSource === "self_sourced"
                      ? "Self-sourced by the closer (25%) — click to change to Fed"
                      : "Fed / SDR-booked (16%) — click to change to Self-sourced"}
                    className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold transition-opacity ${
                      dayLock ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:opacity-70"
                    } ${
                      demo.booking.leadSource === "self_sourced"
                        ? "bg-purple-100 text-purple-700"
                        : "bg-[var(--muted)] text-[var(--muted-foreground)]"
                    }`}
                  >
                    {demo.booking.leadSource === "self_sourced" ? "SELF" : "FED"}
                  </button>
                </td>
                <td className="p-2">
                  <select
                    value={demo.status}
                    onChange={(e) => updateDemo(demo.id, { status: e.target.value })}
                    disabled={!!dayLock}
                    className={`border rounded px-2 py-1 text-xs font-medium ${
                      dayLock ? "opacity-50 cursor-not-allowed " : ""
                    }${
                      demo.status === "showed" ? "bg-green-100 text-green-700 border-green-300" :
                      demo.status === "no_show" ? "bg-red-100 text-red-700 border-red-300" :
                      demo.status === "pending" ? "bg-yellow-100 text-yellow-700 border-yellow-300" :
                      demo.status === "rescheduled" ? "bg-[var(--muted)] text-[var(--muted-foreground)] border-[var(--border)] opacity-70" :
                      "bg-[var(--muted)] text-[var(--foreground)] border-[var(--border)]"
                    }`}
                  >
                    {statusOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </td>
                <td className="p-2 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    {demo.confirmedBy && (
                      <span className={`text-xs font-medium inline-flex items-center gap-1 ${
                        demo.confirmedBy === "fireflies_auto" ? "text-pink-500" :
                        demo.confirmedBy === "payment_auto" ? "text-blue-600" :
                        demo.confirmedBy === "calendly_webhook" ? "text-orange-600" :
                        "text-green-600"
                      }`}>
                        {demo.confirmedBy === "fireflies_auto" ? (
                          <><svg width="14" height="14" viewBox="0 0 24 24" fill="#E6356F"><rect x="2" y="2" width="9" height="9" rx="2"/><rect x="13" y="2" width="9" height="9" rx="2"/><rect x="2" y="13" width="9" height="9" rx="2"/><rect x="13" y="13" width="9" height="5" rx="2"/></svg> Fireflies</>
                        ) : demo.confirmedBy === "payment_auto" ? (
                          <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> Payment</>
                        ) : demo.confirmedBy === "calendly_webhook" ? (
                          "Calendly"
                        ) : demo.confirmedBy === "gcal_sync" ? (
                          "Calendar"
                        ) : (
                          demo.confirmedBy
                        )}
                      </span>
                    )}
                    {/* Fireflies badge inline next to confirmer */}
                    {demo.hasFirefliesRecording && demo.confirmedBy !== "fireflies_auto" && (
                      <span className="text-xs font-medium inline-flex items-center gap-1 text-pink-500" title="Verified by Fireflies transcript">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="#E6356F"><rect x="2" y="2" width="9" height="9" rx="2"/><rect x="13" y="2" width="9" height="9" rx="2"/><rect x="2" y="13" width="9" height="9" rx="2"/><rect x="13" y="13" width="9" height="5" rx="2"/></svg> Fireflies
                      </span>
                    )}
                    {!demo.confirmedBy && demo.status === "pending" && (
                      demo.notes?.includes("no_transcript") ? (
                        <span className="text-xs text-orange-500 inline-flex items-center gap-1">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          No transcript
                        </span>
                      ) : (
                        <Badge variant="warning">Needs Review</Badge>
                      )
                    )}
                  </div>
                </td>
                {!isCloser && <td className="p-2">
                  {!dayLock && (
                    <button
                      onClick={() => deleteDemo(demo.id, demo.booking.prospectName)}
                      className="text-[var(--muted-foreground)]/70 hover:text-red-500 transition-colors"
                      title="Remove demo"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </td>}
              </tr>
            );
          })}
          {demosToShow.length === 0 && (
            <tr>
              <td colSpan={(isWeekView ? 10 : 9) - (isCloser ? 2 : 0)} className="p-8 text-center text-[var(--muted-foreground)]">
                {isWeekView ? "No demos this week" : `No demos on ${DAY_NAMES[selectedDay]}`}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );

  // Helper to render the financial feed
  const renderFinancialFeed = (paymentsToShow: PaymentRecord[], isWeekView: boolean) => {
    // Helper to get effective values (override takes priority)
    const getType = (p: PaymentRecord) => p.revenueTypeOverride || p.revenueType;
    const getStatus = (p: PaymentRecord) => p.customerStatusOverride || p.customerStatus;

    // Totals by revenue type
    const mrrTotal = paymentsToShow.filter((p) => getType(p) === "mrr").reduce((s, p) => s + netCents(p), 0);
    const oneTimeTotal = paymentsToShow.filter((p) => getType(p) === "one_time").reduce((s, p) => s + netCents(p), 0);
    const miscTotal = paymentsToShow.filter((p) => getType(p) === "misc" || getType(p) === "unknown").reduce((s, p) => s + netCents(p), 0);

    // New revenue = new MRR + new one-time (the sales KPI)
    const newRevenue = paymentsToShow.filter((p) => getStatus(p) === "new").reduce((s, p) => s + netCents(p), 0);
    const returningRevenue = paymentsToShow.filter((p) => getStatus(p) === "returning").reduce((s, p) => s + netCents(p), 0);

    // Revenue type cycle order
    const revenueTypeCycle: Record<string, string> = { mrr: "one_time", one_time: "misc", misc: "mrr", unknown: "mrr" };

    // Badge components — read-only for closers (payment overrides are ops-only)
    const typeBadge = (p: PaymentRecord) => {
      const type = getType(p);
      const nextType = revenueTypeCycle[type] || "mrr";
      const handleClick = isCloser ? undefined : (e: React.MouseEvent) => {
        e.stopPropagation();
        fetch('/api/payments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentId: p.id, revenueTypeOverride: nextType })
        }).then(() => loadData());
      };
      const base = `inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${isCloser ? "" : "cursor-pointer transition-opacity hover:opacity-70"}`;
      if (type === "mrr") return <span onClick={handleClick} title={`Click to change to One-time`} className={`${base} bg-blue-100 text-blue-700`}>MRR</span>;
      if (type === "one_time") return <span onClick={handleClick} title={`Click to change to Misc`} className={`${base} bg-orange-100 text-orange-700`}>One-time</span>;
      if (type === "misc") return <span onClick={handleClick} title={`Click to change to MRR`} className={`${base} bg-[var(--muted)] text-[var(--muted-foreground)]`}>Misc</span>;
      return <span onClick={handleClick} title={`Click to change to MRR`} className={`${base} bg-yellow-100 text-yellow-600`}>Unknown</span>;
    };

    const statusBadge = (p: PaymentRecord) => {
      const status = getStatus(p);
      const nextStatus = status === "new" ? "returning" : "new";
      const handleClick = isCloser ? undefined : (e: React.MouseEvent) => {
        e.stopPropagation();
        fetch('/api/payments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentId: p.id, customerStatusOverride: nextStatus })
        }).then(() => loadData());
      };
      const base = `inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold ${isCloser ? "" : "cursor-pointer transition-opacity hover:opacity-70"}`;
      if (status === "new") return <span onClick={handleClick} title="Click to change to Returning" className={`${base} bg-green-100 text-green-700`}>NEW</span>;
      if (status === "returning") return <span onClick={handleClick} title="Click to change to New" className={`${base} bg-blue-50 text-blue-600`}>RTN</span>;
      return null;
    };

    return (
      <div className="bg-[var(--card)] rounded-xl border overflow-hidden h-full">
        <div className="px-4 py-3 border-b bg-[var(--muted)] flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {isWeekView ? "Week Payments" : `Payments — ${DAY_NAMES[selectedDay]}`}
            {!isWeekView && selectedDayDate && ` ${getDateLabel(selectedDayDate)}`}
          </h3>
          <span className="text-sm font-bold text-green-600">
            {formatCents(paymentsToShow.reduce((s, p) => s + netCents(p), 0))}
          </span>
        </div>
        {paymentsToShow.length > 0 ? (
          <>
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr>
                  {isWeekView && <th className="text-left p-2 pl-4 font-medium text-xs text-[var(--muted-foreground)]">Day</th>}
                  <th className="text-left p-2 pl-4 font-medium text-xs text-[var(--muted-foreground)]">Customer</th>
                  <th className="text-left p-2 font-medium text-xs text-[var(--muted-foreground)]">Type</th>
                  <th className="text-right p-2 pr-4 font-medium text-xs text-[var(--muted-foreground)]">Amount</th>
                </tr>
              </thead>
              <tbody>
                {paymentsToShow.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    {isWeekView && (
                      <td className="p-2 pl-4 text-xs text-[var(--muted-foreground)]">{DAY_NAMES[getDayOfWeek(p.paidAt)]}</td>
                    )}
                    <td className="p-2 pl-4 text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        {p.customerName || p.customerEmail || "Unknown"}
                        {p.matchStatus === "matched" ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline-block flex-shrink-0">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (p.matchStatus === "needs_review" || p.matchStatus === "unmatched") && !isCloser ? (
                          <span className="relative inline-block">
                            <span
                              className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-yellow-100 text-yellow-600 text-xs font-bold flex-shrink-0 cursor-pointer transition-opacity hover:opacity-70 hover:bg-yellow-200"
                              title="Click to match to a demo"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMatchingPaymentId(matchingPaymentId === p.id ? null : p.id);
                              }}
                            >?</span>
                            {matchingPaymentId === p.id && (
                              <div className="absolute left-0 top-6 z-50 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg w-64 max-h-48 overflow-y-auto">
                                <div className="px-3 py-2 border-b text-xs font-medium text-[var(--muted-foreground)]">Match to demo:</div>
                                {demos.filter(d => d.status === "showed" || d.status === "pending").length === 0 ? (
                                  <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]/70">No demos available</div>
                                ) : (
                                  demos.filter(d => d.status === "showed" || d.status === "pending").map(d => (
                                    <button
                                      key={d.id}
                                      className="w-full text-left px-3 py-2 text-xs hover:bg-green-50 border-b last:border-0 flex items-center justify-between"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        await fetch("/api/payments", {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ paymentId: p.id, matchToDemoId: d.id }),
                                        });
                                        setMatchingPaymentId(null);
                                        loadData();
                                      }}
                                    >
                                      <div>
                                        <span className="font-medium">{d.booking.prospectName}</span>
                                        <span className="text-[var(--muted-foreground)]/70 ml-1">
                                          {new Date(d.booking.demoDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                        </span>
                                      </div>
                                      <span className="text-[var(--muted-foreground)]/70">{d.closer?.name || ""}</span>
                                    </button>
                                  ))
                                )}
                                <button
                                  className="w-full text-left px-3 py-1.5 text-xs text-[var(--muted-foreground)]/70 hover:bg-[var(--muted)]"
                                  onClick={(e) => { e.stopPropagation(); setMatchingPaymentId(null); }}
                                >Cancel</button>
                              </div>
                            )}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1">
                        {typeBadge(p)}
                        {statusBadge(p)}
                      </div>
                    </td>
                    <td className="p-2 pr-4 text-right font-medium text-green-600">
                      {formatCents(netCents(p))}
                      {p.refundedCents > 0 && (
                        <span className="text-red-500 text-xs ml-1" title={`${formatCents(p.refundedCents)} refunded`}>↩</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Summary totals */}
            <div className="border-t bg-[var(--muted)] px-4 py-3 space-y-2">
              {/* New Revenue highlight */}
              {newRevenue > 0 && (
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700">NEW</span>
                    New Revenue
                  </span>
                  <span className="text-green-700">{formatCents(newRevenue)}</span>
                </div>
              )}
              {returningRevenue > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-blue-50 text-blue-600">RTN</span>
                    Returning Revenue
                  </span>
                  <span className="font-semibold text-blue-600">{formatCents(returningRevenue)}</span>
                </div>
              )}
              <div className="border-t pt-2 space-y-1">
                <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                  <span>MRR</span><span>{formatCents(mrrTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                  <span>One-time</span><span>{formatCents(oneTimeTotal)}</span>
                </div>
                {miscTotal > 0 && (
                  <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                    <span>Misc</span><span>{formatCents(miscTotal)}</span>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="p-6 text-center text-[var(--muted-foreground)]/70 text-sm">
            {isWeekView ? "No payments this week" : "No payments today"}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Closer self-serve numbers — live where they confirm shows */}
      {isCloser && <CloserStatsPanel />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Demo Management</h2>
          {setterFilter && (
            <p className="text-sm text-[var(--teal)] mt-1">
              Filtered by setter — <a href={`/demos?weekId=${weekId}`} className="underline">show all</a>
            </p>
          )}
        </div>
        {!isCloser && <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>+ Add Demo</Button>}
      </div>

      {showAddForm && (
        <Card>
          <CardHeader><CardTitle>Add Demo Manually</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addDemo} className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <input name="prospectName" placeholder="Prospect Name" required className="border rounded-lg px-3 py-2 text-sm" />
              <input name="prospectEmail" placeholder="Email" className="border rounded-lg px-3 py-2 text-sm" />
              <input name="demoDate" type="datetime-local" required className="border rounded-lg px-3 py-2 text-sm" />
              <select name="setterId" className="border rounded-lg px-3 py-2 text-sm">
                <option value="">Setter</option>
                {setters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <div className="flex gap-2">
                <select name="closerId" className="border rounded-lg px-3 py-2 text-sm flex-1">
                  <option value="">Closer</option>
                  {closers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <Button type="submit" size="sm">Add</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ===== TOP: WEEK CALENDAR VIEW ===== */}
      {loading ? (
        <div className="overflow-x-auto">
          <div className="grid grid-cols-7 gap-2 min-w-[720px]">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-32 bg-[var(--card)] rounded-xl border animate-pulse" />
            ))}
          </div>
        </div>
      ) : (
        <div className="py-2 px-1 overflow-x-auto">
          <div className="grid grid-cols-7 gap-2 min-w-[720px]">
            {[0, 1, 2, 3, 4, 5, 6].map((dayIndex) => {
              const dayDemos = demosByDay[dayIndex];
              const isToday = new Date().getDay() === dayIndex;
              const isSelected = selectedDay === dayIndex && viewMode === "day";
              const lock = locksByDay[dayIndex];
              const dateLabel = weekDates[dayIndex] ? getDateLabel(weekDates[dayIndex]) : "";
              const dayShowed = dayDemos.filter((d) => d.status === "showed").length;
              const dayTotal = dayDemos.length;

              return (
                <div
                  key={dayIndex}
                  onClick={() => { setSelectedDay(dayIndex); setViewMode("day"); }}
                  className={`rounded-xl border bg-[var(--card)] flex flex-col min-h-[160px] max-h-[280px] cursor-pointer transition-all relative ${
                    isSelected ? "ring-2 ring-[var(--primary)] shadow-md" :
                    isToday ? "border-[var(--primary)]" :
                    "border-[var(--border)] hover:shadow-sm"
                  }`}
                >
                  <div className={`px-2.5 py-2 border-b rounded-t-xl flex items-center justify-between ${
                    isSelected ? "bg-green-50" : isToday ? "bg-green-50/50" : "bg-[var(--muted)]"
                  }`}>
                    <div>
                      <span className={`text-sm font-semibold ${isSelected || isToday ? "text-[var(--primary)]" : ""}`}>
                        {DAY_NAMES[dayIndex]}
                      </span>
                      {dateLabel && <span className="text-xs text-[var(--muted-foreground)] ml-1">{dateLabel}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      {dayTotal > 0 && <span className="text-xs font-medium text-[var(--muted-foreground)]">{dayTotal}</span>}
                      {lock && <span className="text-xs">🔒</span>}
                    </div>
                  </div>

                  {lock && (
                    <div className="absolute inset-0 top-[38px] bg-[var(--card)]/75 backdrop-blur-[1px] rounded-b-xl flex flex-col items-center justify-center z-10 pointer-events-none">
                      <span className="text-lg">🔒</span>
                      <p className="text-sm font-bold mt-1">{lock.showCount}/{lock.demoCount} showed</p>
                      <p className="text-xs text-[var(--muted-foreground)]">
                        {(lock.showCount + lock.noShowCount) > 0 ? ((lock.showCount / (lock.showCount + lock.noShowCount)) * 100).toFixed(0) : 0}% show rate
                      </p>
                      {lock.cashCents > 0 && !isCloser && (
                        <p className="text-xs font-medium text-green-600 mt-0.5">{formatCents(lock.cashCents)}</p>
                      )}
                    </div>
                  )}

                  <div className="flex-1 p-1.5 space-y-1 overflow-y-auto">
                    {dayDemos.length === 0 && (
                      <p className="text-xs text-[var(--muted-foreground)]/70 text-center py-3">No demos</p>
                    )}
                    {dayDemos.map((demo) => (
                      <div
                        key={demo.id}
                        className={`rounded px-2 py-1 text-xs ${
                          demo.status === "showed" ? "bg-green-50 text-green-800" :
                          demo.status === "no_show" ? "bg-red-50 text-red-800" :
                          demo.status === "cancelled" || demo.status === "rescheduled" ? "bg-[var(--muted)] text-[var(--muted-foreground)]/70 line-through" :
                          "bg-yellow-50 text-yellow-800"
                        }`}
                      >
                        <span className="font-medium" title={demo.booking.prospectName}>
                          {shortName(demo.booking.prospectName)}
                        </span>
                        <span className="text-[var(--muted-foreground)]/70 ml-1">
                          {new Date(demo.booking.demoDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                        </span>
                      </div>
                    ))}
                  </div>

                  {dayTotal > 0 && !lock && (
                    <div className="px-2 py-1 border-t text-xs text-[var(--muted-foreground)] flex justify-between">
                      <span>{dayShowed}✓ {dayTotal - dayShowed - dayDemos.filter(d => d.status === "cancelled").length}?</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== BOTTOM SECTION: TABS + CONTENT ===== */}
      {!loading && (
        <div className="space-y-4">
          {/* Day Tabs + Week Toggle */}
          <div className="flex items-center justify-between border-b border-[var(--border)]">
            <div className="flex items-center gap-1">
              {[0, 1, 2, 3, 4, 5, 6].map((dayIndex) => {
                const count = demosByDay[dayIndex].length;
                const isLocked = !!locksByDay[dayIndex];
                return (
                  <button
                    key={dayIndex}
                    onClick={() => { setSelectedDay(dayIndex); setViewMode("day"); }}
                    className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                      viewMode === "day" && selectedDay === dayIndex
                        ? "border-[var(--primary)] text-[var(--primary)]"
                        : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {DAY_NAMES[dayIndex]}
                    {count > 0 && <span className="ml-1 text-xs">({count})</span>}
                    {isLocked && <span className="ml-1">🔒</span>}
                  </button>
                );
              })}
              <button
                onClick={() => setViewMode("week")}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ml-2 ${
                  viewMode === "week"
                    ? "border-[var(--primary)] text-[var(--primary)]"
                    : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                Week
              </button>
            </div>
            {/* Action buttons — bulk day ops + locks are admin/setter-ops only */}
            <div className="flex flex-wrap gap-2 items-center">
              {viewMode === "day" && selectedPending > 0 && !selectedLock && !isCloser && (
                <>
                  <Button size="sm" onClick={() => bulkMarkDay(selectedDemos, "showed")}>
                    All Showed ({selectedPending})
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => bulkMarkDay(selectedDemos, "no_show")}>
                    All No Show
                  </Button>
                </>
              )}
              {viewMode === "day" && selectedPending === 0 && selectedDemos.length > 0 && !selectedLock && selectedDayDate && !isCloser && (
                <Button size="sm" variant="outline" onClick={() => lockDay(selectedDayDate)}>
                  Lock {DAY_NAMES[selectedDay]}
                </Button>
              )}
              {viewMode === "day" && selectedLock && !isCloser && (
                <Button size="sm" variant="ghost" onClick={() => unlockDay(selectedLock.date)}>
                  Unlock
                </Button>
              )}
            </div>
          </div>

          {/* ===== MAIN: SIDE-BY-SIDE CONTENT ===== */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left: StatusBar + Demo list (2/3 width) */}
            <div className="lg:col-span-2 space-y-4">
              {/* StatusBar */}
              <StatusBar showed={displayShowed} noShow={displayNoShow} pending={displayPending} size="md" />

              {/* DAY VIEW: flat demo table */}
              {viewMode === "day" && renderDemoTable(selectedDemos, false)}

              {/* WEEK VIEW: accordion by day */}
              {viewMode === "week" && (
                <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
                  {[1, 2, 3, 4, 5, 6, 0].map((dayIndex) => {
                    const dayDemos = demosByDay[dayIndex];
                    const lock = locksByDay[dayIndex];
                    const dateLabel = weekDates[dayIndex] ? getDateLabel(weekDates[dayIndex]) : "";
                    const dayShowed = dayDemos.filter((d) => d.status === "showed").length;
                    const dayNoShow = dayDemos.filter((d) => d.status === "no_show").length;
                    const dayPending = dayDemos.filter((d) => d.status === "pending").length;
                    const dayCancelled = dayDemos.filter((d) => d.status === "cancelled").length;
                    const dayCloses = dayDemos.filter((d) => d.deal?.status === "closed_won").length;
                    const isExpanded = expandedDays.has(dayIndex);
                    const dayPayments = payments.filter((p) => weekDateKeys[dayIndex] && toDateKey(p.paidAt) === weekDateKeys[dayIndex]);
                    const dayCash = dayPayments.reduce((s, p) => s + netCents(p), 0);
                    const dayDenom = dayShowed + dayNoShow + dayCancelled;
                    const dayShowRate = dayDenom > 0
                      ? `${((dayShowed / dayDenom) * 100).toFixed(0)}%`
                      : "—";

                    const toggleDay = () => {
                      setExpandedDays((prev) => {
                        const next = new Set(prev);
                        if (next.has(dayIndex)) next.delete(dayIndex);
                        else next.add(dayIndex);
                        return next;
                      });
                    };

                    return (
                      <div key={dayIndex} className={`border-b last:border-0 ${dayDemos.length === 0 ? "opacity-50" : ""}`}>
                        {/* Day header row — always visible */}
                        <button
                          onClick={toggleDay}
                          disabled={dayDemos.length === 0}
                          className={`w-full px-4 py-3 flex items-center gap-4 text-left transition-colors ${
                            dayDemos.length > 0 ? "hover:bg-[var(--muted)] cursor-pointer" : "cursor-default"
                          } ${isExpanded ? "bg-[var(--muted)]" : ""}`}
                        >
                          {/* Day name + date */}
                          <div className="w-24 flex-shrink-0">
                            <span className="text-sm font-semibold">{DAY_NAMES[dayIndex]}</span>
                            {dateLabel && <span className="text-xs text-[var(--muted-foreground)] ml-1.5">{dateLabel}</span>}
                          </div>

                          {/* Mini status bar */}
                          <div className="flex-1 max-w-[200px]">
                            {dayDemos.length > 0 ? (
                              <StatusBar showed={dayShowed} noShow={dayNoShow} pending={dayPending} size="sm" />
                            ) : (
                              <span className="text-xs text-[var(--muted-foreground)]">No demos</span>
                            )}
                          </div>

                          {/* Stats */}
                          <div className="flex items-center gap-4 text-xs flex-shrink-0">
                            {dayDemos.length > 0 && (
                              <>
                                <span className="text-[var(--muted-foreground)]">{dayDemos.length} demos</span>
                                <span className="text-[var(--muted-foreground)]">{dayShowRate} show</span>
                                {dayCloses > 0 && <span className="text-[var(--teal)] font-medium">{dayCloses} close{dayCloses !== 1 ? "s" : ""}</span>}
                                {dayCash > 0 && !isCloser && <span className="font-medium text-green-600">{formatCents(dayCash)}</span>}
                              </>
                            )}
                            {lock && <span className="text-xs">🔒</span>}
                          </div>

                          {/* Expand arrow */}
                          {dayDemos.length > 0 && (
                            <span className="text-xs text-[var(--muted-foreground)] flex-shrink-0">
                              {isExpanded ? "▲" : "▼"}
                            </span>
                          )}
                        </button>

                        {/* Expanded: demo table for this day */}
                        {isExpanded && dayDemos.length > 0 && (
                          <div className="border-t">
                            {renderDemoTable(dayDemos, false)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right: Booking Feed + Financial Feed (1/3 width) */}
            <div className="space-y-4">
              {/* Bookings Today */}
              {todayBookings.length > 0 && (
                <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
                  <div className="px-4 py-2.5 border-b bg-[var(--muted)] flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      Bookings Today
                      <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">
                        {todayBookings.length}
                      </span>
                    </h3>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {todayBookings
                      .sort((a, b) => new Date(b.booking.createdAt).getTime() - new Date(a.booking.createdAt).getTime())
                      .map((d) => (
                      <div key={d.id} className="px-4 py-2.5 border-b last:border-0 text-xs hover:bg-[var(--muted)]">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-[var(--foreground)]">{d.booking.prospectName}</span>
                          <span className="text-xs text-[var(--muted-foreground)]/70">
                            {new Date(d.booking.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[var(--muted-foreground)]">
                          <span>{d.booking.setter?.name || "—"} → {d.closer?.name || "TBD"}</span>
                          <span className="font-medium text-[var(--muted-foreground)]">
                            {DAY_NAMES[getDayOfWeek(d.booking.demoDate)]}{" "}
                            {new Date(d.booking.demoDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Financial Feed — revenue figures are hidden from closers */}
              {!isCloser && renderFinancialFeed(displayPayments, viewMode === "week")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
