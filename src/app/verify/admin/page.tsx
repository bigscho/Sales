"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatPercent } from "@/lib/utils";

interface FlagItem {
  id: string;
  flagType: string;
  note: string | null;
  demoId: string | null;
  demoName: string | null;
  demoDate: string | null;
  demoStatus: string | null;
  missingProspectName: string | null;
  missingProspectEmail: string | null;
  missingDemoDate: string | null;
  ceoAction: string;
}

interface SetterSummary {
  id: string;
  name: string;
  slackUserId: string | null;
  totalDemos: number;
  shows: number;
  noShows: number;
  pending: number;
  showRate: number;
  verification: { status: string; confirmedAt: string } | null;
  openFlags: FlagItem[];
}

interface AdminData {
  week: {
    id: string;
    weekStart: string;
    weekEnd: string;
    status: string;
    confirmedBy: string | null;
  };
  setters: SetterSummary[];
  unattributedCount: number;
  lockedDates: string[];
  pendingDemoCount: number;
  totalFlags: number;
}

function formatWeekRange(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function VerifyAdminPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [locking, setLocking] = useState(false);
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [resolveNotes, setResolveNotes] = useState<Record<string, string>>({});

  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/verify/admin?weekId=${weekId}`)
      .then(r => {
        if (!r.ok) return r.json().then(e => { throw new Error(e.error || `HTTP ${r.status}`); });
        return r.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [weekId]);

  useEffect(() => { loadData(); }, [loadData]);

  const resolveFlag = async (flagId: string, ceoAction: "approved" | "rejected") => {
    setResolving(prev => new Set(prev).add(flagId));
    await fetch("/api/verify/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve_flag", flagId, ceoAction, ceoNote: resolveNotes[flagId] || "" }),
    });
    loadData();
    setResolving(prev => { const n = new Set(prev); n.delete(flagId); return n; });
  };

  const addMissingDemo = async (flag: FlagItem, setterId: string) => {
    setResolving(prev => new Set(prev).add(flag.id));
    await fetch("/api/verify/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_missing_demo",
        flagId: flag.id,
        weekId,
        setterId,
        prospectName: flag.missingProspectName,
        prospectEmail: flag.missingProspectEmail,
        demoDate: flag.missingDemoDate,
      }),
    });
    loadData();
    setResolving(prev => { const n = new Set(prev); n.delete(flag.id); return n; });
  };

  const lockWeek = async () => {
    if (!confirm("Lock this week? All remaining days will be locked and numbers become final for payroll.")) return;
    setLocking(true);
    const res = await fetch("/api/verify/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "lock_week", weekId }),
    });
    const result = await res.json();
    if (!res.ok) {
      alert(result.error || "Failed to lock week");
    }
    setLocking(false);
    loadData();
  };

  if (!weekId) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Select a week to manage verifications</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--card)] rounded-xl border animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data) return <p className="text-center mt-10 text-gray-500">{error ? `Error: ${error}` : "Error loading data"}</p>;

  const { week, setters, pendingDemoCount, totalFlags, lockedDates, unattributedCount } = data;
  const isLocked = week.status === "confirmed";
  const allConfirmed = setters.every(s => s.verification !== null);
  const canLock = pendingDemoCount === 0 && totalFlags === 0;

  // Calculate team totals
  const teamTotals = setters.reduce((acc, s) => ({
    demos: acc.demos + s.totalDemos,
    shows: acc.shows + s.shows,
    noShows: acc.noShows + s.noShows,
    pending: acc.pending + s.pending,
  }), { demos: 0, shows: 0, noShows: 0, pending: 0 });
  const teamConfirmed = teamTotals.shows + teamTotals.noShows;
  const teamShowRate = teamConfirmed > 0 ? teamTotals.shows / teamConfirmed : 0;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Week Verification</h1>
          <p className="text-sm text-gray-500 mt-1">{formatWeekRange(week.weekStart, week.weekEnd)}</p>
        </div>
        <div className="flex items-center gap-3">
          {isLocked ? (
            <Badge variant="success" className="text-sm px-3 py-1">Week Locked</Badge>
          ) : (
            <Button
              onClick={lockWeek}
              disabled={!canLock || locking}
              className="bg-green-600 hover:bg-green-700 text-white px-6"
            >
              {locking ? "Locking..." : "Lock Week"}
            </Button>
          )}
        </div>
      </div>

      {/* Status Banner */}
      {!isLocked && (
        <div className={`rounded-lg p-4 border ${canLock ? "bg-green-50 border-green-200" : "bg-yellow-50 border-yellow-200"}`}>
          {canLock ? (
            <p className="text-green-800 text-sm font-medium">
              Ready to lock. {allConfirmed ? "All setters confirmed." : "Some setters haven't confirmed — their numbers will be CEO-confirmed on lock."}
            </p>
          ) : (
            <div className="text-yellow-800 text-sm space-y-1">
              {pendingDemoCount > 0 && (
                <p>
                  <strong>{pendingDemoCount} demo(s) still pending</strong> — confirm or mark status before locking.{" "}
                  <a href={`/demos?weekId=${weekId}`} className="underline">Go to Demos</a>
                </p>
              )}
              {totalFlags > 0 && <p><strong>{totalFlags} flag(s) unresolved</strong> — resolve all flags below before locking.</p>}
            </div>
          )}
        </div>
      )}

      {/* Team Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className="text-2xl font-bold">{teamTotals.demos}</p>
            <p className="text-xs text-gray-500">Total Demos</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className="text-2xl font-bold text-green-600">{teamTotals.shows}</p>
            <p className="text-xs text-gray-500">Shows</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className="text-2xl font-bold text-red-600">{teamTotals.noShows}</p>
            <p className="text-xs text-gray-500">No Shows</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className={`text-2xl font-bold ${teamShowRate >= 0.6 ? "text-green-600" : teamShowRate >= 0.4 ? "text-yellow-600" : "text-gray-600"}`}>
              {teamConfirmed > 0 ? formatPercent(teamShowRate) : "--"}
            </p>
            <p className="text-xs text-gray-500">Show Rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className="text-2xl font-bold">{lockedDates.length}/7</p>
            <p className="text-xs text-gray-500">Days Locked</p>
          </CardContent>
        </Card>
      </div>

      {/* Per-Setter Cards */}
      {setters.map(setter => {
        const confirmed = setter.shows + setter.noShows;
        return (
          <Card key={setter.id} className={
            setter.openFlags.length > 0 ? "border-orange-300" :
            setter.verification?.status === "confirmed" ? "border-green-200" :
            ""
          }>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base">{setter.name}</CardTitle>
                  {setter.verification ? (
                    <Badge variant={setter.verification.status === "confirmed" ? "success" : "warning"}>
                      {setter.verification.status === "confirmed" ? "Confirmed" : "Has Flags"}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Not Confirmed</Badge>
                  )}
                  <a
                    href={`/verify?weekId=${weekId}&setter=${setter.id}`}
                    className="text-xs text-blue-500 hover:underline"
                    target="_blank"
                  >
                    View as setter
                  </a>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span>{setter.totalDemos} demos</span>
                  <span className="text-green-600">{setter.shows} showed</span>
                  <span className="text-red-600">{setter.noShows} no-show</span>
                  {setter.pending > 0 && <span className="text-yellow-600">{setter.pending} pending</span>}
                  <span className={`font-bold ${
                    setter.showRate >= 0.6 ? "text-green-600" : setter.showRate >= 0.4 ? "text-yellow-600" : confirmed === 0 ? "text-gray-400" : "text-red-600"
                  }`}>
                    {confirmed > 0 ? formatPercent(setter.showRate) : "--"}
                  </span>
                </div>
              </div>
            </CardHeader>

            {/* Open Flags */}
            {setter.openFlags.length > 0 && (
              <CardContent className="pt-0 space-y-3">
                {setter.openFlags.map(flag => (
                  <div key={flag.id} className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        {flag.flagType === "missing_demo" ? (
                          <>
                            <p className="text-sm font-medium text-orange-800">Missing Demo Request</p>
                            <p className="text-sm mt-1">
                              Prospect: <strong>{flag.missingProspectName || "?"}</strong>
                              {flag.missingProspectEmail && <span> ({flag.missingProspectEmail})</span>}
                            </p>
                            {flag.missingDemoDate && <p className="text-xs text-gray-600">Approx: {flag.missingDemoDate}</p>}
                          </>
                        ) : (
                          <>
                            <p className="text-sm font-medium text-orange-800">
                              {flag.flagType === "wrong_status" ? "Wrong Status" : "Not Their Booking"}
                            </p>
                            {flag.demoName && (
                              <p className="text-sm mt-1">
                                {flag.demoName}
                                {flag.demoDate && <span className="text-gray-500"> — {formatDate(flag.demoDate)}</span>}
                                {flag.demoStatus && <span className="text-gray-500"> [{flag.demoStatus}]</span>}
                              </p>
                            )}
                          </>
                        )}
                        {flag.note && <p className="text-xs text-gray-600 mt-1 italic">&quot;{flag.note}&quot;</p>}
                      </div>

                      <div className="flex-shrink-0 flex items-center gap-2">
                        {flag.flagType === "missing_demo" ? (
                          <>
                            <Button
                              size="sm"
                              onClick={() => addMissingDemo(flag, setter.id)}
                              disabled={resolving.has(flag.id)}
                              className="bg-green-600 hover:bg-green-700 text-white"
                            >
                              Add Demo
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => resolveFlag(flag.id, "rejected")}
                              disabled={resolving.has(flag.id)}
                            >
                              Reject
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => resolveFlag(flag.id, "approved")}
                              disabled={resolving.has(flag.id)}
                              className="border-green-300 text-green-700 hover:bg-green-50"
                            >
                              Acknowledge
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => resolveFlag(flag.id, "rejected")}
                              disabled={resolving.has(flag.id)}
                            >
                              Dismiss
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Inline note for wrong_status / not_mine flags */}
                    {flag.flagType !== "missing_demo" && (
                      <div className="mt-2">
                        <input
                          placeholder="Note (optional)"
                          value={resolveNotes[flag.id] || ""}
                          onChange={e => setResolveNotes(prev => ({ ...prev, [flag.id]: e.target.value }))}
                          className="w-full border rounded px-2 py-1 text-xs"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            )}
          </Card>
        );
      })}

      {/* Unattributed */}
      {unattributedCount > 0 && (
        <Card className="border-yellow-200">
          <CardContent className="py-4 px-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-yellow-800">{unattributedCount} unattributed demo(s)</p>
                <p className="text-xs text-gray-500">Not assigned to any setter</p>
              </div>
              <a href={`/demos?weekId=${weekId}`} className="text-sm text-blue-600 underline">View in Demos</a>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lock Week CTA (bottom) */}
      {!isLocked && (
        <div className="sticky bottom-4">
          <Button
            className="w-full py-6 text-base font-semibold bg-green-600 hover:bg-green-700 text-white"
            disabled={!canLock || locking}
            onClick={lockWeek}
          >
            {locking ? "Locking Week..." :
             !canLock ? `Resolve ${pendingDemoCount} pending + ${totalFlags} flags first` :
             "Lock Week — Numbers Are Final"}
          </Button>
        </div>
      )}

      {/* Post-lock: link to payroll */}
      {isLocked && (
        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="py-6 text-center">
            <p className="text-green-800 font-medium text-lg mb-2">Week locked. Numbers are final.</p>
            <a href={`/payroll?weekId=${weekId}`}>
              <Button className="bg-green-600 hover:bg-green-700 text-white px-8">
                Go to Payroll
              </Button>
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
