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
  cumulativeShows: number;
  consecutive15PlusWeeks: number;
  isActive: boolean;
}

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

  const loadData = useCallback(() => {
    setLoading(true);
    fetch("/api/team").then((r) => r.json()).then((data) => {
      setMembers(data.members || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const addMember = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        role: form.get("role"),
        tier: Number(form.get("tier")) || 1,
      }),
    });
    setShowAddForm(false);
    loadData();
  };

  const updateMember = async (id: string, data: Record<string, unknown>) => {
    await fetch("/api/team", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...data }),
    });
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
            <form onSubmit={addMember} className="flex gap-3">
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
              <Button type="submit" size="sm">Add</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-white rounded-xl border animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Setters */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Setters ({setters.length})</h3>
            <div className="bg-white rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left p-3 font-medium">Name</th>
                    <th className="text-left p-3 font-medium">Tier</th>
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
                    <tr><td colSpan={6} className="p-4 text-center text-gray-500">No setters added yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Closers */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Closers ({closers.length})</h3>
            <div className="bg-white rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left p-3 font-medium">Name</th>
                    <th className="text-left p-3 font-medium">Status</th>
                    <th className="p-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {closers.map((m) => (
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
                  {closers.length === 0 && (
                    <tr><td colSpan={3} className="p-4 text-center text-gray-500">No closers added yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Show Rate Reps */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Show Rate Optimization ({showRateReps.length})</h3>
            <div className="bg-white rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
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
                    <tr><td colSpan={3} className="p-4 text-center text-gray-500">No show rate rep added yet</td></tr>
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
            <ul className="space-y-1 text-gray-600">
              <li>Tier 1 (Junior): $25/show flat. Promote at 15 cumulative shows.</li>
              <li>Tier 2 (SDR): 0-9 shows=$25, 10-14=$35, 15+=$40/show. Promote at 45 cumulative shows.</li>
              <li>Tier 3 (Senior SDR): Same rates + $500 base if 10+ shows/week. Promote after 2 consecutive 15+ weeks.</li>
              <li>Tier 4 (Lead SDR): Same rates + $1,000 base if 15+, $500 if 10-14.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium mb-1">Closers</p>
            <p className="text-gray-600">$2,000/month base + 20% of Month 1 cash collected per close.</p>
          </div>
          <div>
            <p className="font-medium mb-1">Show Rate Rep Bonus</p>
            <ul className="space-y-1 text-gray-600">
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
