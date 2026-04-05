"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, formatDate, formatDateShort } from "@/lib/utils";

interface Transaction {
  id: string;
  source: string;
  date: string;
  amountCents: number;
  merchantName: string | null;
  description: string | null;
  classification: string;
  categoryId: string | null;
  status: string;
  confidenceScore: number;
  notes: string | null;
  category: { id: string; name: string } | null;
}

interface CategorySummary {
  name: string;
  classification: string;
  categoryName: string | null;
  categoryId: string | null;
  total: number;
  count: number;
  needsReview: number;
  autoConfirmed: number;
}

interface PendingWeek {
  weekStart: string;
  weekEnd: string;
  needsReview: number;
  total: number;
}

export default function WeeklyReviewPage() {
  const [pendingWeeks, setPendingWeeks] = useState<PendingWeek[]>([]);
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categorySummary, setCategorySummary] = useState<CategorySummary[]>([]);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  const loadWeeks = useCallback(() => {
    setLoading(true);
    fetch("/api/ceo/weekly-review")
      .then((r) => r.json())
      .then((data) => {
        setPendingWeeks(data.pendingWeeks || []);
        setLoading(false);
        // Auto-select the oldest pending week
        if (data.pendingWeeks?.length > 0 && !selectedWeek) {
          setSelectedWeek(data.pendingWeeks[data.pendingWeeks.length - 1].weekStart);
        }
      });
  }, [selectedWeek]);

  const loadWeekDetail = useCallback(() => {
    if (!selectedWeek) return;
    fetch(`/api/ceo/weekly-review?weekStart=${selectedWeek}`)
      .then((r) => r.json())
      .then((data) => {
        setTransactions(data.transactions || []);
        setCategorySummary(data.categorySummary || []);
        setNeedsReviewCount(data.needsReviewCount || 0);
      });
  }, [selectedWeek]);

  useEffect(() => { loadWeeks(); }, [loadWeeks]);
  useEffect(() => { loadWeekDetail(); }, [loadWeekDetail]);

  const categorizeTx = async (txId: string, classification: string, categoryId?: string) => {
    await fetch("/api/ceo/categorize", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: txId, classification, categoryId: categoryId || null }),
    });
    loadWeekDetail();
  };

  const confirmWeek = async () => {
    if (!selectedWeek) return;
    setConfirming(true);
    try {
      const res = await fetch("/api/ceo/weekly-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekStart: selectedWeek, action: "confirm" }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to confirm week");
        return;
      }
      // Move to next week or show success
      setSelectedWeek(null);
      loadWeeks();
    } finally {
      setConfirming(false);
    }
  };

  const acceptAll = async (cat: CategorySummary) => {
    const catTxs = transactions.filter((tx) => {
      const key = tx.category?.name || tx.classification;
      return key === cat.name && tx.status !== "confirmed";
    });
    for (const tx of catTxs) {
      await categorizeTx(tx.id, tx.classification, tx.categoryId || undefined);
    }
    loadWeekDetail();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Weekly Review</h2>
        <p className="text-[var(--muted-foreground)]">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Weekly Review</h2>
          <p className="text-sm text-[var(--muted-foreground)]">
            {pendingWeeks.length} week{pendingWeeks.length !== 1 ? "s" : ""} pending review
          </p>
        </div>
        {selectedWeek && needsReviewCount === 0 && (
          <Button onClick={confirmWeek} disabled={confirming}>
            {confirming ? "Confirming..." : "Confirm Week"}
          </Button>
        )}
      </div>

      {/* Week Selector */}
      {pendingWeeks.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {pendingWeeks.map((week) => (
            <button
              key={week.weekStart}
              onClick={() => setSelectedWeek(week.weekStart)}
              className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                selectedWeek === week.weekStart
                  ? "bg-green-50 border-green-300 text-green-800"
                  : "bg-white border-gray-200 hover:bg-gray-50"
              }`}
            >
              <span className="font-medium">
                {formatDateShort(week.weekStart)} - {formatDateShort(week.weekEnd)}
              </span>
              {week.needsReview > 0 && (
                <Badge variant="danger" className="ml-2">{week.needsReview}</Badge>
              )}
            </button>
          ))}
        </div>
      )}

      {pendingWeeks.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-lg font-medium text-green-600">All caught up!</p>
            <p className="text-sm text-[var(--muted-foreground)]">No weeks pending review</p>
          </CardContent>
        </Card>
      )}

      {/* Category-Level Summary */}
      {selectedWeek && categorySummary.length > 0 && (
        <div className="space-y-3">
          {categorySummary.map((cat) => (
            <Card key={cat.name}>
              <div
                className="cursor-pointer"
                onClick={() => setExpandedCategory(expandedCategory === cat.name ? null : cat.name)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-lg">
                        {cat.needsReview === 0 ? "✓" : "⚠"}
                      </span>
                      <div>
                        <CardTitle className="text-base">{cat.name}</CardTitle>
                        <p className="text-xs text-[var(--muted-foreground)]">
                          {cat.count} transaction{cat.count !== 1 ? "s" : ""}
                          {cat.needsReview > 0 && (
                            <span className="text-amber-600 ml-2">{cat.needsReview} need review</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`font-bold ${cat.total >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {formatCents(cat.total)}
                      </p>
                      {cat.needsReview === 0 && cat.autoConfirmed > 0 && (
                        <Badge variant="success" className="mt-1">Auto-categorized</Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
              </div>

              {/* Expanded: Show transactions in this category */}
              {expandedCategory === cat.name && (
                <CardContent>
                  <div className="flex justify-end mb-3">
                    {cat.needsReview === 0 && cat.autoConfirmed > 0 && (
                      <Button size="sm" variant="outline" onClick={() => acceptAll(cat)}>
                        Accept All
                      </Button>
                    )}
                  </div>
                  <table className="w-full text-sm">
                    <thead className="border-b">
                      <tr>
                        <th className="text-left p-2 font-medium">Date</th>
                        <th className="text-left p-2 font-medium">Merchant</th>
                        <th className="text-left p-2 font-medium">Source</th>
                        <th className="text-right p-2 font-medium">Amount</th>
                        <th className="text-left p-2 font-medium">Status</th>
                        <th className="p-2 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions
                        .filter((tx) => {
                          const key = tx.category?.name || tx.classification;
                          return key === cat.name;
                        })
                        .map((tx) => (
                          <tr key={tx.id} className="border-b last:border-0">
                            <td className="p-2">{formatDate(tx.date)}</td>
                            <td className="p-2">{tx.merchantName || tx.description || "—"}</td>
                            <td className="p-2">
                              <Badge variant="secondary">{tx.source}</Badge>
                            </td>
                            <td className={`p-2 text-right font-medium ${tx.amountCents >= 0 ? "text-green-600" : "text-red-600"}`}>
                              {formatCents(tx.amountCents)}
                            </td>
                            <td className="p-2">
                              {tx.status === "confirmed" && <Badge variant="success">Confirmed</Badge>}
                              {tx.status === "auto_categorized" && <Badge variant="warning">Auto</Badge>}
                              {tx.status === "needs_review" && <Badge variant="danger">Review</Badge>}
                            </td>
                            <td className="p-2">
                              {tx.status !== "confirmed" && (
                                <div className="flex gap-1">
                                  <select
                                    className="text-xs border rounded px-1 py-0.5"
                                    defaultValue=""
                                    onChange={(e) => {
                                      const [cls, catId] = e.target.value.split("|");
                                      categorizeTx(tx.id, cls, catId || undefined);
                                    }}
                                  >
                                    <option value="" disabled>Classify...</option>
                                    <option value="business|">Business</option>
                                    <option value="personal|">Personal</option>
                                    <option value="payroll|">Payroll</option>
                                    <option value="internal_transfer|">Internal Transfer</option>
                                  </select>
                                  <button
                                    onClick={() => categorizeTx(tx.id, tx.classification, tx.categoryId || undefined)}
                                    className="text-xs text-green-600 hover:underline"
                                  >
                                    Accept
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {selectedWeek && transactions.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-[var(--muted-foreground)]">No transactions for this week</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
