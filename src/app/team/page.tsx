"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TeamMember {
  id: string;
  name: string;
  role: string;
  tier: number;
  pin: string | null;
  isAdmin: boolean;
  slackUserId: string | null;
  trellusUserId: string | null;
  excludeFromLeaderboard: boolean;
  cumulativeShows: number;
  consecutive15PlusWeeks: number;
  isActive: boolean;
}

interface UnmappedSeat {
  trellusUserId: string;
  dials: number;
  name: string | null;
  email: string | null;
  suggestion: { memberId: string; memberName: string; reason: "email" | "name" | "alias" } | null;
}

const SUGGESTION_LABEL: Record<NonNullable<UnmappedSeat["suggestion"]>["reason"], string> = {
  email: "email match",
  name: "name match",
  alias: "known alias",
};

const roleOptions = [
  { value: "setter", label: "Setter" },
  { value: "closer", label: "Closer" },
  { value: "show_rate_rep", label: "Show Rate Rep" },
];

const tierLabels: Record<number, string> = {
  1: "Junior Setter",
  2: "SDR",
  3: "Senior SDR",
  4: "Lead SDR",
};

export default function TeamPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedSeat[]>([]);
  const [rosterAvailable, setRosterAvailable] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [mapChoice, setMapChoice] = useState<Record<string, string>>({});

  const loadData = useCallback(() => {
    setLoading(true);
    fetch("/api/team?trellus=1").then((r) => r.json()).then((data) => {
      setMembers(data.members || []);
      setUnmapped(data.trellus?.unmapped || []);
      setRosterAvailable(!!data.trellus?.rosterAvailable);
      setSyncedAt(data.trellus?.syncedAt || null);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const addMember = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        role: form.get("role"),
        tier: Number(form.get("tier")) || 1,
        slackUserId: form.get("slackUserId") || null,
        trellusUserId: form.get("trellusUserId") || null,
        excludeFromLeaderboard: form.get("excludeFromLeaderboard") === "on",
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setNotice(body.error || "Could not add member");
      return;
    }
    setNotice(null);
    setShowAddForm(false);
    loadData();
  };

  const updateMember = async (id: string, data: Record<string, unknown>) => {
    const res = await fetch("/api/team", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...data }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setNotice(body.error || "Update failed");
    } else {
      setNotice(null);
    }
    loadData();
  };

  const setters = members.filter((m) => m.role === "setter");
  const closers = members.filter((m) => m.role === "closer");
  const showRateReps = members.filter((m) => m.role === "show_rate_rep");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Team Management</h2>
        <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
          + Add Member
        </Button>
      </div>

      {showAddForm && (
        <Card>
          <CardHeader><CardTitle>Add Team Member</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addMember} className="flex flex-wrap gap-3">
              <input name="name" placeholder="Name" required className="border rounded-lg px-3 py-2 text-sm flex-1" />
              <select name="role" required className="border rounded-lg px-3 py-2 text-sm">
                {roleOptions.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <select name="tier" className="border rounded-lg px-3 py-2 text-sm">
                <option value="1">Tier 1 - Junior</option>
                <option value="2">Tier 2 - SDR</option>
                <option value="3">Tier 3 - Senior SDR</option>
                <option value="4">Tier 4 - Lead SDR</option>
              </select>
              <input name="slackUserId" placeholder="Slack ID (U0...)" className="border rounded-lg px-3 py-2 text-sm w-36" />
              <input name="trellusUserId" placeholder="Trellus ID" className="border rounded-lg px-3 py-2 text-sm w-36" />
              <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] whitespace-nowrap">
                <input type="checkbox" name="excludeFromLeaderboard" className="rounded" />
                Exclude from leaderboard
              </label>
              <Button type="submit" size="sm">Add</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {notice && (
        <p className="text-sm text-red-600">{notice}</p>
      )}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-[var(--card)] rounded-xl border animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {unmapped.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Unmapped Trellus seats</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-[var(--muted-foreground)]">
                  These dialer accounts showed up in the latest sync
                  {syncedAt ? ` (${new Date(syncedAt).toLocaleString()})` : ""} and are not linked to a setter.
                  {rosterAvailable
                    ? " Names come from the Trellus roster."
                    : " Trellus roster names were unavailable, so only the ids are shown."}
                  {" "}A suggestion is an exact name, email, or known alias — nothing is linked until you map it.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[var(--muted-foreground)]">
                        <th className="py-2 pr-3 font-medium">Trellus</th>
                        <th className="py-2 pr-3 font-medium">ID</th>
                        <th className="py-2 pr-3 font-medium text-right">Dials</th>
                        <th className="py-2 font-medium">Map to setter</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unmapped.map((seat) => {
                        const selected = mapChoice[seat.trellusUserId] || seat.suggestion?.memberId || "";
                        return (
                          <tr key={seat.trellusUserId} className="border-t">
                            <td className="py-2 pr-3">
                              <div className="font-medium">{seat.name || "Unknown seat"}</div>
                              {seat.email && <div className="text-xs text-[var(--muted-foreground)]">{seat.email}</div>}
                              {seat.suggestion && (
                                <div className="text-xs text-[var(--muted-foreground)]">
                                  Suggested: {seat.suggestion.memberName} ({SUGGESTION_LABEL[seat.suggestion.reason]})
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-3 font-mono text-xs">{seat.trellusUserId}</td>
                            <td className="py-2 pr-3 text-right">{seat.dials}</td>
                            <td className="py-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  value={selected}
                                  onChange={(e) => setMapChoice((prev) => ({ ...prev, [seat.trellusUserId]: e.target.value }))}
                                  className="border rounded px-2 py-1 text-xs"
                                >
                                  <option value="">Select setter</option>
                                  {setters.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}{m.trellusUserId ? " (already linked)" : ""}</option>
                                  ))}
                                </select>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!selected}
                                  onClick={() => updateMember(selected, { trellusUserId: seat.trellusUserId })}
                                >
                                  Map
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Setters */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Setters ({setters.length})</h3>
            <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] border-b">
                  <tr>
                    <th className="text-left p-3 font-medium">Name</th>
                    <th className="text-left p-3 font-medium">Tier</th>
                    <th className="text-left p-3 font-medium">Slack ID</th>
                    <th className="text-left p-3 font-medium">Trellus ID</th>
                    <th className="text-left p-3 font-medium">PIN</th>
                    <th className="text-center p-3 font-medium">Leaderboard</th>
                    <th className="text-right p-3 font-medium">Cumulative Shows</th>
                    <th className="text-right p-3 font-medium">Consec. 15+ Weeks</th>
                    <th className="text-left p-3 font-medium">Status</th>
                    <th className="p-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {setters.map((m) => (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{m.name}</td>
                      <td className="p-3">
                        <select
                          value={m.tier}
                          onChange={(e) => updateMember(m.id, { tier: Number(e.target.value) })}
                          className="border rounded px-2 py-1 text-xs"
                        >
                          {[1, 2, 3, 4].map((t) => (
                            <option key={t} value={t}>{tierLabels[t]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="p-3">
                        <input
                          value={m.slackUserId || ""}
                          placeholder="U0..."
                          className="border rounded px-2 py-1 text-xs w-28"
                          onBlur={(e) => {
                            const val = e.target.value.trim() || null;
                            if (val !== m.slackUserId) updateMember(m.id, { slackUserId: val });
                          }}
                          onChange={(e) => {
                            setMembers(prev => prev.map(p => p.id === m.id ? { ...p, slackUserId: e.target.value } : p));
                          }}
                        />
                      </td>
                      <td className="p-3">
                        <input
                          value={m.trellusUserId || ""}
                          placeholder="resource id"
                          className="border rounded px-2 py-1 text-xs w-28 font-mono"
                          onBlur={(e) => {
                            const val = e.target.value.trim() || null;
                            if (val !== m.trellusUserId) updateMember(m.id, { trellusUserId: val });
                          }}
                          onChange={(e) => {
                            setMembers(prev => prev.map(p => p.id === m.id ? { ...p, trellusUserId: e.target.value } : p));
                          }}
                        />
                      </td>
                      <td className="p-3">
                        <PinCell member={m} onSave={(pin) => updateMember(m.id, { pin })} />
                      </td>
                      <td className="p-3 text-center">
                        {m.excludeFromLeaderboard ? (
                          <button
                            onClick={() => updateMember(m.id, { excludeFromLeaderboard: false })}
                            className="text-xs text-[var(--muted-foreground)]/70 hover:text-green-600"
                            title="Click to include in leaderboard"
                          >
                            Excluded
                          </button>
                        ) : (
                          <button
                            onClick={() => updateMember(m.id, { excludeFromLeaderboard: true })}
                            className="text-xs text-green-600 hover:text-[var(--muted-foreground)]/70"
                            title="Click to exclude from leaderboard"
                          >
                            Included
                          </button>
                        )}
                      </td>
                      <td className="p-3 text-right">{m.cumulativeShows}</td>
                      <td className="p-3 text-right">{m.consecutive15PlusWeeks}</td>
                      <td className="p-3">
                        <Badge variant={m.isActive ? "success" : "secondary"}>
                          {m.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => updateMember(m.id, { isActive: !m.isActive })}
                        >
                          {m.isActive ? "Deactivate" : "Activate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {setters.length === 0 && (
                    <tr><td colSpan={10} className="p-4 text-center text-[var(--muted-foreground)]">No setters added yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Closers */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Closers ({closers.length})</h3>
            <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] border-b">
                  <tr>
                    <th className="text-left p-3 font-medium">Name</th>
                    <th className="text-left p-3 font-medium">Slack ID</th>
                    <th className="text-left p-3 font-medium">PIN</th>
                    <th className="text-center p-3 font-medium">Admin</th>
                    <th className="text-left p-3 font-medium">Status</th>
                    <th className="p-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {closers.map((m) => (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{m.name}</td>
                      <td className="p-3">
                        <input
                          value={m.slackUserId || ""}
                          placeholder="U0..."
                          className="border rounded px-2 py-1 text-xs w-28"
                          onBlur={(e) => {
                            const val = e.target.value.trim() || null;
                            if (val !== m.slackUserId) updateMember(m.id, { slackUserId: val });
                          }}
                          onChange={(e) => {
                            setMembers(prev => prev.map(p => p.id === m.id ? { ...p, slackUserId: e.target.value } : p));
                          }}
                        />
                      </td>
                      <td className="p-3">
                        <PinCell member={m} onSave={(pin) => updateMember(m.id, { pin })} />
                      </td>
                      <td className="p-3 text-center">
                        <input
                          type="checkbox"
                          checked={m.isAdmin}
                          onChange={() => updateMember(m.id, { isAdmin: !m.isAdmin })}
                          className="rounded"
                        />
                      </td>
                      <td className="p-3">
                        <Badge variant={m.isActive ? "success" : "secondary"}>
                          {m.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <Button size="sm" variant="ghost" onClick={() => updateMember(m.id, { isActive: !m.isActive })}>
                          {m.isActive ? "Deactivate" : "Activate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {closers.length === 0 && (
                    <tr><td colSpan={6} className="p-4 text-center text-[var(--muted-foreground)]">No closers added yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Show Rate Reps */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Show Rate Optimization ({showRateReps.length})</h3>
            <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] border-b">
                  <tr>
                    <th className="text-left p-3 font-medium">Name</th>
                    <th className="text-left p-3 font-medium">Status</th>
                    <th className="p-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {showRateReps.map((m) => (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{m.name}</td>
                      <td className="p-3">
                        <Badge variant={m.isActive ? "success" : "secondary"}>
                          {m.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <Button size="sm" variant="ghost" onClick={() => updateMember(m.id, { isActive: !m.isActive })}>
                          {m.isActive ? "Deactivate" : "Activate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {showRateReps.length === 0 && (
                    <tr><td colSpan={3} className="p-4 text-center text-[var(--muted-foreground)]">No show rate rep added yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Compensation Reference */}
      <Card>
        <CardHeader><CardTitle>Compensation Reference</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-4">
          <div>
            <p className="font-medium mb-1">Setter Tiers</p>
            <ul className="space-y-1 text-[var(--muted-foreground)]">
              <li>Tier 1 (Junior): $25/show flat. Promote at 15 cumulative shows.</li>
              <li>Tier 2 (SDR): 0-9 shows=$25, 10-14=$35, 15+=$40/show. Promote at 45 cumulative shows.</li>
              <li>Tier 3 (Senior SDR): Same rates + $500 base if 10+ shows/week. Promote after 2 consecutive 15+ weeks.</li>
              <li>Tier 4 (Lead SDR): Same rates + $1,000 base if 15+, $500 if 10-14.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium mb-1">Closers</p>
            <p className="text-[var(--muted-foreground)]">$2,000/month base + 20% of Month 1 cash collected per close.</p>
          </div>
          <div>
            <p className="font-medium mb-1">Show Rate Rep Bonus</p>
            <ul className="space-y-1 text-[var(--muted-foreground)]">
              <li>50%+ show rate: $100</li>
              <li>60%+ show rate: $200</li>
              <li>70%+ show rate: $300</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// === PIN Cell Component ===
function PinCell({ member, onSave }: { member: TeamMember; onSave: (pin: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  if (member.pin && !editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="success" className="text-xs px-1.5">PIN set</Badge>
        <button
          onClick={() => { setEditing(true); setValue(""); }}
          className="text-xs text-[var(--muted-foreground)]/70 hover:text-blue-500"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        value={value}
        onChange={e => setValue(e.target.value.replace(/\D/g, ""))}
        placeholder="4-6 digits"
        type="text"
        inputMode="numeric"
        maxLength={6}
        className="border rounded px-2 py-1 text-xs w-16"
        autoFocus={editing}
      />
      <button
        onClick={() => {
          if (value.length >= 4) {
            onSave(value);
            setEditing(false);
          }
        }}
        disabled={value.length < 4}
        className="text-xs text-green-600 hover:text-green-800 disabled:text-[var(--muted-foreground)]/40"
      >
        Save
      </button>
      {editing && (
        <button
          onClick={() => setEditing(false)}
          className="text-xs text-[var(--muted-foreground)]/70 hover:text-red-500"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
