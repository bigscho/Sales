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

  // Zone editing
  const [editingZones, setEditingZones] = useState<string | null>(null); // setterId being edited
  const [zoneState, setZoneState] = useState("");
  const [zoneCities, setZoneCities] = useState("");
  const [zoneMinVolume, setZoneMinVolume] = useState("");
  const [zoneMaxVolume, setZoneMaxVolume] = useState("");
  const [existingZones, setExistingZones] = useState<Array<{ state?: string; cities?: string[]; minVolume?: number; maxVolume?: number }>>([]);

  const startEditZones = (setter: TeamMember) => {
    setEditingZones(setter.id);
    if (setter.blastZones) {
      try { setExistingZones(JSON.parse(setter.blastZones)); } catch { setExistingZones([]); }
    } else {
      setExistingZones([]);
    }
    setZoneState("");
    setZoneCities("");
    setZoneMinVolume("");
    setZoneMaxVolume("");
  };

  const addZone = () => {
    if (!zoneState) return;
    const newZone: { state: string; cities?: string[]; minVolume?: number; maxVolume?: number } = { state: zoneState };
    if (zoneCities) newZone.cities = zoneCities.split(",").map(c => c.trim());
    if (zoneMinVolume) newZone.minVolume = Number(zoneMinVolume);
    if (zoneMaxVolume) newZone.maxVolume = Number(zoneMaxVolume);
    setExistingZones(prev => [...prev, newZone]);
    setZoneState("");
    setZoneCities("");
    setZoneMinVolume("");
    setZoneMaxVolume("");
  };

  const removeZone = (idx: number) => {
    setExistingZones(prev => prev.filter((_, i) => i !== idx));
  };

  const saveZones = async () => {
    if (!editingZones) return;
    await fetch("/api/team", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingZones, blastZones: JSON.stringify(existingZones) }),
    });
    setEditingZones(null);
    loadData();
  };

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

      {/* Setter Credit Balances + Zone Assignment */}
      <Card>
        <CardHeader><CardTitle>Setter Zones & Credits</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {setters.map((s) => {
            let zones: Array<{ state?: string; cities?: string[]; minProd?: number; maxProd?: number; minVolume?: number; maxVolume?: number }> = [];
            if (s.blastZones) { try { zones = JSON.parse(s.blastZones); } catch { /* */ } }
            const isEditing = editingZones === s.id;

            return (
              <div key={s.id} className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-3 font-bold text-[var(--teal)]">{s.creditBalance.toLocaleString()} credits</span>
                  </div>
                  {!isEditing && (
                    <Button size="sm" variant="outline" onClick={() => startEditZones(s)}>
                      {zones.length > 0 ? "Edit Zones" : "Assign Zones"}
                    </Button>
                  )}
                </div>

                {!isEditing && zones.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {zones.map((z, i) => (
                      <span key={i} className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--teal-tint)] text-[var(--teal)]">
                        {z.state}{z.cities?.length ? ` (${z.cities.join(", ")})` : ""}
                        {z.minVolume || z.maxVolume ? ` · $${z.minVolume ? (z.minVolume >= 1000000 ? (z.minVolume/1000000).toFixed(1)+"M" : (z.minVolume/1000).toFixed(0)+"K") : "0"}-${z.maxVolume ? (z.maxVolume >= 1000000 ? (z.maxVolume/1000000).toFixed(1)+"M" : (z.maxVolume/1000).toFixed(0)+"K") : "∞"}` : ""}
                      </span>
                    ))}
                  </div>
                )}
                {!isEditing && zones.length === 0 && (
                  <p className="text-xs text-[var(--muted-foreground)]">No zones assigned</p>
                )}

                {isEditing && (
                  <div className="space-y-3 mt-3 border-t pt-3">
                    {/* Existing zones */}
                    {existingZones.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {existingZones.map((z, i) => (
                          <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--teal-tint)] text-[var(--teal)]">
                            {z.state}{z.cities?.length ? ` (${z.cities.join(", ")})` : ""}
                            {z.minVolume || z.maxVolume ? ` · $${z.minVolume ? (z.minVolume >= 1000000 ? (z.minVolume/1000000).toFixed(1)+"M" : (z.minVolume/1000).toFixed(0)+"K") : "0"}-${z.maxVolume ? (z.maxVolume >= 1000000 ? (z.maxVolume/1000000).toFixed(1)+"M" : (z.maxVolume/1000).toFixed(0)+"K") : "∞"}` : ""}
                            <button onClick={() => removeZone(i)} className="ml-1 text-red-500 hover:text-red-700">×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Add zone form */}
                    <div className="flex items-end gap-2 flex-wrap">
                      <div>
                        <label className="text-xs text-[var(--muted-foreground)] block mb-1">State</label>
                        <input value={zoneState} onChange={(e) => setZoneState(e.target.value)} placeholder="TX" className="border rounded-lg px-3 py-1.5 text-sm w-20 bg-[var(--card)]" />
                      </div>
                      <div>
                        <label className="text-xs text-[var(--muted-foreground)] block mb-1">Cities (optional)</label>
                        <input value={zoneCities} onChange={(e) => setZoneCities(e.target.value)} placeholder="Austin, Dallas" className="border rounded-lg px-3 py-1.5 text-sm w-40 bg-[var(--card)]" />
                      </div>
                      <div>
                        <label className="text-xs text-[var(--muted-foreground)] block mb-1">Min Volume ($/yr)</label>
                        <input type="number" value={zoneMinVolume} onChange={(e) => setZoneMinVolume(e.target.value)} placeholder="e.g. 500000" className="border rounded-lg px-3 py-1.5 text-sm w-32 bg-[var(--card)]" />
                      </div>
                      <div>
                        <label className="text-xs text-[var(--muted-foreground)] block mb-1">Max Volume ($/yr)</label>
                        <input type="number" value={zoneMaxVolume} onChange={(e) => setZoneMaxVolume(e.target.value)} placeholder="∞" className="border rounded-lg px-3 py-1.5 text-sm w-32 bg-[var(--card)]" />
                      </div>
                      <Button size="sm" variant="outline" onClick={addZone} disabled={!zoneState}>+ Add Zone</Button>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveZones}>Save Zones</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingZones(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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
