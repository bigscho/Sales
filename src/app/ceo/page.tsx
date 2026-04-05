"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/utils";

interface PnlData {
  revenue: { mrr: number; oneTime: number; other: number; total: number };
  expenses: { business: number; payroll: number; personal: number };
  netProfit: number;
  margin: number;
  needsReviewCount: number;
  transactionCount: number;
}

interface MrrData {
  activeMrr: number;
  projectedMrr: number;
  newMrr: number;
  churnedMrr: number;
  netMrrChange: number;
  activeCustomers: number;
  pendingChurns: Array<{ clientName: string; mrrAmountCents: number }>;
}

interface WeeklyReviewData {
  pendingWeeks: Array<{
    weekStart: string;
    weekEnd: string;
    needsReview: number;
    total: number;
  }>;
}

export default function CEODashboard() {
  const [pnl, setPnl] = useState<PnlData | null>(null);
  const [mrr, setMrr] = useState<MrrData | null>(null);
  const [review, setReview] = useState<WeeklyReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/ceo/pnl?view=mtd").then((r) => r.json()),
      fetch("/api/ceo/mrr").then((r) => r.json()),
      fetch("/api/ceo/weekly-review").then((r) => r.json()),
    ]).then(([pnlData, mrrData, reviewData]) => {
      setPnl(pnlData);
      setMrr(mrrData);
      setReview(reviewData);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const syncMercury = async () => {
    setSyncing(true);
    try {
      await fetch("/api/ceo/mercury", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      loadData();
    } finally {
      setSyncing(false);
    }
  };

  const pendingReviewCount = review?.pendingWeeks?.reduce((sum, w) => sum + w.needsReview, 0) || 0;
  const pendingWeekCount = review?.pendingWeeks?.length || 0;

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">CEO Dashboard</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><div className="h-16 bg-gray-100 rounded animate-pulse" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">CEO Dashboard</h2>
          <p className="text-sm text-[var(--muted-foreground)]">
            {new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })} — Month to Date
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={syncMercury} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync Mercury"}
          </Button>
          <Link href="/ceo/review">
            <Button size="sm" variant={pendingReviewCount > 0 ? "default" : "outline"}>
              Review {pendingReviewCount > 0 && <Badge variant="danger" className="ml-2">{pendingReviewCount}</Badge>}
            </Button>
          </Link>
        </div>
      </div>

      {/* Alert: Pending Reviews */}
      {pendingWeekCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between">
          <div>
            <p className="font-medium text-amber-800">
              {pendingWeekCount} week{pendingWeekCount > 1 ? "s" : ""} pending review
            </p>
            <p className="text-sm text-amber-600">
              {pendingReviewCount} transaction{pendingReviewCount !== 1 ? "s" : ""} need classification
            </p>
          </div>
          <Link href="/ceo/review">
            <Button size="sm">Start Review</Button>
          </Link>
        </div>
      )}

      {/* Top KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--muted-foreground)]">MTD Revenue</p>
            <p className="text-2xl font-bold text-green-600">{formatCents(pnl?.revenue.total || 0)}</p>
            <div className="flex gap-3 mt-2 text-xs text-[var(--muted-foreground)]">
              <span>MRR: {formatCents(pnl?.revenue.mrr || 0)}</span>
              <span>1x: {formatCents(pnl?.revenue.oneTime || 0)}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--muted-foreground)]">MTD Expenses</p>
            <p className="text-2xl font-bold text-red-600">{formatCents((pnl?.expenses.business || 0) + (pnl?.expenses.payroll || 0))}</p>
            <div className="flex gap-3 mt-2 text-xs text-[var(--muted-foreground)]">
              <span>Biz: {formatCents(pnl?.expenses.business || 0)}</span>
              <span>Pay: {formatCents(pnl?.expenses.payroll || 0)}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--muted-foreground)]">MTD Net Profit</p>
            <p className={`text-2xl font-bold ${(pnl?.netProfit || 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
              {formatCents(pnl?.netProfit || 0)}
            </p>
            <p className="text-xs text-[var(--muted-foreground)] mt-2">
              Margin: {((pnl?.margin || 0) * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--muted-foreground)]">Needs Review</p>
            <p className={`text-2xl font-bold ${(pnl?.needsReviewCount || 0) > 0 ? "text-amber-600" : "text-green-600"}`}>
              {pnl?.needsReviewCount || 0}
            </p>
            <p className="text-xs text-[var(--muted-foreground)] mt-2">
              of {pnl?.transactionCount || 0} transactions
            </p>
          </CardContent>
        </Card>
      </div>

      {/* MRR Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Live MRR</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-[var(--muted-foreground)]">Active MRR</span>
                <span className="text-xl font-bold text-green-600">{formatCents(mrr?.activeMrr || 0)}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-[var(--muted-foreground)]">Projected MRR</span>
                <span className="text-lg font-semibold">{formatCents(mrr?.projectedMrr || 0)}</span>
              </div>
              <div className="border-t pt-2 flex gap-4 text-sm">
                <span className="text-green-600">+{formatCents(mrr?.newMrr || 0)} new</span>
                <span className="text-red-600">-{formatCents(mrr?.churnedMrr || 0)} churned</span>
              </div>
              <div className="flex justify-between text-sm text-[var(--muted-foreground)]">
                <span>{mrr?.activeCustomers || 0} active customers</span>
                <span>Net: {formatCents(mrr?.netMrrChange || 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Pending Churns</CardTitle>
              <Link href="/ceo/transactions">
                <Button size="sm" variant="outline">Mark Churning</Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {mrr?.pendingChurns && mrr.pendingChurns.length > 0 ? (
              <div className="space-y-2">
                {mrr.pendingChurns.map((c, i) => (
                  <div key={i} className="flex justify-between items-center py-1 border-b last:border-0">
                    <span className="text-sm">{c.clientName}</span>
                    <span className="text-sm font-medium text-red-600">-{formatCents(c.mrrAmountCents)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--muted-foreground)]">No pending churns</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/ceo/pnl">
          <Card className="hover:shadow-md cursor-pointer transition-shadow">
            <CardContent className="pt-6">
              <p className="font-medium">Monthly P&L</p>
              <p className="text-sm text-[var(--muted-foreground)]">Full breakdown with drill-down</p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/ceo/review">
          <Card className="hover:shadow-md cursor-pointer transition-shadow">
            <CardContent className="pt-6">
              <p className="font-medium">Weekly Review</p>
              <p className="text-sm text-[var(--muted-foreground)]">Categorize & confirm transactions</p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/ceo/transactions">
          <Card className="hover:shadow-md cursor-pointer transition-shadow">
            <CardContent className="pt-6">
              <p className="font-medium">Transaction Ledger</p>
              <p className="text-sm text-[var(--muted-foreground)]">Search all financial transactions</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
