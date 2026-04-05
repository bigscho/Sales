"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, formatDate } from "@/lib/utils";

interface RevenueData {
  period: { month: number; year: number; view: string };
  stripeMrr: {
    activeMrr: number;
    activeCount: number;
    subscriptions: Array<{
      clientName: string;
      email: string | null;
      mrrCents: number;
      status: string;
      currentPeriodEnd: string;
    }>;
    error?: string;
  };
  grossRevenue: number;
  totalRefunded: number;
  totalRevenue: number;
  newRevenue: number;
  returningRevenue: number;
  byType: { mrr: number; oneTime: number; misc: number };
  byCustomer: Array<{
    name: string;
    email: string | null;
    total: number;
    payments: number;
    revenueType: string;
    customerStatus: string;
    lastPaidAt: string;
  }>;
  byWeek: Array<{
    weekId: string;
    weekStart: string;
    weekEnd: string;
    total: number;
    newRevenue: number;
    returningRevenue: number;
    paymentCount: number;
  }>;
  payments: Array<{
    id: string;
    amountCents: number;
    refundedCents: number;
    netCents: number;
    paidAt: string;
    status: string;
    customerName: string | null;
    customerEmail: string | null;
    revenueType: string;
    customerStatus: string;
    matchStatus: string;
  }>;
  paymentCount: number;
  comparison: { prevTotal: number; change: number };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function RevenuePage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<RevenueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSubscriptions, setShowSubscriptions] = useState(false);
  const [showCustomers, setShowCustomers] = useState(false);
  const [showPayments, setShowPayments] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    fetch(`/api/ceo/revenue?month=${month}&year=${year}&view=monthly`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, [month, year]);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Revenue</h2>
          <p className="text-sm text-[var(--muted-foreground)]">
            {MONTH_NAMES[month - 1]} {year}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => {
            if (month === 1) { setMonth(12); setYear(year - 1); } else setMonth(month - 1);
          }}>←</Button>
          <span className="text-sm font-medium w-24 text-center">{MONTH_NAMES[month - 1]} {year}</span>
          <Button size="sm" variant="outline" onClick={() => {
            if (month === 12) { setMonth(1); setYear(year + 1); } else setMonth(month + 1);
          }}>→</Button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><div className="h-16 bg-gray-100 rounded animate-pulse" /></CardContent></Card>
          ))}
        </div>
      ) : data ? (
        <>
          {/* Live MRR Banner */}
          <Card className="border-green-200 bg-green-50/50">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-green-800">Live MRR (from Stripe Subscriptions)</p>
                  <p className="text-3xl font-bold text-green-700">{formatCents(data.stripeMrr.activeMrr)}</p>
                  <p className="text-sm text-green-600 mt-1">
                    {data.stripeMrr.activeCount} active subscription{data.stripeMrr.activeCount !== 1 ? "s" : ""}
                  </p>
                  {data.stripeMrr.error && (
                    <p className="text-xs text-red-600 mt-1">{data.stripeMrr.error}</p>
                  )}
                </div>
                <Button size="sm" variant="outline" onClick={() => setShowSubscriptions(!showSubscriptions)}>
                  {showSubscriptions ? "Hide" : "View"} Subscriptions
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Active Subscriptions Drill-down */}
          {showSubscriptions && data.stripeMrr.subscriptions.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Active Subscriptions</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Client</th>
                      <th className="text-left p-2 font-medium">Email</th>
                      <th className="text-right p-2 font-medium">Monthly MRR</th>
                      <th className="text-left p-2 font-medium">Renews</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stripeMrr.subscriptions.map((sub, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="p-2 font-medium">{sub.clientName}</td>
                        <td className="p-2 text-[var(--muted-foreground)]">{sub.email || "—"}</td>
                        <td className="p-2 text-right font-medium text-green-600">{formatCents(sub.mrrCents)}</td>
                        <td className="p-2">{formatDate(sub.currentPeriodEnd)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t">
                    <tr>
                      <td className="p-2 font-bold" colSpan={2}>Total MRR</td>
                      <td className="p-2 text-right font-bold text-green-600">{formatCents(data.stripeMrr.activeMrr)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Period Revenue Summary */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">
                  {data.totalRefunded > 0 ? "Net Revenue" : "Total Revenue"}
                </p>
                <p className="text-2xl font-bold text-green-600">{formatCents(data.totalRevenue)}</p>
                {data.totalRefunded > 0 && (
                  <p className="text-xs text-red-600 mt-1">
                    Gross: {formatCents(data.grossRevenue)} · Refunds: -{formatCents(data.totalRefunded)}
                  </p>
                )}
                {data.comparison.prevTotal > 0 && data.totalRefunded === 0 && (
                  <p className={`text-xs mt-1 ${data.comparison.change >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {data.comparison.change >= 0 ? "+" : ""}{(data.comparison.change * 100).toFixed(1)}% vs prev period
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">New Revenue</p>
                <p className="text-2xl font-bold text-blue-600">{formatCents(data.newRevenue)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">First-time customers</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Returning Revenue</p>
                <p className="text-2xl font-bold text-purple-600">{formatCents(data.returningRevenue)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">Existing customers</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Payments</p>
                <p className="text-2xl font-bold">{data.paymentCount}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {MONTH_NAMES[month - 1]} {year}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Revenue by Type */}
          <Card>
            <CardHeader><CardTitle className="text-base">Revenue by Type</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div className="border rounded-lg p-4">
                  <p className="text-sm text-[var(--muted-foreground)]">Subscription (MRR)</p>
                  <p className="text-xl font-bold">{formatCents(data.byType.mrr)}</p>
                  {data.totalRevenue > 0 && (
                    <p className="text-xs text-[var(--muted-foreground)]">{((data.byType.mrr / data.totalRevenue) * 100).toFixed(0)}% of total</p>
                  )}
                </div>
                <div className="border rounded-lg p-4">
                  <p className="text-sm text-[var(--muted-foreground)]">One-Time</p>
                  <p className="text-xl font-bold">{formatCents(data.byType.oneTime)}</p>
                  {data.totalRevenue > 0 && (
                    <p className="text-xs text-[var(--muted-foreground)]">{((data.byType.oneTime / data.totalRevenue) * 100).toFixed(0)}% of total</p>
                  )}
                </div>
                <div className="border rounded-lg p-4">
                  <p className="text-sm text-[var(--muted-foreground)]">Misc</p>
                  <p className="text-xl font-bold">{formatCents(data.byType.misc)}</p>
                  {data.totalRevenue > 0 && (
                    <p className="text-xs text-[var(--muted-foreground)]">{((data.byType.misc / data.totalRevenue) * 100).toFixed(0)}% of total</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Weekly Trend */}
          {data.byWeek.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Weekly Revenue</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Week</th>
                      <th className="text-right p-2 font-medium">Total</th>
                      <th className="text-right p-2 font-medium">New</th>
                      <th className="text-right p-2 font-medium">Returning</th>
                      <th className="text-right p-2 font-medium">Payments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byWeek.map((w) => (
                      <tr key={w.weekId} className="border-b last:border-0">
                        <td className="p-2">
                          {new Date(w.weekStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          {" - "}
                          {new Date(w.weekEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                        <td className="p-2 text-right font-medium">{formatCents(w.total)}</td>
                        <td className="p-2 text-right text-blue-600">{formatCents(w.newRevenue)}</td>
                        <td className="p-2 text-right text-purple-600">{formatCents(w.returningRevenue)}</td>
                        <td className="p-2 text-right">{w.paymentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Revenue by Customer */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Revenue by Customer</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setShowCustomers(!showCustomers)}>
                  {showCustomers ? "Collapse" : "Expand"}
                </Button>
              </div>
            </CardHeader>
            {showCustomers && (
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Customer</th>
                      <th className="text-left p-2 font-medium">Type</th>
                      <th className="text-left p-2 font-medium">Status</th>
                      <th className="text-right p-2 font-medium">Payments</th>
                      <th className="text-right p-2 font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCustomer.map((c, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="p-2">
                          <p className="font-medium">{c.name}</p>
                          {c.email && <p className="text-xs text-[var(--muted-foreground)]">{c.email}</p>}
                        </td>
                        <td className="p-2">
                          <Badge variant={c.revenueType === "mrr" ? "success" : "secondary"}>
                            {c.revenueType === "mrr" ? "MRR" : c.revenueType === "one_time" ? "One-time" : c.revenueType}
                          </Badge>
                        </td>
                        <td className="p-2">
                          <Badge variant={c.customerStatus === "new" ? "warning" : "secondary"}>
                            {c.customerStatus}
                          </Badge>
                        </td>
                        <td className="p-2 text-right">{c.payments}</td>
                        <td className="p-2 text-right font-medium text-green-600">{formatCents(c.total)}</td>
                      </tr>
                    ))}
                    {data.byCustomer.length === 0 && (
                      <tr><td colSpan={5} className="p-4 text-center text-[var(--muted-foreground)]">No payments this period</td></tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            )}
          </Card>

          {/* All Payments */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">All Payments ({data.paymentCount})</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setShowPayments(!showPayments)}>
                  {showPayments ? "Collapse" : "Expand"}
                </Button>
              </div>
            </CardHeader>
            {showPayments && (
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Date</th>
                      <th className="text-left p-2 font-medium">Customer</th>
                      <th className="text-left p-2 font-medium">Type</th>
                      <th className="text-left p-2 font-medium">Status</th>
                      <th className="text-left p-2 font-medium">Match</th>
                      <th className="text-right p-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((p) => (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="p-2">{formatDate(p.paidAt)}</td>
                        <td className="p-2">{p.customerName || p.customerEmail || "Unknown"}</td>
                        <td className="p-2">
                          <Badge variant={p.revenueType === "mrr" ? "success" : "secondary"}>
                            {p.revenueType === "mrr" ? "MRR" : p.revenueType === "one_time" ? "1x" : p.revenueType}
                          </Badge>
                        </td>
                        <td className="p-2">
                          <Badge variant={p.customerStatus === "new" ? "warning" : "secondary"}>
                            {p.customerStatus}
                          </Badge>
                        </td>
                        <td className="p-2">
                          {p.matchStatus === "matched" && <Badge variant="success">Matched</Badge>}
                          {p.matchStatus === "unmatched" && <Badge variant="secondary">Unmatched</Badge>}
                          {p.matchStatus === "needs_review" && <Badge variant="danger">Review</Badge>}
                        </td>
                        <td className="p-2 text-right">
                          <span className={`font-medium ${p.status === "refunded" || p.status === "disputed" ? "text-red-600 line-through" : "text-green-600"}`}>
                            {formatCents(p.amountCents)}
                          </span>
                          {p.refundedCents > 0 && p.status !== "refunded" && (
                            <span className="text-xs text-red-600 block">-{formatCents(p.refundedCents)} refunded</span>
                          )}
                          {p.status === "disputed" && (
                            <span className="text-xs text-red-600 block">DISPUTED</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
