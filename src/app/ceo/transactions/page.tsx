"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, formatDate } from "@/lib/utils";

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

interface Category {
  id: string;
  name: string;
}

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterClassification, setFilterClassification] = useState("needs_review");
  const [filterSource, setFilterSource] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const loadData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (search) params.set("search", search);
    if (filterClassification) params.set("classification", filterClassification);
    if (filterSource) params.set("source", filterSource);

    fetch(`/api/ceo/transactions?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setTransactions(data.transactions || []);
        setTotal(data.total || 0);
        setLoading(false);
      });
  }, [search, filterClassification, filterSource, offset]);

  useEffect(() => { loadData(); }, [loadData]);

  // Load categories for business sub-categories
  useEffect(() => {
    fetch("/api/ceo/categories")
      .then((r) => r.json())
      .then((d) => setCategories(d.categories || []));
  }, []);

  const categorizeBulk = async (merchantName: string, classification: string, categoryId?: string) => {
    // Find all transactions with this merchant name
    const matching = transactions.filter(t => t.merchantName === merchantName);
    for (const tx of matching) {
      await fetch("/api/ceo/categorize", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: tx.id, classification, categoryId: categoryId || null }),
      });
    }
    // Remove all matching from list
    setTransactions(prev => prev.filter(t => t.merchantName !== merchantName));
    setTotal(prev => prev - matching.length);
  };

  const isReviewMode = filterClassification === "needs_review";

  // Group by merchant for review mode
  const merchantGroups = isReviewMode ? (() => {
    const groups: Record<string, { merchant: string; total: number; count: number; txIds: string[] }> = {};
    for (const tx of transactions) {
      const key = tx.merchantName || "Unknown";
      if (!groups[key]) groups[key] = { merchant: key, total: 0, count: 0, txIds: [] };
      groups[key].total += Math.abs(tx.amountCents);
      groups[key].count++;
      groups[key].txIds.push(tx.id);
    }
    return Object.values(groups).sort((a, b) => b.total - a.total);
  })() : [];

  const [expandedMerchant, setExpandedMerchant] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Transactions</h2>
          {isReviewMode && (
            <p className="text-sm text-amber-600 font-medium">{total} transactions need categorization</p>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search merchants..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          className="border rounded-lg px-3 py-2 text-sm w-64"
        />
        <select
          value={filterClassification}
          onChange={(e) => { setFilterClassification(e.target.value); setOffset(0); }}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All</option>
          <option value="needs_review">Needs Review</option>
          <option value="business">Business</option>
          <option value="personal">Personal</option>
          <option value="payroll">Payroll</option>
          <option value="internal_transfer">Internal Transfer</option>
        </select>
        <select
          value={filterSource}
          onChange={(e) => { setFilterSource(e.target.value); setOffset(0); }}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All Sources</option>
          <option value="amex">Amex</option>
          <option value="mercury">Mercury</option>
          <option value="stripe">Stripe</option>
        </select>
      </div>

      {/* Review Mode: Grouped by merchant with big buttons */}
      {isReviewMode && merchantGroups.length > 0 && (
        <div className="space-y-2">
          {merchantGroups.map((group) => (
            <Card key={group.merchant} className="border-amber-100">
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between gap-4">
                  {/* Merchant info */}
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => setExpandedMerchant(expandedMerchant === group.merchant ? null : group.merchant)}
                  >
                    <p className="font-medium">{group.merchant}</p>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {formatCents(group.total)} · {group.count} transaction{group.count !== 1 ? "s" : ""}
                    </p>
                  </div>

                  {/* Quick classify buttons */}
                  <div className="flex gap-1.5 flex-wrap">
                    <button
                      onClick={() => categorizeBulk(group.merchant, "personal")}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200 transition-colors"
                    >
                      Personal
                    </button>
                    <button
                      onClick={() => categorizeBulk(group.merchant, "payroll")}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-orange-100 text-orange-700 hover:bg-orange-200 transition-colors"
                    >
                      Payroll
                    </button>
                    <button
                      onClick={() => categorizeBulk(group.merchant, "internal_transfer")}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
                    >
                      Transfer
                    </button>

                    {/* Business sub-categories */}
                    <select
                      className="px-2 py-1.5 text-xs font-medium rounded-lg bg-blue-100 text-blue-700 border-0 cursor-pointer"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) {
                          categorizeBulk(group.merchant, "business", e.target.value);
                          e.target.value = "";
                        }
                      }}
                    >
                      <option value="" disabled>Business ▾</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Expanded: show individual transactions */}
                {expandedMerchant === group.merchant && (
                  <div className="mt-3 border-t pt-2">
                    {transactions.filter(t => t.merchantName === group.merchant).map((tx) => (
                      <div key={tx.id} className="flex items-center justify-between py-1 text-xs text-[var(--muted-foreground)]">
                        <span>{formatDate(tx.date)}</span>
                        <span className="font-medium">{formatCents(Math.abs(tx.amountCents))}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {isReviewMode && merchantGroups.length === 0 && !loading && (
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-lg font-medium text-green-600">All caught up!</p>
            <p className="text-sm text-[var(--muted-foreground)]">No transactions need review</p>
          </CardContent>
        </Card>
      )}

      {/* Standard table view for non-review mode */}
      {!isReviewMode && (
        <>
          <p className="text-sm text-[var(--muted-foreground)]">
            Showing {transactions.length} of {total}
          </p>
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50">
                  <tr>
                    <th className="text-left p-3 font-medium">Date</th>
                    <th className="text-left p-3 font-medium">Merchant</th>
                    <th className="text-left p-3 font-medium">Source</th>
                    <th className="text-left p-3 font-medium">Classification</th>
                    <th className="text-left p-3 font-medium">Category</th>
                    <th className="text-right p-3 font-medium">Amount</th>
                    <th className="text-left p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="p-3">{formatDate(tx.date)}</td>
                      <td className="p-3">
                        <p className="font-medium">{tx.merchantName || "—"}</p>
                        {tx.description && tx.description !== tx.merchantName && (
                          <p className="text-xs text-[var(--muted-foreground)]">{tx.description}</p>
                        )}
                      </td>
                      <td className="p-3"><Badge variant="secondary">{tx.source}</Badge></td>
                      <td className="p-3">
                        <Badge variant={
                          tx.classification === "business" ? "success" :
                          tx.classification === "personal" ? "warning" :
                          tx.classification === "payroll" ? "warning" :
                          "secondary"
                        }>
                          {tx.classification}
                        </Badge>
                      </td>
                      <td className="p-3 text-xs">{tx.category?.name || "—"}</td>
                      <td className={`p-3 text-right font-medium ${tx.amountCents >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {formatCents(tx.amountCents)}
                      </td>
                      <td className="p-3">
                        {tx.status === "confirmed" && <Badge variant="success">Confirmed</Badge>}
                        {tx.status === "auto_categorized" && <Badge variant="success">Auto</Badge>}
                        {tx.status === "needs_review" && <Badge variant="danger">Review</Badge>}
                      </td>
                    </tr>
                  ))}
                  {!loading && transactions.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-[var(--muted-foreground)]">
                        No transactions found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-2">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            Previous
          </Button>
          <span className="text-sm text-[var(--muted-foreground)] flex items-center">
            Page {Math.floor(offset / limit) + 1} of {Math.ceil(total / limit)}
          </span>
          <Button size="sm" variant="outline" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
