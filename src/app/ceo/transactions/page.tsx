"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterClassification, setFilterClassification] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [offset, setOffset] = useState(0);
  const [showAmexUpload, setShowAmexUpload] = useState(false);
  const limit = 50;

  const loadData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (search) params.set("search", search);
    if (filterClassification) params.set("classification", filterClassification);
    if (filterStatus) params.set("status", filterStatus);
    if (filterSource) params.set("source", filterSource);

    fetch(`/api/ceo/transactions?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setTransactions(data.transactions || []);
        setTotal(data.total || 0);
        setLoading(false);
      });
  }, [search, filterClassification, filterStatus, filterSource, offset]);

  useEffect(() => { loadData(); }, [loadData]);

  const categorizeTx = async (txId: string, classification: string) => {
    await fetch("/api/ceo/categorize", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: txId, classification }),
    });
    loadData();
  };

  const handleAmexUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const csvData = await file.text();
    const res = await fetch("/api/ceo/amex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvData }),
    });
    const result = await res.json();
    alert(`Imported ${result.synced} transactions, skipped ${result.skipped}${result.errors?.length ? `, ${result.errors.length} errors` : ""}`);
    setShowAmexUpload(false);
    loadData();
  };

  const classificationColor = (c: string) => {
    switch (c) {
      case "business": return "text-blue-600";
      case "personal": return "text-purple-600";
      case "payroll": return "text-orange-600";
      case "internal_transfer": return "text-gray-500";
      default: return "text-amber-600";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Transaction Ledger</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowAmexUpload(!showAmexUpload)}>
            Import Amex CSV
          </Button>
        </div>
      </div>

      {showAmexUpload && (
        <Card>
          <CardHeader><CardTitle>Import Amex Statement</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-[var(--muted-foreground)] mb-3">
              Upload your Amex CSV export. Expected format: Date, Description, Card Member, Amount
            </p>
            <label className="inline-flex items-center gap-2 px-4 py-2 bg-white border rounded-lg cursor-pointer hover:bg-gray-50">
              Choose CSV File
              <input type="file" accept=".csv" onChange={handleAmexUpload} className="hidden" />
            </label>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search merchants, descriptions..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          className="border rounded-lg px-3 py-2 text-sm w-64"
        />
        <select
          value={filterClassification}
          onChange={(e) => { setFilterClassification(e.target.value); setOffset(0); }}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All Classifications</option>
          <option value="business">Business</option>
          <option value="personal">Personal</option>
          <option value="payroll">Payroll</option>
          <option value="internal_transfer">Internal Transfer</option>
          <option value="needs_review">Needs Review</option>
        </select>
        <select
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); setOffset(0); }}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All Statuses</option>
          <option value="needs_review">Needs Review</option>
          <option value="auto_categorized">Auto-Categorized</option>
          <option value="confirmed">Confirmed</option>
        </select>
        <select
          value={filterSource}
          onChange={(e) => { setFilterSource(e.target.value); setOffset(0); }}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All Sources</option>
          <option value="mercury">Mercury</option>
          <option value="stripe">Stripe</option>
          <option value="amex">Amex</option>
        </select>
      </div>

      {/* Results count */}
      <p className="text-sm text-[var(--muted-foreground)]">
        Showing {transactions.length} of {total} transactions
      </p>

      {/* Transaction Table */}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="text-left p-3 font-medium">Date</th>
                <th className="text-left p-3 font-medium">Merchant / Description</th>
                <th className="text-left p-3 font-medium">Source</th>
                <th className="text-left p-3 font-medium">Classification</th>
                <th className="text-left p-3 font-medium">Category</th>
                <th className="text-right p-3 font-medium">Amount</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Actions</th>
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
                  <td className="p-3">
                    <Badge variant="secondary">{tx.source}</Badge>
                  </td>
                  <td className="p-3">
                    <span className={`text-xs font-medium ${classificationColor(tx.classification)}`}>
                      {tx.classification}
                    </span>
                  </td>
                  <td className="p-3 text-xs">{tx.category?.name || "—"}</td>
                  <td className={`p-3 text-right font-medium ${tx.amountCents >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {formatCents(tx.amountCents)}
                  </td>
                  <td className="p-3">
                    {tx.status === "confirmed" && <Badge variant="success">Confirmed</Badge>}
                    {tx.status === "auto_categorized" && <Badge variant="warning">Auto</Badge>}
                    {tx.status === "needs_review" && <Badge variant="danger">Review</Badge>}
                  </td>
                  <td className="p-3">
                    {tx.status !== "confirmed" && (
                      <select
                        className="text-xs border rounded px-1 py-0.5"
                        defaultValue=""
                        onChange={(e) => categorizeTx(tx.id, e.target.value)}
                      >
                        <option value="" disabled>Classify...</option>
                        <option value="business">Business</option>
                        <option value="personal">Personal</option>
                        <option value="payroll">Payroll</option>
                        <option value="internal_transfer">Internal Transfer</option>
                      </select>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && transactions.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-[var(--muted-foreground)]">
                    No transactions found. Sync Mercury or import Amex CSV to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Previous
          </Button>
          <span className="text-sm text-[var(--muted-foreground)] flex items-center">
            Page {Math.floor(offset / limit) + 1} of {Math.ceil(total / limit)}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
