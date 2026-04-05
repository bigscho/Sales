"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, formatDate } from "@/lib/utils";

interface Subscription {
  clientName: string;
  email: string | null;
  mrrCents: number;
  chargeCents: number;
  interval: string;
  status: string;
  isPaused: boolean;
  isTerminal: boolean;
  nextBillingDate: string | null;
  billsThisMonth: boolean;
  canceledAt: string | null;
  cancelAt: string | null;
  cancelAtPeriodEnd: boolean;
  type: string;
  startDate: string;
}

interface RevenueData {
  period: { month: number; year: number; view: string };
  stripeMrr: {
    activeMrr: number;
    pausedMrr: number;
    terminalMrr: number;
    collectibleThisMonth: number;
    totalOnBooks: number;
    activeCount: number;
    pausedCount: number;
    terminalCount: number;
    billingThisMonthCount: number;
    totalCount: number;
    renewalsNeeded: Subscription[];
    subscriptions: Subscription[];
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
  const [selectedRecoverable, setSelectedRecoverable] = useState<Set<string>>(new Set());
  const [showCollectedList, setShowCollectedList] = useState(false);
  const [showActiveList, setShowActiveList] = useState(false);
  const [showExpectedDetail, setShowExpectedDetail] = useState(false);
  const [showPausedList, setShowPausedList] = useState(false);
  const [showNewRevenue, setShowNewRevenue] = useState(false);
  const [showReturningRevenue, setShowReturningRevenue] = useState(false);
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

  // Recoverable subs: paused monthly + terminal
  const recoverableSubs = data ? [
    ...data.stripeMrr.subscriptions.filter(s => s.isPaused && s.interval === "monthly"),
    ...data.stripeMrr.subscriptions.filter(s => s.isTerminal),
  ] : [];

  const longerConversations = data ? data.stripeMrr.subscriptions.filter(s => s.isPaused && s.interval !== "monthly") : [];

  const toggleRecoverable = (name: string) => {
    setSelectedRecoverable(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const projectedFromRecoveries = recoverableSubs
    .filter(s => selectedRecoverable.has(s.clientName))
    .reduce((sum, s) => sum + s.mrrCents, 0);

  const collectible = data?.stripeMrr.collectibleThisMonth || 0;
  const projected = collectible + projectedFromRecoveries;

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
          {/* === TOP ROW: The Numbers That Matter === */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setShowCollectedList(!showCollectedList)}>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">
                  {data.totalRefunded > 0 ? "Collected (Net)" : "Collected"}
                </p>
                <p className="text-2xl font-bold text-green-600">{formatCents(data.totalRevenue)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {data.paymentCount} payments — click to view
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">MRR</p>
                <p className="text-2xl font-bold text-green-600">{formatCents(data.stripeMrr.activeMrr)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {data.stripeMrr.activeCount} active subs
                </p>
              </CardContent>
            </Card>
            <Card
              className={`cursor-pointer hover:shadow-md transition-shadow ${projectedFromRecoveries > 0 ? "border-amber-200 bg-amber-50/30" : ""}`}
              onClick={() => setShowExpectedDetail(!showExpectedDetail)}
            >
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">
                  {projectedFromRecoveries > 0 ? `Projected ${MONTH_NAMES[month - 1]}` : `${MONTH_NAMES[month - 1]} Expected`}
                </p>
                <p className={`text-2xl font-bold ${projectedFromRecoveries > 0 ? "text-amber-600" : "text-blue-600"}`}>
                  {formatCents(projected)}
                </p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {projectedFromRecoveries > 0
                    ? `${formatCents(collectible)} locked + ${formatCents(projectedFromRecoveries)} from recoveries`
                    : `${data.stripeMrr.billingThisMonthCount} subs · +${formatCents(recoverableSubs.reduce((s, r) => s + r.mrrCents, 0))} recoverable`
                  }
                </p>
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setShowPausedList(!showPausedList)}>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Paused</p>
                <p className="text-2xl font-bold text-gray-500">{formatCents(data.stripeMrr.pausedMrr)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {data.stripeMrr.pausedCount} subs on hold — click to view
                </p>
              </CardContent>
            </Card>
          </div>

          {/* === COLLECTED DRILL-DOWN === */}
          {showCollectedList && (
            <Card>
              <CardHeader><CardTitle className="text-base">Collected This Month</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Date</th>
                      <th className="text-left p-2 font-medium">Customer</th>
                      <th className="text-left p-2 font-medium">Type</th>
                      <th className="text-left p-2 font-medium">Status</th>
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
                            {p.revenueType === "mrr" ? "MRR" : p.revenueType === "one_time" ? "One-time" : p.revenueType}
                          </Badge>
                        </td>
                        <td className="p-2">
                          <Badge variant={p.customerStatus === "new" ? "warning" : "secondary"}>
                            {p.customerStatus}
                          </Badge>
                        </td>
                        <td className="p-2 text-right">
                          <span className={`font-medium ${p.status === "refunded" || p.status === "disputed" ? "text-red-600 line-through" : "text-green-600"}`}>
                            {formatCents(p.amountCents)}
                          </span>
                          {p.refundedCents > 0 && (
                            <span className="text-xs text-red-600 block">-{formatCents(p.refundedCents)} refunded</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {data.payments.length === 0 && (
                      <tr><td colSpan={5} className="p-4 text-center text-[var(--muted-foreground)]">No payments yet this month</td></tr>
                    )}
                  </tbody>
                  <tfoot className="border-t">
                    <tr>
                      <td className="p-2 font-bold" colSpan={4}>
                        {data.totalRefunded > 0 ? `Gross: ${formatCents(data.grossRevenue)} · Refunds: -${formatCents(data.totalRefunded)}` : "Total"}
                      </td>
                      <td className="p-2 text-right font-bold text-green-600">{formatCents(data.totalRevenue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </CardContent>
            </Card>
          )}

          {/* === PAUSED DRILL-DOWN === */}
          {showPausedList && (
            <Card>
              <CardHeader><CardTitle className="text-base">Paused Subscriptions</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Client</th>
                      <th className="text-left p-2 font-medium">Email</th>
                      <th className="text-left p-2 font-medium">Interval</th>
                      <th className="text-left p-2 font-medium">Started</th>
                      <th className="text-right p-2 font-medium">MRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stripeMrr.subscriptions.filter(s => s.isPaused).map((s, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="p-2 font-medium">{s.clientName}</td>
                        <td className="p-2 text-[var(--muted-foreground)]">{s.email || "—"}</td>
                        <td className="p-2"><Badge variant="secondary">{s.interval}</Badge></td>
                        <td className="p-2">{formatDate(s.startDate)}</td>
                        <td className="p-2 text-right font-medium">{formatCents(s.mrrCents)}/mo</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t">
                    <tr>
                      <td className="p-2 font-bold" colSpan={4}>Total Paused MRR</td>
                      <td className="p-2 text-right font-bold">{formatCents(data.stripeMrr.pausedMrr)}/mo</td>
                    </tr>
                  </tfoot>
                </table>
              </CardContent>
            </Card>
          )}

          {/* === EXPECTED + RECOVERABLE SPLIT VIEW === */}
          {showExpectedDetail && (
            <Card className={projectedFromRecoveries > 0 ? "border-amber-200" : ""}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {MONTH_NAMES[month - 1]} Expected: {formatCents(collectible)} locked
                    {projectedFromRecoveries > 0 && ` + ${formatCents(projectedFromRecoveries)} projected`}
                  </CardTitle>
                  <p className={`text-xl font-bold ${projectedFromRecoveries > 0 ? "text-amber-600" : "text-blue-600"}`}>
                    {formatCents(projected)}
                  </p>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* LEFT: Definite collections */}
                  <div>
                    <p className="text-sm font-semibold text-blue-600 mb-3">Locked In ({data.stripeMrr.billingThisMonthCount} subs)</p>
                    <table className="w-full text-sm">
                      <thead className="border-b">
                        <tr>
                          <th className="text-left p-1.5 font-medium">Client</th>
                          <th className="text-left p-1.5 font-medium">Bills On</th>
                          <th className="text-right p-1.5 font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.stripeMrr.subscriptions.filter(s => s.billsThisMonth).map((s, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="p-1.5">
                              <span className="font-medium">{s.clientName}</span>
                              {s.interval !== "monthly" && (
                                <Badge variant="secondary" className="ml-1 text-[10px]">{s.interval}</Badge>
                              )}
                            </td>
                            <td className="p-1.5 text-xs">{s.nextBillingDate ? formatDate(s.nextBillingDate) : "—"}</td>
                            <td className="p-1.5 text-right font-medium text-blue-600">{formatCents(s.chargeCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t">
                        <tr>
                          <td className="p-1.5 font-bold" colSpan={2}>Total Locked</td>
                          <td className="p-1.5 text-right font-bold text-blue-600">{formatCents(collectible)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* RIGHT: Recoverable with checkboxes */}
                  <div>
                    <p className="text-sm font-semibold text-amber-600 mb-3">
                      Recoverable ({recoverableSubs.length} conversations)
                    </p>
                    {recoverableSubs.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead className="border-b">
                          <tr>
                            <th className="p-1.5 w-8"></th>
                            <th className="text-left p-1.5 font-medium">Client</th>
                            <th className="text-left p-1.5 font-medium">Status</th>
                            <th className="text-right p-1.5 font-medium">MRR</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recoverableSubs.map((s, i) => (
                            <tr
                              key={i}
                              className={`border-b last:border-0 cursor-pointer transition-colors ${
                                selectedRecoverable.has(s.clientName) ? "bg-amber-50" : "hover:bg-gray-50"
                              }`}
                              onClick={() => toggleRecoverable(s.clientName)}
                            >
                              <td className="p-1.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={selectedRecoverable.has(s.clientName)}
                                  onChange={(e) => { e.stopPropagation(); toggleRecoverable(s.clientName); }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="rounded cursor-pointer w-4 h-4"
                                />
                              </td>
                              <td className="p-1.5">
                                <p className="font-medium">{s.clientName}</p>
                                {s.email && <p className="text-xs text-[var(--muted-foreground)]">{s.email}</p>}
                              </td>
                              <td className="p-1.5">
                                {s.isPaused && <Badge variant="warning">Paused</Badge>}
                                {s.isTerminal && <Badge variant="danger">Renewal</Badge>}
                              </td>
                              <td className="p-1.5 text-right font-medium text-amber-600">{formatCents(s.mrrCents)}/mo</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="border-t">
                          <tr>
                            <td></td>
                            <td className="p-1.5 font-bold" colSpan={2}>Total Recoverable</td>
                            <td className="p-1.5 text-right font-bold text-amber-600">
                              +{formatCents(recoverableSubs.reduce((sum, s) => sum + s.mrrCents, 0))}/mo
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    ) : (
                      <p className="text-sm text-[var(--muted-foreground)]">No recoverable subs this month</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Longer Conversations (paused quarterly) */}
          {longerConversations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Longer Conversations (Paused Quarterly)</CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <tbody>
                    {longerConversations.map((s, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="p-2 font-medium">{s.clientName}</td>
                        <td className="p-2"><Badge variant="secondary">{s.interval}</Badge></td>
                        <td className="p-2 text-right font-medium">{formatCents(s.mrrCents)}/mo avg</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* === ACTIVE SUBSCRIPTIONS === */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Active Subscriptions ({data.stripeMrr.activeCount})</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setShowActiveList(!showActiveList)}>
                  {showActiveList ? "Collapse" : "Expand"}
                </Button>
              </div>
            </CardHeader>
            {showActiveList && (
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Client</th>
                      <th className="text-left p-2 font-medium">Interval</th>
                      <th className="text-left p-2 font-medium">Type</th>
                      <th className="text-left p-2 font-medium">Next Bill</th>
                      <th className="text-right p-2 font-medium">MRR</th>
                      <th className="text-right p-2 font-medium">Charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stripeMrr.subscriptions
                      .filter(s => !s.isPaused && !s.isTerminal)
                      .map((s, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="p-2">
                            <p className="font-medium">{s.clientName}</p>
                            {s.email && <p className="text-xs text-[var(--muted-foreground)]">{s.email}</p>}
                          </td>
                          <td className="p-2"><Badge variant="secondary">{s.interval}</Badge></td>
                          <td className="p-2">
                            <Badge variant={s.type === "auto-renew" ? "success" : "warning"}>
                              {s.type === "auto-renew" ? "Auto" : s.type}
                            </Badge>
                          </td>
                          <td className="p-2 text-xs">
                            {s.nextBillingDate ? formatDate(s.nextBillingDate) : "—"}
                            {s.billsThisMonth && <span className="text-green-600 ml-1">✓ this month</span>}
                          </td>
                          <td className="p-2 text-right font-medium">{formatCents(s.mrrCents)}</td>
                          <td className="p-2 text-right text-[var(--muted-foreground)]">{formatCents(s.chargeCents)}</td>
                        </tr>
                      ))}
                  </tbody>
                  <tfoot className="border-t">
                    <tr>
                      <td className="p-2 font-bold" colSpan={4}>Total Active MRR</td>
                      <td className="p-2 text-right font-bold text-green-600">{formatCents(data.stripeMrr.activeMrr)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </CardContent>
            )}
          </Card>

          {/* === PERIOD REVENUE (Collected) === */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">
                  {data.totalRefunded > 0 ? "Net Collected" : "Collected"}
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
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setShowNewRevenue(!showNewRevenue)}>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">New Revenue</p>
                <p className="text-2xl font-bold text-blue-600">{formatCents(data.newRevenue)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {data.payments.filter(p => p.customerStatus === "new" && p.status !== "refunded").length} payments — click to expand
                </p>
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setShowReturningRevenue(!showReturningRevenue)}>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Returning Revenue</p>
                <p className="text-2xl font-bold text-purple-600">{formatCents(data.returningRevenue)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {data.payments.filter(p => p.customerStatus === "returning" && p.status !== "refunded").length} payments — click to expand
                </p>
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

          {/* New Revenue Drill-down */}
          {showNewRevenue && (
            <Card>
              <CardHeader><CardTitle className="text-base">New Revenue Transactions</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Date</th>
                      <th className="text-left p-2 font-medium">Customer</th>
                      <th className="text-left p-2 font-medium">Type</th>
                      <th className="text-right p-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments
                      .filter(p => p.customerStatus === "new" && p.status !== "refunded")
                      .map((p) => (
                        <tr key={p.id} className="border-b last:border-0">
                          <td className="p-2">{formatDate(p.paidAt)}</td>
                          <td className="p-2">{p.customerName || p.customerEmail || "Unknown"}</td>
                          <td className="p-2">
                            <Badge variant={p.revenueType === "mrr" ? "success" : "secondary"}>
                              {p.revenueType === "mrr" ? "MRR" : p.revenueType === "one_time" ? "One-time" : p.revenueType}
                            </Badge>
                          </td>
                          <td className="p-2 text-right font-medium text-blue-600">{formatCents(p.amountCents)}</td>
                        </tr>
                      ))}
                  </tbody>
                  <tfoot className="border-t">
                    <tr>
                      <td className="p-2 font-bold" colSpan={3}>Total New Revenue</td>
                      <td className="p-2 text-right font-bold text-blue-600">{formatCents(data.newRevenue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Returning Revenue Drill-down */}
          {showReturningRevenue && (
            <Card>
              <CardHeader><CardTitle className="text-base">Returning Revenue Transactions</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Date</th>
                      <th className="text-left p-2 font-medium">Customer</th>
                      <th className="text-left p-2 font-medium">Type</th>
                      <th className="text-right p-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments
                      .filter(p => p.customerStatus === "returning" && p.status !== "refunded")
                      .map((p) => (
                        <tr key={p.id} className="border-b last:border-0">
                          <td className="p-2">{formatDate(p.paidAt)}</td>
                          <td className="p-2">{p.customerName || p.customerEmail || "Unknown"}</td>
                          <td className="p-2">
                            <Badge variant={p.revenueType === "mrr" ? "success" : "secondary"}>
                              {p.revenueType === "mrr" ? "MRR" : p.revenueType === "one_time" ? "One-time" : p.revenueType}
                            </Badge>
                          </td>
                          <td className="p-2 text-right font-medium text-purple-600">{formatCents(p.amountCents)}</td>
                        </tr>
                      ))}
                  </tbody>
                  <tfoot className="border-t">
                    <tr>
                      <td className="p-2 font-bold" colSpan={3}>Total Returning Revenue</td>
                      <td className="p-2 text-right font-bold text-purple-600">{formatCents(data.returningRevenue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </CardContent>
            </Card>
          )}

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
