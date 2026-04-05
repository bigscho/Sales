"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/utils";

interface PnlData {
  period: { month: number; year: number; view: string };
  revenue: { mrr: number; oneTime: number; other: number; total: number };
  expenses: {
    business: number;
    payroll: number;
    personal: number;
    byCategory: Array<{ name: string; total: number; items: number }>;
  };
  netProfit: number;
  margin: number;
  monthlyClose: { status: string; confirmedAt: string } | null;
  weeklyCloses: Array<{ weekStart: string; weekEnd: string; status: string }>;
  comparison: {
    prevRevenue: number;
    prevExpenses: number;
    prevNetProfit: number;
    revenueChange: number;
  };
  transactionCount: number;
  needsReviewCount: number;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function CEOPnLPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<PnlData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showExpenseDetail, setShowExpenseDetail] = useState(false);
  const [closing, setClosing] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    fetch(`/api/ceo/pnl?month=${month}&year=${year}&view=monthly`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, [month, year]);

  useEffect(() => { loadData(); }, [loadData]);

  const closeMonth = async () => {
    setClosing(true);
    try {
      const res = await fetch("/api/ceo/monthly-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year }),
      });
      const result = await res.json();
      if (!res.ok) {
        alert(result.error || "Failed to close month");
        return;
      }
      if (result.warnings) alert(result.warnings);
      loadData();
    } finally {
      setClosing(false);
    }
  };

  const changePercent = (current: number, previous: number) => {
    if (previous === 0) return null;
    const pct = ((current - previous) / previous) * 100;
    return pct;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Profit & Loss</h2>
          <p className="text-sm text-[var(--muted-foreground)]">
            {MONTH_NAMES[month - 1]} {year}
            {data?.monthlyClose?.status === "confirmed" && (
              <Badge variant="success" className="ml-2">Closed</Badge>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Month navigation */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (month === 1) { setMonth(12); setYear(year - 1); }
              else setMonth(month - 1);
            }}
          >
            ←
          </Button>
          <span className="text-sm font-medium w-24 text-center">{MONTH_NAMES[month - 1]} {year}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (month === 12) { setMonth(1); setYear(year + 1); }
              else setMonth(month + 1);
            }}
          >
            →
          </Button>
          {data?.monthlyClose?.status !== "confirmed" && (
            <Button
              size="sm"
              onClick={closeMonth}
              disabled={closing || (data?.needsReviewCount || 0) > 0}
            >
              {closing ? "Closing..." : "Close Month"}
            </Button>
          )}
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
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Revenue</p>
                <p className="text-2xl font-bold text-green-600">{formatCents(data.revenue.total)}</p>
                {data.comparison.prevRevenue > 0 && (
                  <p className={`text-xs mt-1 ${data.comparison.revenueChange >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {data.comparison.revenueChange >= 0 ? "+" : ""}{(data.comparison.revenueChange * 100).toFixed(1)}% vs prev month
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Business Expenses</p>
                <p className="text-2xl font-bold text-red-600">{formatCents(data.expenses.business)}</p>
                {(() => {
                  const pct = changePercent(data.expenses.business, data.comparison.prevExpenses);
                  return pct !== null && (
                    <p className={`text-xs mt-1 ${pct <= 0 ? "text-green-600" : "text-red-600"}`}>
                      {pct >= 0 ? "+" : ""}{pct.toFixed(1)}% vs prev month
                    </p>
                  );
                })()}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Net Profit</p>
                <p className={`text-2xl font-bold ${data.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCents(data.netProfit)}
                </p>
                {data.comparison.prevNetProfit !== 0 && (
                  <p className={`text-xs mt-1 ${data.netProfit >= data.comparison.prevNetProfit ? "text-green-600" : "text-red-600"}`}>
                    Prev: {formatCents(data.comparison.prevNetProfit)}
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Margin</p>
                <p className={`text-2xl font-bold ${data.margin >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {(data.margin * 100).toFixed(1)}%
                </p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {data.transactionCount} transactions
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Revenue Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Revenue Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-[var(--muted-foreground)]">MRR (Subscriptions)</p>
                  <p className="text-lg font-bold">{formatCents(data.revenue.mrr)}</p>
                </div>
                <div>
                  <p className="text-sm text-[var(--muted-foreground)]">One-Time</p>
                  <p className="text-lg font-bold">{formatCents(data.revenue.oneTime)}</p>
                </div>
                <div>
                  <p className="text-sm text-[var(--muted-foreground)]">Other</p>
                  <p className="text-lg font-bold">{formatCents(data.revenue.other)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Expense Breakdown */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Expense Breakdown</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setShowExpenseDetail(!showExpenseDetail)}>
                  {showExpenseDetail ? "Collapse" : "Expand"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 mb-4">
                <div className="flex justify-between py-2 border-b">
                  <span className="font-medium">Business Expenses</span>
                  <span className="font-bold">{formatCents(data.expenses.business)}</span>
                </div>
                <div className="flex justify-between py-2 border-b">
                  <span className="font-medium">Payroll</span>
                  <span className="font-bold">{formatCents(data.expenses.payroll)}</span>
                </div>
                <div className="flex justify-between py-2 border-b text-gray-500">
                  <span>Personal (excluded from P&L)</span>
                  <span>{formatCents(data.expenses.personal)}</span>
                </div>
              </div>

              {showExpenseDetail && data.expenses.byCategory.length > 0 && (
                <div className="mt-4 border-t pt-4">
                  <p className="text-sm font-medium mb-3">Business Expenses by Category</p>
                  <table className="w-full text-sm">
                    <thead className="border-b">
                      <tr>
                        <th className="text-left p-2 font-medium">Category</th>
                        <th className="text-right p-2 font-medium">Items</th>
                        <th className="text-right p-2 font-medium">Total</th>
                        <th className="text-right p-2 font-medium">% of Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.expenses.byCategory.map((cat) => (
                        <tr key={cat.name} className="border-b last:border-0">
                          <td className="p-2">{cat.name}</td>
                          <td className="p-2 text-right">{cat.items}</td>
                          <td className="p-2 text-right font-medium">{formatCents(cat.total)}</td>
                          <td className="p-2 text-right text-[var(--muted-foreground)]">
                            {data.expenses.business > 0
                              ? ((cat.total / data.expenses.business) * 100).toFixed(1)
                              : "0.0"}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Weekly Close Status */}
          {data.weeklyCloses.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Weekly Close Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2 flex-wrap">
                  {data.weeklyCloses.map((wc) => (
                    <div
                      key={wc.weekStart}
                      className={`px-3 py-2 rounded-lg text-sm border ${
                        wc.status === "confirmed"
                          ? "bg-green-50 border-green-200 text-green-800"
                          : "bg-amber-50 border-amber-200 text-amber-800"
                      }`}
                    >
                      {new Date(wc.weekStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      {" "}{wc.status === "confirmed" ? "✓" : "pending"}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Needs Review Warning */}
          {data.needsReviewCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="font-medium text-amber-800">
                {data.needsReviewCount} transactions need review before month can be closed
              </p>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
