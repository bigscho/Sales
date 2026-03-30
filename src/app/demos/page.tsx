"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

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
  { value: "pending", label: "Pending", variant: "warning" as const },
  { value: "showed", label: "Showed", variant: "success" as const },
  { value: "no_show", label: "No Show", variant: "danger" as const },
  { value: "cancelled", label: "Cancelled", variant: "secondary" as const },
  { value: "rescheduled", label: "Rescheduled", variant: "secondary" as const },
];

export default function DemosPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [demos, setDemos] = useState<DemoRecord[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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

  const bulkConfirm = async (status: string) => {
    await fetch("/api/demos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "bulk_confirm",
        demoIds: Array.from(selectedIds),
        status,
      }),
    });
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

  const pendingCount = demos.filter((d) => d.status === "pending").length;
  const setters = team.filter((m) => m.role === "setter");
  const closers = team.filter((m) => m.role === "closer");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Demo Management</h2>
          <p className="text-sm text-[var(--muted-foreground)]">
            {demos.length} demos total, {pendingCount} pending confirmation
          </p>
        </div>
        <div className="flex gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button size="sm" onClick={() => bulkConfirm("showed")}>
                Mark {selectedIds.size} as Showed
              </Button>
              <Button size="sm" variant="destructive" onClick={() => bulkConfirm("no_show")}>
                Mark {selectedIds.size} as No Show
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
            + Add Demo
          </Button>
        </div>
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
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 bg-white rounded-xl border animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="p-3 w-8">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === demos.filter((d) => d.status === "pending").length && demos.filter((d) => d.status === "pending").length > 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds(new Set(demos.filter((d) => d.status === "pending").map((d) => d.id)));
                      } else {
                        setSelectedIds(new Set());
                      }
                    }}
                  />
                </th>
                <th className="text-left p-3 font-medium">Prospect</th>
                <th className="text-left p-3 font-medium">Demo Date</th>
                <th className="text-left p-3 font-medium">Setter</th>
                <th className="text-left p-3 font-medium">Closer</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-left p-3 font-medium">Source</th>
                <th className="text-left p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {demos.map((demo) => (
                <tr key={demo.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="p-3">
                    {demo.status === "pending" && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(demo.id)}
                        onChange={(e) => {
                          const next = new Set(selectedIds);
                          if (e.target.checked) { next.add(demo.id); } else { next.delete(demo.id); }
                          setSelectedIds(next);
                        }}
                      />
                    )}
                  </td>
                  <td className="p-3">
                    <div className="font-medium">{demo.booking.prospectName}</div>
                    {demo.booking.prospectEmail && (
                      <div className="text-xs text-gray-500">{demo.booking.prospectEmail}</div>
                    )}
                  </td>
                  <td className="p-3">{formatDate(demo.booking.demoDate)}</td>
                  <td className="p-3">{demo.booking.setter?.name || "—"}</td>
                  <td className="p-3">
                    <select
                      value={demo.closer?.id || ""}
                      onChange={(e) => updateDemo(demo.id, { closerId: e.target.value || null })}
                      className="border rounded px-2 py-1 text-xs"
                    >
                      <option value="">Assign...</option>
                      {closers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-3">
                    <select
                      value={demo.status}
                      onChange={(e) => updateDemo(demo.id, { status: e.target.value })}
                      className={`border rounded px-2 py-1 text-xs font-medium ${
                        demo.status === "showed" ? "bg-green-50 text-green-700" :
                        demo.status === "no_show" ? "bg-red-50 text-red-700" :
                        demo.status === "pending" ? "bg-yellow-50 text-yellow-700" :
                        "bg-gray-50 text-gray-700"
                      }`}
                    >
                      {statusOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-3">
                    <Badge variant="secondary">{demo.booking.source}</Badge>
                    {demo.hasFirefliesRecording && (
                      <Badge variant="success" className="ml-1">Recording</Badge>
                    )}
                  </td>
                  <td className="p-3">
                    {demo.confirmedBy ? (
                      <div>
                        <span className={`text-xs font-medium ${
                          demo.confirmedBy === "fireflies_auto" ? "text-purple-600" :
                          demo.confirmedBy === "payment_auto" ? "text-blue-600" :
                          "text-green-600"
                        }`}>
                          {demo.confirmedBy === "fireflies_auto" ? "🎙 Fireflies" :
                           demo.confirmedBy === "payment_auto" ? "💳 Payment match" :
                           `✓ ${demo.confirmedBy}`}
                        </span>
                        {demo.notes && (
                          <p className="text-xs text-gray-400 mt-0.5 max-w-[200px] truncate" title={demo.notes}>{demo.notes}</p>
                        )}
                      </div>
                    ) : demo.status === "pending" ? (
                      <Badge variant="warning">Needs Review</Badge>
                    ) : null}
                  </td>
                </tr>
              ))}
              {demos.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-500">
                    No demos this week. Click &quot;Add Demo&quot; or sync data from Google Calendar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
