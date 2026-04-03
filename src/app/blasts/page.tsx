"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreditBadge } from "@/components/credit-badge";

interface BlastZone {
  state?: string;
  cities?: string[];
  minProd?: number;
  maxProd?: number;
}

interface BlastRecord {
  id: string;
  creditsSpent: number;
  status: string;
  filterState: string | null;
  filterCity: string | null;
  totalPushed: number;
  totalFailed: number;
  scheduledFor: string | null;
  createdAt: string;
  setter?: { name: string };
}

interface CreditTx {
  id: string;
  amount: number;
  balance: number;
  type: string;
  description: string;
  createdAt: string;
}

export default function BlastsPage() {
  const [balance, setBalance] = useState(0);
  const [zones, setZones] = useState<BlastZone[]>([]);
  const [blasts, setBlasts] = useState<BlastRecord[]>([]);
  const [recentCredits, setRecentCredits] = useState<CreditTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  // Send form state
  const [selectedZoneIdx, setSelectedZoneIdx] = useState(0);
  const [quantity, setQuantity] = useState(100);
  const [availableAgents, setAvailableAgents] = useState<number | null>(null);
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const loadData = useCallback(() => {
    Promise.all([
      fetch("/api/credits").then(r => r.json()),
      fetch("/api/blasts").then(r => r.json()),
      fetch("/api/auth").then(r => r.json()),
    ]).then(([creditData, blastData, authData]) => {
      setBalance(creditData.balance || 0);
      setRecentCredits(creditData.transactions || []);
      setBlasts(blastData.blasts || []);
      setIsAdmin(authData.session?.isAdmin || false);

      // Parse blast zones from team member
      if (authData.session?.memberId) {
        fetch(`/api/team?memberId=${authData.session.memberId}`)
          .then(r => r.json())
          .then(data => {
            const member = data.members?.find((m: { id: string }) => m.id === authData.session.memberId);
            if (member?.blastZones) {
              try {
                setZones(JSON.parse(member.blastZones));
              } catch { setZones([]); }
            }
            if (authData.session.isAdmin) {
              // Admins get a "Custom" zone option
              setZones(prev => [...prev, { state: undefined, cities: undefined }]);
            }
          })
          .catch(() => {});
      }

      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Check available agents when zone or filters change
  useEffect(() => {
    const zone = zones[selectedZoneIdx];
    if (!zone) return;

    const params = new URLSearchParams({ limit: "1" });
    if (zone.state) params.set("state", zone.state);
    if (zone.cities?.[0]) params.set("city", zone.cities[0]);
    if (zone.minProd) params.set("minProd", String(zone.minProd));
    if (zone.maxProd) params.set("maxProd", String(zone.maxProd));

    fetch(`/api/agents?${params}`)
      .then(r => r.json())
      .then(data => setAvailableAgents(data.total || 0))
      .catch(() => setAvailableAgents(null));
  }, [selectedZoneIdx, zones]);

  const handleSend = async () => {
    if (quantity <= 0 || quantity > balance) return;
    setSending(true);
    setSendResult(null);

    const zone = zones[selectedZoneIdx];
    const body: Record<string, unknown> = { quantity };
    if (zone?.state) body.filterState = zone.state;
    if (zone?.cities?.[0]) body.filterCity = zone.cities[0];
    if (zone?.minProd) body.filterMinProd = zone.minProd;
    if (zone?.maxProd) body.filterMaxProd = zone.maxProd;
    if (scheduleMode === "later" && scheduledFor) body.scheduledFor = scheduledFor;

    try {
      const res = await fetch("/api/blasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendResult(`Error: ${data.error}`);
      } else {
        setSendResult(`Blast created! ${quantity} credits spent. Remaining: ${data.creditsRemaining}`);
        setBalance(data.creditsRemaining);
        loadData();
      }
    } catch {
      setSendResult("Failed to create blast");
    }
    setSending(false);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-[var(--card)] rounded-xl border animate-pulse" />
        <div className="h-64 bg-[var(--card)] rounded-xl border animate-pulse" />
      </div>
    );
  }

  const selectedZone = zones[selectedZoneIdx];
  const zoneLabel = (z: BlastZone) => {
    if (!z.state && !z.cities?.length) return "Custom (all regions)";
    const parts = [];
    if (z.state) parts.push(z.state);
    if (z.cities?.length) parts.push(z.cities.join(", "));
    if (z.minProd || z.maxProd) parts.push(`${z.minProd || 0}-${z.maxProd || "∞"} txns/yr`);
    return parts.join(" — ");
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Text Blast</h2>

      {/* Credit Balance Hero */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--muted-foreground)] mb-1">Your Credit Balance</p>
              <CreditBadge balance={balance} size="md" />
              <p className="text-xs text-[var(--muted-foreground)] mt-1">1 credit = 1 SMS sent</p>
            </div>
            <div className="text-right">
              {recentCredits.length > 0 && recentCredits[0].amount > 0 && (
                <p className="text-sm text-green-600 font-medium">
                  +{recentCredits[0].amount.toLocaleString()} {recentCredits[0].type === "weekly_award" ? "this week" : "recently"}
                </p>
              )}
              <a href="/blasts/credits" className="text-xs text-[var(--teal)] hover:underline">
                View credit history →
              </a>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Send a Blast */}
      <Card>
        <CardHeader>
          <CardTitle>Send a Blast</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {zones.length === 0 && !isAdmin ? (
            <p className="text-[var(--muted-foreground)]">No target zones assigned — contact admin to get set up.</p>
          ) : (
            <>
              {/* Zone Selector */}
              <div>
                <label className="text-sm font-medium text-[var(--muted-foreground)] block mb-1">Target Zone</label>
                <select
                  value={selectedZoneIdx}
                  onChange={(e) => setSelectedZoneIdx(Number(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[var(--card)]"
                >
                  {zones.map((z, i) => (
                    <option key={i} value={i}>{zoneLabel(z)}</option>
                  ))}
                </select>
                {availableAgents !== null && (
                  <p className="text-xs text-[var(--muted-foreground)] mt-1">
                    {availableAgents.toLocaleString()} agents available in this zone
                  </p>
                )}
              </div>

              {/* Quantity */}
              <div>
                <label className="text-sm font-medium text-[var(--muted-foreground)] block mb-1">
                  Quantity ({balance.toLocaleString()} credits available)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={Math.min(balance, availableAgents || balance)}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    className="flex-1"
                  />
                  <input
                    type="number"
                    min={1}
                    max={balance}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    className="w-24 border rounded-lg px-3 py-2 text-sm text-right bg-[var(--card)]"
                  />
                </div>
              </div>

              {/* Schedule Toggle */}
              <div>
                <label className="text-sm font-medium text-[var(--muted-foreground)] block mb-1">When</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setScheduleMode("now")}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      scheduleMode === "now"
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : "bg-[var(--muted)] text-[var(--muted-foreground)]"
                    }`}
                  >
                    Send Now
                  </button>
                  <button
                    onClick={() => setScheduleMode("later")}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      scheduleMode === "later"
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : "bg-[var(--muted)] text-[var(--muted-foreground)]"
                    }`}
                  >
                    Schedule
                  </button>
                </div>
                {scheduleMode === "later" && (
                  <input
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    className="mt-2 border rounded-lg px-3 py-2 text-sm bg-[var(--card)]"
                  />
                )}
              </div>

              {/* Confirm */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm">
                    <p>
                      <span className="font-medium">{quantity.toLocaleString()}</span> texts to agents in{" "}
                      <span className="font-medium">{selectedZone?.state || "all regions"}</span>
                    </p>
                    <p className="text-[var(--muted-foreground)]">
                      {scheduleMode === "now" ? "Sending immediately" : `Scheduled for ${scheduledFor || "..."}`}
                    </p>
                  </div>
                  <Button
                    onClick={handleSend}
                    disabled={sending || quantity <= 0 || quantity > balance || (scheduleMode === "later" && !scheduledFor)}
                  >
                    {sending ? "Sending..." : `Send ${quantity.toLocaleString()} Texts`}
                  </Button>
                </div>
                {sendResult && (
                  <p className={`text-sm ${sendResult.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
                    {sendResult}
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Blast History */}
      <Card>
        <CardHeader>
          <CardTitle>Blast History</CardTitle>
        </CardHeader>
        <CardContent>
          {blasts.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No blasts yet. Send your first one above!</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] border-b">
                  <tr>
                    <th className="text-left p-3 font-medium">Date</th>
                    <th className="text-left p-3 font-medium">Zone</th>
                    <th className="text-right p-3 font-medium">Credits</th>
                    <th className="text-right p-3 font-medium">Pushed</th>
                    <th className="text-left p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {blasts.map((b) => (
                    <tr key={b.id} className="border-b last:border-0 hover:bg-[var(--muted)]">
                      <td className="p-3">
                        <a href={`/blasts/${b.id}`} className="text-[var(--teal)] hover:underline">
                          {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </a>
                      </td>
                      <td className="p-3 text-[var(--muted-foreground)]">
                        {[b.filterState, b.filterCity].filter(Boolean).join(", ") || "All"}
                      </td>
                      <td className="p-3 text-right font-medium">{b.creditsSpent.toLocaleString()}</td>
                      <td className="p-3 text-right">{b.totalPushed.toLocaleString()}</td>
                      <td className="p-3">
                        <Badge variant={
                          b.status === "completed" ? "success" :
                          b.status === "failed" ? "danger" :
                          b.status === "processing" || b.status === "pending" ? "warning" :
                          "secondary"
                        }>
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
