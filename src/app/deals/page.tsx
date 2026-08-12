"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, formatDate } from "@/lib/utils";
import { CloserStatsPanel } from "@/components/closer-stats";
import { useSession } from "@/components/app-shell";

interface DealRecord {
  id: string;
  prospectName: string;
  prospectEmail: string | null;
  stripeCustomerId: string | null;
  dealType: string;
  leadSource: string;
  month1Cash: number;
  status: string;
  closedAt: string | null;
  notes: string | null;
  demo: {
    id: string;
    booking: { setter: { name: string } | null; demoDate: string };
  } | null;
  closer: { id: string; name: string } | null;
  payments: { id: string; amountCents: number; refundedCents: number; status: string; paidAt: string; isMonth1: boolean }[];
}

// Cash net of refunds — refunded money is not collected
const netCents = (p: { amountCents: number; refundedCents: number; status: string }) =>
  p.status === "failed" ? 0 : p.amountCents - (p.refundedCents || 0);

// Upfront cash = everything collected within 24h of the deal's first payment
// (same rule payroll uses for closer commission). Later charges are reorders.
const UPFRONT_WINDOW_MS = 24 * 60 * 60 * 1000;
function firstPaidAt(payments: { paidAt: string; status: string }[]): number | null {
  const times = payments.filter((p) => p.status !== "failed").map((p) => new Date(p.paidAt).getTime());
  return times.length > 0 ? Math.min(...times) : null;
}
function isUpfront(p: { paidAt: string }, first: number | null): boolean {
  return first !== null && new Date(p.paidAt).getTime() - first <= UPFRONT_WINDOW_MS;
}
function upfrontCents(deal: DealRecord): number {
  const first = firstPaidAt(deal.payments);
  if (first === null) return deal.month1Cash; // no payments yet — manual figure
  return deal.payments.filter((p) => isUpfront(p, first)).reduce((s, p) => s + netCents(p), 0);
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

const statusOptions = [
  { value: "pending", label: "Pending" },
  { value: "closed_won", label: "Closed Won" },
  { value: "closed_lost", label: "Closed Lost" },
  { value: "held", label: "Held" },
];

export default function DealsPage() {
  const searchParams = useSearchParams();
  const session = useSession();
  const isCloser = session?.role === "closer" && !session?.isAdmin;
  const weekId = searchParams.get("weekId") || "";
  const [deals, setDeals] = useState<DealRecord[]>([]);
  const [unlinkedPayments, setUnlinkedPayments] = useState<{ id: string; amountCents: number; customerName: string | null; customerEmail: string | null; paidAt: string; stripePaymentIntentId: string | null; revenueType: string; matchStatus: string; matchReason: string | null; isSubscription: boolean }[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedDeal, setExpandedDeal] = useState<string | null>(null);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/deals?weekId=${weekId}`).then((r) => r.json()),
      fetch("/api/team").then((r) => r.json()),
    ]).then(([dealData, teamData]) => {
      setDeals(dealData.deals || []);
      setUnlinkedPayments(dealData.unlinkedPayments || []);
      setTeam(teamData.members || []);
      setLoading(false);
    });
  }, [weekId]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateDeal = async (dealId: string, data: Record<string, unknown>) => {
    await fetch("/api/deals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId, ...data }),
    });
    loadData();
  };

  const addDeal = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await fetch("/api/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        weekId,
        prospectName: form.get("prospectName"),
        prospectEmail: form.get("prospectEmail"),
        closerId: form.get("closerId") || null,
        dealType: form.get("dealType"),
        status: form.get("status"),
        month1Cash: Math.round(Number(form.get("month1Cash")) * 100),
        stripeCustomerId: form.get("stripeCustomerId") || null,
        notes: form.get("notes") || null,
      }),
    });
    setShowAddForm(false);
    loadData();
  };

  if (!weekId) return <p className="text-[var(--muted-foreground)]">Select a week first</p>;

  const closers = team.filter((m) => m.role === "closer");
  const totalCash = deals.filter((d) => d.status === "closed_won").reduce((sum, d) =>
    sum + d.payments.reduce((s, p) => s + netCents(p), 0), 0);

  return (
    <div className="space-y-6">
      {/* Closer self-serve scoreboard — their own contract numbers */}
      {session?.role === "closer" && !session?.isAdmin && <CloserStatsPanel />}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Deals</h2>
          <p className="text-sm text-[var(--muted-foreground)]">
            {deals.length} deals, {formatCents(totalCash)} cash collected
          </p>
        </div>
        {!isCloser && (
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
            + Add Deal
          </Button>
        )}
      </div>

      {showAddForm && (
        <Card>
          <CardHeader><CardTitle>Add Deal</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addDeal} className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <input name="prospectName" placeholder="Prospect Name" required className="border rounded-lg px-3 py-2 text-sm" />
              <input name="prospectEmail" placeholder="Email" className="border rounded-lg px-3 py-2 text-sm" />
              <select name="closerId" className="border rounded-lg px-3 py-2 text-sm">
                <option value="">Closer</option>
                {closers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select name="dealType" className="border rounded-lg px-3 py-2 text-sm">
                <option value="subscription">Subscription</option>
                <option value="one_time">One-Time</option>
              </select>
              <select name="status" className="border rounded-lg px-3 py-2 text-sm">
                {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <input name="month1Cash" type="number" step="0.01" placeholder="Month 1 Cash ($)" className="border rounded-lg px-3 py-2 text-sm" />
              <input name="stripeCustomerId" placeholder="Stripe Customer ID" className="border rounded-lg px-3 py-2 text-sm" />
              <div className="flex gap-2">
                <input name="notes" placeholder="Notes" className="border rounded-lg px-3 py-2 text-sm flex-1" />
                <Button type="submit" size="sm">Add</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 bg-[var(--card)] rounded-xl border animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--muted)] border-b">
              <tr>
                <th className="text-left p-3 font-medium">Prospect</th>
                <th className="text-left p-3 font-medium">Closer</th>
                <th className="text-left p-3 font-medium">Type</th>
                <th className="text-left p-3 font-medium">Source</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-right p-3 font-medium">Upfront Cash</th>
                <th className="text-right p-3 font-medium">Payments</th>
                <th className="text-left p-3 font-medium">Setter</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((deal) => (
                <>
                  <tr
                    key={deal.id}
                    className="border-b hover:bg-[var(--muted)] cursor-pointer"
                    onClick={() => setExpandedDeal(expandedDeal === deal.id ? null : deal.id)}
                  >
                    <td className="p-3 max-w-[200px]">
                      <div className="font-medium truncate">{deal.prospectName}</div>
                      {deal.prospectEmail && <div className="text-xs text-[var(--muted-foreground)] truncate">{deal.prospectEmail}</div>}
                    </td>
                    <td className="p-3">
                      {isCloser ? (
                        <span className="text-xs">{deal.closer?.name || "—"}</span>
                      ) : (
                        <select
                          value={deal.closer?.id || ""}
                          onChange={(e) => { e.stopPropagation(); updateDeal(deal.id, { closerId: e.target.value }); }}
                          onClick={(e) => e.stopPropagation()}
                          className="border rounded px-2 py-1 text-xs"
                        >
                          <option value="">Assign...</option>
                          {closers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="p-3"><Badge variant="secondary">{deal.dealType}</Badge></td>
                    <td className="p-3">
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          updateDeal(deal.id, { leadSource: deal.leadSource === "self_sourced" ? "fed" : "self_sourced" });
                        }}
                        title={deal.leadSource === "self_sourced"
                          ? "Self-sourced (25%) — click to change to Fed"
                          : "Fed / SDR-booked (16%) — click to change to Self-sourced"}
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold cursor-pointer transition-opacity hover:opacity-70 ${
                          deal.leadSource === "self_sourced"
                            ? "bg-purple-100 text-purple-700"
                            : "bg-[var(--muted)] text-[var(--muted-foreground)]"
                        }`}
                      >
                        {deal.leadSource === "self_sourced" ? "SELF" : "FED"}
                      </span>
                    </td>
                    <td className="p-3">
                      <select
                        value={deal.status}
                        onChange={(e) => { e.stopPropagation(); updateDeal(deal.id, { status: e.target.value }); }}
                        onClick={(e) => e.stopPropagation()}
                        className={`border rounded px-2 py-1 text-xs font-medium ${
                          deal.status === "closed_won" ? "bg-green-50 text-green-700" :
                          deal.status === "closed_lost" ? "bg-red-50 text-red-700" :
                          deal.status === "held" ? "bg-blue-50 text-blue-700" :
                          "bg-yellow-50 text-yellow-700"
                        }`}
                      >
                        {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    <td className="p-3 text-right font-medium">{formatCents(upfrontCents(deal))}</td>
                    <td className="p-3 text-right">
                      {deal.payments.length > 0
                        ? formatCents(deal.payments.reduce((s, p) => s + netCents(p), 0))
                        : "—"
                      }
                    </td>
                    <td className="p-3 text-xs text-[var(--muted-foreground)]">
                      {deal.demo?.booking?.setter?.name || "—"}
                    </td>
                  </tr>
                  {expandedDeal === deal.id && (
                    <tr key={`${deal.id}-detail`}>
                      <td colSpan={8} className="bg-[var(--muted)] p-4">
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div>
                            <p className="font-medium text-[var(--muted-foreground)]">Stripe Customer ID</p>
                            <p>{deal.stripeCustomerId || "Not linked"}</p>
                          </div>
                          <div>
                            <p className="font-medium text-[var(--muted-foreground)]">Demo Date</p>
                            <p>{deal.demo ? formatDate(deal.demo.booking.demoDate) : "No demo linked"}</p>
                          </div>
                          <div>
                            <p className="font-medium text-[var(--muted-foreground)]">Notes</p>
                            <p>{deal.notes || "—"}</p>
                          </div>
                          {deal.payments.length > 0 && (
                            <div className="col-span-3">
                              <p className="font-medium text-[var(--muted-foreground)] mb-2">Stripe Payments</p>
                              {deal.payments.map((p) => (
                                <div key={p.id} className="flex justify-between py-1 border-b last:border-0">
                                  <span>{formatDate(p.paidAt)}</span>
                                  <span>
                                    {formatCents(netCents(p))}
                                    {p.refundedCents > 0 && (
                                      <span className="text-red-500 text-xs ml-1" title={`${formatCents(p.refundedCents)} refunded`}>↩ refunded</span>
                                    )}
                                  </span>
                                  <Badge variant={isUpfront(p, firstPaidAt(deal.payments)) ? "success" : "secondary"}>
                                    {isUpfront(p, firstPaidAt(deal.payments)) ? "Upfront" : "Later"}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {deals.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-[var(--muted-foreground)]">
                    No deals this week. Add deals manually or they&apos;ll be created from confirmed demos.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Unlinked Stripe Payments */}
      {!loading && unlinkedPayments.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Unlinked Stripe Payments</h3>
          <p className="text-sm text-[var(--muted-foreground)] mb-3">
            These payments are in Stripe but not linked to a deal yet. Create a deal above to associate them.
          </p>
          <div className="bg-[var(--card)] rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--muted)] border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Customer</th>
                  <th className="text-left p-3 font-medium">Date</th>
                  <th className="text-left p-3 font-medium">Type</th>
                  <th className="text-left p-3 font-medium">Status</th>
                  <th className="text-right p-3 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {unlinkedPayments.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="p-3 font-medium max-w-[200px] truncate">{p.customerName || p.customerEmail || "Unknown"}</td>
                    <td className="p-3">{formatDate(p.paidAt)}</td>
                    <td className="p-3">
                      <Badge variant={p.isSubscription ? "success" : "warning"}>
                        {p.isSubscription ? "MRR" : p.revenueType === "one_time" ? "One-Time" : "Unknown"}
                      </Badge>
                    </td>
                    <td className="p-3">
                      {p.matchStatus === "needs_review" ? (
                        <span className="text-xs text-orange-600 font-medium">🚩 Review</span>
                      ) : p.matchStatus === "matched" ? (
                        <span className="text-xs text-green-600 font-medium">Matched</span>
                      ) : (
                        <span className="text-xs text-[var(--muted-foreground)]">Unlinked</span>
                      )}
                      {p.matchReason && (
                        <p className="text-xs text-[var(--muted-foreground)]/70 truncate max-w-[150px]" title={p.matchReason}>{p.matchReason}</p>
                      )}
                    </td>
                    <td className="p-3 text-right font-medium">{formatCents(p.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-[var(--muted)]">
                <tr>
                  <td colSpan={4} className="p-3 font-semibold">
                    Total
                    <span className="ml-4 font-normal text-xs text-[var(--muted-foreground)]">
                      MRR: {formatCents(unlinkedPayments.filter(p => p.isSubscription).reduce((s, p) => s + p.amountCents, 0))}
                      {" | "}
                      One-Time: {formatCents(unlinkedPayments.filter(p => !p.isSubscription).reduce((s, p) => s + p.amountCents, 0))}
                    </span>
                  </td>
                  <td className="p-3 text-right font-bold">{formatCents(unlinkedPayments.reduce((s, p) => s + p.amountCents, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
