"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

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
    source: string;
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
  customerName: string | null;
  customerEmail: string | null;
  paidAt: string;
  status: string;
}

const statusOptions = [
  { value: "pending", label: "Pending" },
  { value: "showed", label: "Showed" },
  { value: "no_show", label: "No Show" },
  { value: "cancelled", label: "Cancelled" },
  { value: "rescheduled", label: "Rescheduled" },
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

export default function DemosPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [demos, setDemos] = useState<DemoRecord[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [dayLocks, setDayLocks] = useState<DayLockRecord[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<number>(new Date().getDay());
  const [showAddForm, setShowAddForm] = useState(false);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/demos?weekId=${weekId}`).then((r) => r.json()),
      fetch("/api/team").then((r) => r.json()),
      fetch(`/api/demos/lock?weekId=${weekId}`).then((r) => r.json()),
      fetch(`/api/deals?weekId=${weekId}`).then((r) => r.json()),
    ]).then(([demoData, teamData, lockData, dealData]) => {
      setDemos(demoData.demos || []);
      setTeam(teamData.members || []);
      setDayLocks(lockData.dayLocks || []);
      // Collect all payments (from deals + unlinked)
      const allPayments: PaymentRecord[] = [];
      for (const deal of dealData.deals || []) {
        for (const p of deal.payments || []) {
          allPayments.push({ ...p, customerName: deal.prospectName, customerEmail: deal.prospectEmail });
        }
      }
      for (const p of dealData.unlinkedPayments || []) {
        allPayments.push(p);
      }
      setPayments(allPayments);
      setLoading(false);
    });
  }, [weekId]);

  useEffect(() => { loadData(); }, [loadData]);

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

  // Build lock lookup: day index -> lock
  const locksByDay: Record<number, DayLockRecord> = {};
  for (const lock of dayLocks) {
    locksByDay[lock.dayOfWeek] = lock;
  }

  // Get date strings for each day of the week
  const weekDates: Record<number, string> = {};
  for (const demo of demos) {
    const day = getDayOfWeek(demo.booking.demoDate);
    if (!weekDates[day]) weekDates[day] = demo.booking.demoDate;
  }

  // Overall stats
  const totalBooked = demos.length;
  const totalShowed = demos.filter((d) => d.status === "showed").length;
  const totalNoShow = demos.filter((d) => d.status === "no_show").length;
  const totalPending = demos.filter((d) => d.status === "pending").length;

  // Selected day data
  const selectedDemos = demosByDay[selectedDay] || [];
  const selectedLock = locksByDay[selectedDay];
  const selectedDayDate = weekDates[selectedDay];

  // Payments for selected day
  const selectedPayments = payments.filter((p) => {
    const pDay = getDayOfWeek(p.paidAt);
    return pDay === selectedDay;
  });

  const selectedShowed = selectedDemos.filter((d) => d.status === "showed").length;
  const selectedNoShow = selectedDemos.filter((d) => d.status === "no_show").length;
  const selectedPending = selectedDemos.filter((d) => d.status === "pending").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Demo Management</h2>
          <div className="flex gap-4 mt-1 text-sm">
            <span>{totalBooked} booked</span>
            <span className="text-green-600 font-medium">{totalShowed} showed</span>
            <span className="text-red-600 font-medium">{totalNoShow} no-show</span>
            {totalPending > 0 && <span className="text-yellow-600 font-medium">{totalPending} pending</span>}
            <span className="text-gray-500">{dayLocks.length}/7 days locked</span>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>+ Add Demo</Button>
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
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-32 bg-white rounded-xl border animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 px-2">
          <div className="grid grid-cols-7 gap-2" style={{ minWidth: "1100px" }}>
            {[0, 1, 2, 3, 4, 5, 6].map((dayIndex) => {
              const dayDemos = demosByDay[dayIndex];
              const isToday = new Date().getDay() === dayIndex;
              const isSelected = selectedDay === dayIndex;
              const lock = locksByDay[dayIndex];
              const dateLabel = weekDates[dayIndex] ? getDateLabel(weekDates[dayIndex]) : "";
              const dayShowed = dayDemos.filter((d) => d.status === "showed").length;
              const dayTotal = dayDemos.length;

              return (
                <div
                  key={dayIndex}
                  onClick={() => setSelectedDay(dayIndex)}
                  className={`rounded-xl border bg-white flex flex-col min-h-[140px] cursor-pointer transition-all relative ${
                    isSelected ? "ring-2 ring-[var(--primary)] shadow-md" :
                    isToday ? "border-[var(--primary)]" :
                    "border-[var(--border)] hover:shadow-sm"
                  }`}
                >
                  {/* Day Header */}
                  <div className={`px-2.5 py-2 border-b rounded-t-xl flex items-center justify-between ${
                    isSelected ? "bg-green-50" : isToday ? "bg-green-50/50" : "bg-gray-50"
                  }`}>
                    <div>
                      <span className={`text-sm font-semibold ${isSelected || isToday ? "text-[var(--primary)]" : ""}`}>
                        {DAY_NAMES[dayIndex]}
                      </span>
                      {dateLabel && <span className="text-[10px] text-gray-500 ml-1">{dateLabel}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      {dayTotal > 0 && <span className="text-xs font-medium text-gray-500">{dayTotal}</span>}
                      {lock && <span className="text-xs">🔒</span>}
                    </div>
                  </div>

                  {/* Locked Overlay */}
                  {lock && (
                    <div className="absolute inset-0 top-[38px] bg-white/75 backdrop-blur-[1px] rounded-b-xl flex flex-col items-center justify-center z-10 pointer-events-none">
                      <span className="text-lg">🔒</span>
                      <p className="text-sm font-bold mt-1">
                        {lock.showCount}/{lock.demoCount} showed
                      </p>
                      <p className="text-xs text-gray-500">
                        {lock.demoCount > 0 ? ((lock.showCount / lock.demoCount) * 100).toFixed(0) : 0}% show rate
                      </p>
                      {lock.cashCents > 0 && (
                        <p className="text-xs font-medium text-green-600 mt-0.5">
                          {formatCents(lock.cashCents)}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Compact Demo Cards */}
                  <div className="flex-1 p-1.5 space-y-1 overflow-y-auto max-h-[200px]">
                    {dayDemos.length === 0 && (
                      <p className="text-[10px] text-gray-400 text-center py-3">No demos</p>
                    )}
                    {dayDemos.map((demo) => (
                      <div
                        key={demo.id}
                        className={`rounded px-2 py-1 text-[11px] ${
                          demo.status === "showed" ? "bg-green-50 text-green-800" :
                          demo.status === "no_show" ? "bg-red-50 text-red-800" :
                          demo.status === "cancelled" ? "bg-gray-100 text-gray-400 line-through" :
                          "bg-yellow-50 text-yellow-800"
                        }`}
                      >
                        <span className="font-medium" title={demo.booking.prospectName}>
                          {shortName(demo.booking.prospectName)}
                        </span>
                        <span className="text-gray-400 ml-1">
                          {new Date(demo.booking.demoDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Day footer stats */}
                  {dayTotal > 0 && !lock && (
                    <div className="px-2 py-1 border-t text-[10px] text-gray-500 flex justify-between">
                      <span>{dayShowed}✓ {dayTotal - dayShowed - dayDemos.filter(d => d.status === "cancelled").length}?</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== BOTTOM: DAY DETAIL VIEW ===== */}
      {!loading && (
        <div className="space-y-4">
          {/* Day Selector Tabs */}
          <div className="flex items-center gap-1 border-b border-[var(--border)]">
            {[0, 1, 2, 3, 4, 5, 6].map((dayIndex) => {
              const count = demosByDay[dayIndex].length;
              const isLocked = !!locksByDay[dayIndex];
              return (
                <button
                  key={dayIndex}
                  onClick={() => setSelectedDay(dayIndex)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    selectedDay === dayIndex
                      ? "border-[var(--primary)] text-[var(--primary)]"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {DAY_NAMES[dayIndex]}
                  {count > 0 && <span className="ml-1 text-xs">({count})</span>}
                  {isLocked && <span className="ml-1">🔒</span>}
                </button>
              );
            })}
          </div>

          {/* Day Stats Bar */}
          <div className="flex items-center justify-between bg-white rounded-xl border p-4">
            <div className="flex gap-6">
              <div>
                <p className="text-xs text-gray-500">Demos</p>
                <p className="text-xl font-bold">{selectedDemos.length}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Showed</p>
                <p className="text-xl font-bold text-green-600">{selectedShowed}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">No Show</p>
                <p className="text-xl font-bold text-red-600">{selectedNoShow}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Show Rate</p>
                <p className="text-xl font-bold">
                  {selectedDemos.length > 0 ? ((selectedShowed / selectedDemos.length) * 100).toFixed(0) : "—"}%
                </p>
              </div>
              {selectedPayments.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500">Cash Today</p>
                  <p className="text-xl font-bold text-green-600">
                    {formatCents(selectedPayments.reduce((s, p) => s + p.amountCents, 0))}
                  </p>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              {selectedPending > 0 && !selectedLock && (
                <>
                  <Button size="sm" onClick={() => bulkMarkDay(selectedDemos, "showed")}>
                    All Showed ({selectedPending})
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => bulkMarkDay(selectedDemos, "no_show")}>
                    All No Show
                  </Button>
                </>
              )}
              {selectedPending === 0 && selectedDemos.length > 0 && !selectedLock && selectedDayDate && (
                <Button size="sm" variant="outline" onClick={() => lockDay(selectedDayDate)}>
                  🔒 Lock {DAY_NAMES[selectedDay]}
                </Button>
              )}
              {selectedLock && (
                <Button size="sm" variant="ghost" onClick={() => unlockDay(selectedLock.date)}>
                  🔓 Unlock
                </Button>
              )}
            </div>
          </div>

          {/* Demo Detail Table */}
          <div className="bg-white rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Prospect</th>
                  <th className="text-left p-3 font-medium">Time</th>
                  <th className="text-left p-3 font-medium">Setter</th>
                  <th className="text-left p-3 font-medium">Closer</th>
                  <th className="text-left p-3 font-medium">Status</th>
                  <th className="text-left p-3 font-medium">Confirmed By</th>
                </tr>
              </thead>
              <tbody>
                {selectedDemos.map((demo) => (
                  <tr key={demo.id} className={`border-b last:border-0 ${
                    demo.status === "showed" ? "bg-green-50/30" :
                    demo.status === "no_show" ? "bg-red-50/30" :
                    demo.status === "pending" ? "bg-yellow-50/30" : ""
                  }`}>
                    <td className="p-3">
                      <div className="font-medium">{demo.booking.prospectName}</div>
                      {demo.booking.prospectEmail && (
                        <div className="text-xs text-gray-500">{demo.booking.prospectEmail}</div>
                      )}
                      {demo.booking.prospectPhone && (
                        <div className="text-xs text-gray-400">{demo.booking.prospectPhone}</div>
                      )}
                    </td>
                    <td className="p-3 text-gray-600">
                      {new Date(demo.booking.demoDate).toLocaleTimeString("en-US", {
                        hour: "numeric", minute: "2-digit", hour12: true,
                      })}
                    </td>
                    <td className="p-3">{demo.booking.setter?.name || "—"}</td>
                    <td className="p-3">{demo.closer?.name || "—"}</td>
                    <td className="p-3">
                      <select
                        value={demo.status}
                        onChange={(e) => updateDemo(demo.id, { status: e.target.value })}
                        disabled={!!selectedLock}
                        className={`border rounded px-2 py-1 text-xs font-medium ${
                          selectedLock ? "opacity-50 cursor-not-allowed " : ""
                        }${
                          demo.status === "showed" ? "bg-green-100 text-green-700 border-green-300" :
                          demo.status === "no_show" ? "bg-red-100 text-red-700 border-red-300" :
                          demo.status === "pending" ? "bg-yellow-100 text-yellow-700 border-yellow-300" :
                          "bg-gray-100 text-gray-700 border-gray-300"
                        }`}
                      >
                        {statusOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="p-3">
                      {demo.confirmedBy ? (
                        <span className={`text-xs font-medium ${
                          demo.confirmedBy === "fireflies_auto" ? "text-purple-600" :
                          demo.confirmedBy === "payment_auto" ? "text-blue-600" :
                          "text-green-600"
                        }`}>
                          {demo.confirmedBy === "fireflies_auto" ? "🎙 Fireflies" :
                           demo.confirmedBy === "payment_auto" ? "💳 Payment" :
                           `✓ ${demo.confirmedBy}`}
                        </span>
                      ) : demo.status === "pending" ? (
                        <Badge variant="warning">Needs Review</Badge>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {selectedDemos.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-gray-500">
                      No demos on {DAY_NAMES[selectedDay]}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Financial Feed for Selected Day */}
          {selectedPayments.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    Stripe Payments — {DAY_NAMES[selectedDay]}
                    {selectedDayDate && ` ${getDateLabel(selectedDayDate)}`}
                  </CardTitle>
                  <span className="text-lg font-bold text-green-600">
                    {formatCents(selectedPayments.reduce((s, p) => s + p.amountCents, 0))}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Customer</th>
                      <th className="text-right p-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPayments.map((p) => (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="p-2">{p.customerName || p.customerEmail || "Unknown"}</td>
                        <td className="p-2 text-right font-medium">{formatCents(p.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Week Summary */}
          <div className="bg-white rounded-xl border p-4">
            <div className="flex items-center justify-between">
              <div className="flex gap-6">
                <div>
                  <p className="text-xs text-gray-500">Week Total</p>
                  <p className="text-xl font-bold">{totalBooked}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Showed</p>
                  <p className="text-xl font-bold text-green-600">{totalShowed}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">No Show</p>
                  <p className="text-xl font-bold text-red-600">{totalNoShow}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Show Rate</p>
                  <p className="text-xl font-bold">
                    {totalBooked > 0 ? ((totalShowed / totalBooked) * 100).toFixed(1) : "0"}%
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Days Locked</p>
                  <p className="text-xl font-bold">{dayLocks.length}/7</p>
                </div>
              </div>
              {totalPending > 0 && (
                <Badge variant="warning" className="text-sm px-3 py-1">
                  {totalPending} demos need review
                </Badge>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
