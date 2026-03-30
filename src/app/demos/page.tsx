"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// import { formatDate } from "@/lib/utils";

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

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

const statusOptions = [
  { value: "pending", label: "Pending" },
  { value: "showed", label: "Showed" },
  { value: "no_show", label: "No Show" },
  { value: "cancelled", label: "Cancelled" },
  { value: "rescheduled", label: "Rescheduled" },
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Day columns render Sun-Sat

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr).getDay();
}

function getDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function DemosPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [demos, setDemos] = useState<DemoRecord[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/demos?weekId=${weekId}`).then((r) => r.json()),
      fetch("/api/team").then((r) => r.json()),
    ]).then(([demoData, teamData]) => {
      setDemos(demoData.demos || []);
      setTeam(teamData.members || []);
      setLoading(false);
    });
  }, [weekId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateDemo = async (demoId: string, data: Record<string, unknown>) => {
    await fetch("/api/demos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoId, ...data }),
    });
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

  // Group demos by day of week (0=Sun, 6=Sat)
  const demosByDay: Record<number, DemoRecord[]> = {};
  for (let i = 0; i < 7; i++) demosByDay[i] = [];
  for (const demo of demos) {
    const day = getDayOfWeek(demo.booking.demoDate);
    demosByDay[day].push(demo);
  }

  // Stats
  const totalBooked = demos.length;
  const totalShowed = demos.filter((d) => d.status === "showed").length;
  const totalNoShow = demos.filter((d) => d.status === "no_show").length;
  const totalPending = demos.filter((d) => d.status === "pending").length;

  // Get the dates for this week (for column headers)
  const weekDates: Record<number, string> = {};
  if (demos.length > 0) {
    for (const demo of demos) {
      const day = getDayOfWeek(demo.booking.demoDate);
      if (!weekDates[day]) weekDates[day] = demo.booking.demoDate;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Demo Management</h2>
          <div className="flex gap-4 mt-1 text-sm">
            <span className="text-[var(--muted-foreground)]">{totalBooked} booked</span>
            <span className="text-green-600 font-medium">{totalShowed} showed</span>
            <span className="text-red-600 font-medium">{totalNoShow} no-show</span>
            {totalPending > 0 && (
              <span className="text-yellow-600 font-medium">{totalPending} pending</span>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
          + Add Demo
        </Button>
      </div>

      {showAddForm && (
        <Card>
          <CardHeader>
            <CardTitle>Add Demo Manually</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={addDemo} className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <input name="prospectName" placeholder="Prospect Name" required className="border rounded-lg px-3 py-2 text-sm" />
              <input name="prospectEmail" placeholder="Email (optional)" className="border rounded-lg px-3 py-2 text-sm" />
              <input name="demoDate" type="datetime-local" required className="border rounded-lg px-3 py-2 text-sm" />
              <select name="setterId" className="border rounded-lg px-3 py-2 text-sm">
                <option value="">Setter</option>
                {setters.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <select name="closerId" className="border rounded-lg px-3 py-2 text-sm flex-1">
                  <option value="">Closer</option>
                  {closers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <Button type="submit" size="sm">Add</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="grid grid-cols-7 gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-48 bg-white rounded-xl border animate-pulse" />
          ))}
        </div>
      ) : (
        /* Calendar Week View */
        <div className="grid grid-cols-7 gap-2">
          {[0, 1, 2, 3, 4, 5, 6].map((dayIndex) => {
            const dayDemos = demosByDay[dayIndex];
            const dayShowed = dayDemos.filter((d) => d.status === "showed").length;
            const dayNoShow = dayDemos.filter((d) => d.status === "no_show").length;
            const dayPending = dayDemos.filter((d) => d.status === "pending").length;
            const isToday = new Date().getDay() === dayIndex;
            const dateLabel = weekDates[dayIndex] ? getDateLabel(weekDates[dayIndex]) : "";

            return (
              <div
                key={dayIndex}
                className={`rounded-xl border bg-white flex flex-col min-h-[200px] ${
                  isToday ? "border-[var(--primary)] border-2 shadow-md" : "border-[var(--border)]"
                }`}
              >
                {/* Day Header */}
                <div className={`px-3 py-2 border-b rounded-t-xl ${
                  isToday ? "bg-green-50" : "bg-gray-50"
                }`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className={`text-sm font-semibold ${isToday ? "text-[var(--primary)]" : ""}`}>
                        {DAY_NAMES[dayIndex]}
                      </span>
                      {dateLabel && (
                        <span className="text-xs text-gray-500 ml-1">{dateLabel}</span>
                      )}
                    </div>
                    {dayDemos.length > 0 && (
                      <span className="text-xs font-medium text-gray-500">{dayDemos.length}</span>
                    )}
                  </div>
                  {dayDemos.length > 0 && (
                    <div className="flex gap-2 mt-1">
                      {dayShowed > 0 && <span className="text-xs text-green-600">{dayShowed}✓</span>}
                      {dayNoShow > 0 && <span className="text-xs text-red-600">{dayNoShow}✗</span>}
                      {dayPending > 0 && <span className="text-xs text-yellow-600">{dayPending}?</span>}
                    </div>
                  )}
                </div>

                {/* Demo Cards for this day */}
                <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[500px]">
                  {dayDemos.length === 0 && (
                    <p className="text-xs text-gray-400 text-center py-4">No demos</p>
                  )}
                  {dayDemos.map((demo) => (
                    <div
                      key={demo.id}
                      className={`rounded-lg border p-2 text-xs transition-all ${
                        demo.status === "showed" ? "bg-green-50 border-green-200" :
                        demo.status === "no_show" ? "bg-red-50 border-red-200" :
                        demo.status === "cancelled" ? "bg-gray-50 border-gray-200 opacity-60" :
                        "bg-yellow-50 border-yellow-200"
                      }`}
                    >
                      {/* Prospect Name */}
                      <div className="font-semibold text-sm truncate" title={demo.booking.prospectName}>
                        {demo.booking.prospectName}
                      </div>

                      {/* Time */}
                      <div className="text-gray-500 mt-0.5">
                        {new Date(demo.booking.demoDate).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </div>

                      {/* Setter & Closer */}
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-gray-500">
                          {demo.booking.setter?.name || "—"}
                        </span>
                        <span className="text-gray-400">
                          → {demo.closer?.name || "—"}
                        </span>
                      </div>

                      {/* Status selector */}
                      <select
                        value={demo.status}
                        onChange={(e) => updateDemo(demo.id, { status: e.target.value })}
                        className={`w-full mt-1.5 border rounded px-1.5 py-1 text-xs font-medium ${
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

                      {/* Confirmation source */}
                      {demo.confirmedBy && (
                        <div className="mt-1">
                          <span className={`text-[10px] font-medium ${
                            demo.confirmedBy === "fireflies_auto" ? "text-purple-600" :
                            demo.confirmedBy === "payment_auto" ? "text-blue-600" :
                            "text-green-600"
                          }`}>
                            {demo.confirmedBy === "fireflies_auto" ? "🎙 Fireflies" :
                             demo.confirmedBy === "payment_auto" ? "💳 Payment" :
                             `✓ ${demo.confirmedBy}`}
                          </span>
                        </div>
                      )}
                      {!demo.confirmedBy && demo.status === "pending" && (
                        <div className="mt-1">
                          <Badge variant="warning" className="text-[10px] px-1.5 py-0">Needs Review</Badge>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Day bulk actions */}
                {dayPending > 0 && (
                  <div className="p-2 border-t flex gap-1">
                    <button
                      onClick={() => bulkMarkDay(dayDemos, "showed")}
                      className="flex-1 text-[10px] font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded py-1 transition-colors"
                    >
                      All Showed
                    </button>
                    <button
                      onClick={() => bulkMarkDay(dayDemos, "no_show")}
                      className="flex-1 text-[10px] font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded py-1 transition-colors"
                    >
                      All No Show
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Week Summary Bar */}
      {!loading && demos.length > 0 && (
        <div className="bg-white rounded-xl border p-4">
          <div className="flex items-center justify-between">
            <div className="flex gap-6">
              <div>
                <p className="text-xs text-gray-500">Total Booked</p>
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
            </div>
            {totalPending > 0 && (
              <Badge variant="warning" className="text-sm px-3 py-1">
                {totalPending} demos need review
              </Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
