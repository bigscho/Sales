"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface WarmupAccount {
  subAccountId: string;
  remaining: number;
  dailyLimit: number;
  sentCount: number;
}

interface BlastRecord {
  id: string;
  creditsSpent: number;
  status: string;
  filterState: string | null;
  filterCity: string | null;
  totalPushed: number;
  totalFailed: number;
  createdAt: string;
  setter?: { id: string; name: string };
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  creditBalance: number;
  blastZones: string | null;
}

export default function BlastAdminPage() {
  const [accounts, setAccounts] = useState<WarmupAccount[]>([]);
  const [blasts, setBlasts] = useState<BlastRecord[]>([]);
  const [setters, setSetters] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Manual adjustment form
  const [adjustSetterId, setAdjustSetterId] = useState("");
  const [adjustAmount, setAdjustAmount] = useState(0);
  const [adjustDesc, setAdjustDesc] = useState("");
  const [adjustResult, setAdjustResult] = useState<string | null>(null);

  // Warmup override form
  const [warmupAccount, setWarmupAccount] = useState("1");
  const [warmupLimit, setWarmupLimit] = useState(100);

  const loadData = useCallback(() => {
    Promise.all([
      fetch("/api/ghl/warmup").then(r => r.json()),
      fetch("/api/blasts").then(r => r.json()),
      fetch("/api/team").then(r => r.json()),
    ]).then(([warmupData, blastData, teamData]) => {
      setAccounts(warmupData.capacity?.accounts || []);
      setBlasts(blastData.blasts || []);
      const setterMembers = (teamData.members || []).filter(
        (m: TeamMember) => m.role === "setter"
      );
      setSetters(setterMembers);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAdjust = async () => {
    if (!adjustSetterId || !adjustAmount || !adjustDesc) return;
    const res = await fetch("/api/credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setterId: adjustSetterId, amount: adjustAmount, description: adjustDesc }),
    });
    const data = await res.json();
    if (res.ok) {
      setAdjustResult(`Done. New balance: ${data.balance}`);
      setAdjustAmount(0);
      setAdjustDesc("");
      loadData();
    } else {
      setAdjustResult(`Error: ${data.error}`);
    }
  };

  const handleWarmupOverride = async () => {
    const res = await fetch("/api/ghl/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subAccountId: warmupAccount, dailyLimit: warmupLimit }),
    });
    if (res.ok) loadData();
  };

  if (loading) {
    return <div className="h-64 bg-[var(--card)] rounded-xl border animate-pulse" />;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Blast Admin</h2>

      {/* GHL Warm-up Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {accounts.map((a) => (
          <Card key={a.subAccountId}>
            <CardContent className="p-5">
              <p className="text-sm font-medium text-[var(--muted-foreground)] mb-1">Sub-Account {a.subAccountId}</p>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-[var(--teal)]">{a.remaining}</span>
                <span className="text-sm text-[var(--muted-foreground)]">/ {a.dailyLimit} remaining today</span>
              </div>
              <div className="h-2 rounded-full bg-[var(--muted)] mt-2 overflow-hidden">
                <div
                  className="h-full bg-green-500 transition-all"
                  style={{ width: `${a.dailyLimit > 0 ? ((a.dailyLimit - a.remaining) / a.dailyLimit) * 100 : 0}%` }}
                />
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">{a.sentCount} sent today</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Warm-up Override */}
      <Card>
        <CardHeader><CardTitle>Warm-up Override</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div>
              <label className="text-xs text-[var(--muted-foreground)] block mb-1">Sub-Account</label>
              <select value={warmupAccount} onChange={(e) => setWarmupAccount(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-[var(--card)]">
                <option value="1">Sub-Account 1</option>
                <option value="2">Sub-Account 2</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--muted-foreground)] block mb-1">Daily Limit</label>
              <input type="number" value={warmupLimit} onChange={(e) => setWarmupLimit(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm w-28 bg-[var(--card)]" />
            </div>
            <Button size="sm" onClick={handleWarmupOverride}>Set Limit</Button>
          </div>
        </CardContent>
      </Card>

      {/* Setter Credit Balances */}
      <Card>
        <CardHeader><CardTitle>Setter Credit Balances</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="bg-[var(--muted)] border-b">
              <tr>
                <th className="text-left p-3 font-medium">Setter</th>
                <th className="text-right p-3 font-medium">Balance</th>
                <th className="text-left p-3 font-medium">Zones</th>
              </tr>
            </thead>
            <tbody>
              {setters.map((s) => {
                let zoneLabel = "None";
                if (s.blastZones) {
                  try {
                    const zones = JSON.parse(s.blastZones);
                    zoneLabel = zones.map((z: { state?: string }) => z.state || "All").join(", ");
                  } catch { zoneLabel = "Invalid"; }
                }
                return (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="p-3 font-medium">{s.name}</td>
                    <td className="p-3 text-right font-bold text-[var(--teal)]">{s.creditBalance.toLocaleString()}</td>
                    <td className="p-3 text-[var(--muted-foreground)]">{zoneLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Manual Credit Adjustment */}
      <Card>
        <CardHeader><CardTitle>Manual Credit Adjustment</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-xs text-[var(--muted-foreground)] block mb-1">Setter</label>
              <select value={adjustSetterId} onChange={(e) => setAdjustSetterId(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-[var(--card)]">
                <option value="">Select...</option>
                {setters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--muted-foreground)] block mb-1">Amount (+/-)</label>
              <input type="number" value={adjustAmount} onChange={(e) => setAdjustAmount(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm w-28 bg-[var(--card)]" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-[var(--muted-foreground)] block mb-1">Description</label>
              <input type="text" value={adjustDesc} onChange={(e) => setAdjustDesc(e.target.value)} placeholder="Reason for adjustment" className="border rounded-lg px-3 py-2 text-sm w-full bg-[var(--card)]" />
            </div>
            <Button size="sm" onClick={handleAdjust}>Apply</Button>
          </div>
          {adjustResult && <p className={`text-sm mt-2 ${adjustResult.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>{adjustResult}</p>}
        </CardContent>
      </Card>

      {/* All Blasts */}
      <Card>
        <CardHeader><CardTitle>All Blasts</CardTitle></CardHeader>
        <CardContent>
          {blasts.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No blasts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] border-b">
                  <tr>
                    <th className="text-left p-3 font-medium">Date</th>
                    <th className="text-left p-3 font-medium">Setter</th>
                    <th className="text-left p-3 font-medium">Zone</th>
                    <th className="text-right p-3 font-medium">Credits</th>
                    <th className="text-right p-3 font-medium">Pushed</th>
                    <th className="text-left p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {blasts.map((b) => (
                    <tr key={b.id} className="border-b last:border-0">
                      <td className="p-3 text-[var(--muted-foreground)]">
                        {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </td>
                      <td className="p-3 font-medium">{b.setter?.name || "—"}</td>
                      <td className="p-3 text-[var(--muted-foreground)]">{[b.filterState, b.filterCity].filter(Boolean).join(", ") || "All"}</td>
                      <td className="p-3 text-right">{b.creditsSpent.toLocaleString()}</td>
                      <td className="p-3 text-right">{b.totalPushed.toLocaleString()}</td>
                      <td className="p-3">
                        <Badge variant={b.status === "completed" ? "success" : b.status === "failed" ? "danger" : "warning"}>
                          {b.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
