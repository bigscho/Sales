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
  category: { id: string; name: string } | null;
}

interface Category {
  id: string;
  name: string;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function ExpensesPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [amexTxns, setAmexTxns] = useState<Transaction[]>([]);
  const [mercuryTxns, setMercuryTxns] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ synced: number; skipped: number; perFile: Array<{ name: string; synced: number; skipped: number }> } | null>(null);
  const [filter, setFilter] = useState<string>("all"); // all | needs_review | business | payroll | personal

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/ceo/transactions?month=${month}&year=${year}&source=amex&limit=500`).then(r => r.json()),
      fetch(`/api/ceo/transactions?month=${month}&year=${year}&source=mercury&limit=500`).then(r => r.json()),
      fetch("/api/ceo/categories").then(r => r.json()),
    ]).then(([amex, mercury, cats]) => {
      // Only outflows (negative amounts) — exclude internal transfers
      setAmexTxns((amex.transactions || []).filter((t: Transaction) => t.amountCents < 0 && t.classification !== "internal_transfer"));
      setMercuryTxns((mercury.transactions || []).filter((t: Transaction) => t.amountCents < 0 && t.classification !== "internal_transfer"));
      setCategories(cats.categories || []);
      setLoading(false);
    });
  }, [month, year]);

  useEffect(() => { loadData(); }, [loadData]);

  const categorizeTx = async (txId: string, classification: string, categoryId?: string) => {
    await fetch("/api/ceo/categorize", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: txId, classification, categoryId: categoryId || null }),
    });
    // Update locally
    const update = (txns: Transaction[]) =>
      txns.map(t => t.id === txId ? { ...t, classification, status: "confirmed" } : t);
    setAmexTxns(update);
    setMercuryTxns(update);
  };

  const handleAmexUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImporting(true);
    const perFile: Array<{ name: string; synced: number; skipped: number }> = [];
    let totalSynced = 0, totalSkipped = 0;
    for (let i = 0; i < files.length; i++) {
      const csvData = await files[i].text();
      const res = await fetch("/api/ceo/amex", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csvData }) });
      const data = await res.json();
      totalSynced += data.summary?.synced || 0;
      totalSkipped += data.summary?.skipped || 0;
      perFile.push({ name: files[i].name, synced: data.summary?.synced || 0, skipped: data.summary?.skipped || 0 });
    }
    setImportResult({ synced: totalSynced, skipped: totalSkipped, perFile });
    setImporting(false);
    loadData();
    e.target.value = "";
  };

  const syncMercury = async () => {
    setImporting(true);
    await fetch("/api/ceo/mercury", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    setImporting(false);
    loadData();
  };

  const filterTxns = (txns: Transaction[]) => {
    if (filter === "all") return txns;
    if (filter === "needs_review") return txns.filter(t => t.status === "needs_review");
    return txns.filter(t => t.classification === filter);
  };

  const filteredAmex = filterTxns(amexTxns);
  const filteredMercury = filterTxns(mercuryTxns);

  // Totals
  const amexTotal = amexTxns.filter(t => t.classification === "business" || t.classification === "payroll").reduce((s, t) => s + Math.abs(t.amountCents), 0);
  const mercuryTotal = mercuryTxns.filter(t => t.classification === "business" || t.classification === "payroll").reduce((s, t) => s + Math.abs(t.amountCents), 0);
  const amexReview = amexTxns.filter(t => t.status === "needs_review").length;
  const mercuryReview = mercuryTxns.filter(t => t.status === "needs_review").length;

  const classColor = (c: string) => {
    switch (c) {
      case "business": return "success";
      case "personal": return "warning";
      case "payroll": return "warning";
      default: return "danger";
    }
  };

  const renderTransaction = (tx: Transaction) => (
    <div key={tx.id} className="flex items-center justify-between py-2 border-b last:border-0 gap-2">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{tx.merchantName || "Unknown"}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-[var(--muted-foreground)]">{formatDate(tx.date)}</span>
          <Badge variant={classColor(tx.classification) as "success" | "warning" | "danger" | "secondary"}>
            {tx.classification === "needs_review" ? "Review" : tx.classification}
          </Badge>
          {tx.category && <span className="text-xs text-[var(--muted-foreground)]">{tx.category.name}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm text-red-600 whitespace-nowrap">{formatCents(Math.abs(tx.amountCents))}</span>
        {tx.status === "needs_review" && (
          <select
            className="text-xs border rounded px-1 py-0.5 bg-white"
            defaultValue=""
            onChange={(e) => {
              const val = e.target.value;
              if (val === "personal" || val === "payroll" || val === "internal_transfer") {
                categorizeTx(tx.id, val);
              } else if (val) {
                categorizeTx(tx.id, "business", val);
              }
            }}
          >
            <option value="" disabled>Classify</option>
            <optgroup label="Quick">
              <option value="personal">Personal</option>
              <option value="payroll">Payroll</option>
              <option value="internal_transfer">Transfer</option>
            </optgroup>
            <optgroup label="Business">
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
          </select>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Expenses</h2>
          <p className="text-sm text-[var(--muted-foreground)]">{MONTH_NAMES[month - 1]} {year}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="h-8 px-3 text-sm rounded-lg border border-[var(--border)] bg-white hover:bg-gray-50 flex items-center gap-2 cursor-pointer">
            {importing ? "Importing..." : "Import Amex"}
            <input type="file" accept=".csv,.tsv,.txt" multiple onChange={handleAmexUpload} className="hidden" disabled={importing} />
          </label>
          <Button size="sm" variant="outline" onClick={syncMercury} disabled={importing}>
            {importing ? "Syncing..." : "Sync Mercury"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => {
            if (month === 1) { setMonth(12); setYear(year - 1); } else setMonth(month - 1);
          }}>←</Button>
          <span className="text-sm font-medium w-24 text-center">{MONTH_NAMES[month - 1]} {year}</span>
          <Button size="sm" variant="outline" onClick={() => {
            if (month === 12) { setMonth(1); setYear(year + 1); } else setMonth(month + 1);
          }}>→</Button>
        </div>
      </div>

      {/* Import Result */}
      {importResult && (
        <Card className="border-green-200 bg-green-50/30">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-green-800 text-sm">Imported {importResult.synced} transactions ({importResult.skipped} duplicates)</p>
                <div className="flex gap-2 mt-1">{importResult.perFile.map((f, i) => <span key={i} className="text-xs bg-green-100 px-2 py-0.5 rounded">{f.name}: {f.synced} new</span>)}</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => setImportResult(null)}>Dismiss</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Cards */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Total Expenses</p>
              <p className="text-2xl font-bold text-red-600">{formatCents(amexTotal + mercuryTotal)}</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">Business + Payroll</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Amex</p>
              <p className="text-2xl font-bold text-red-600">{formatCents(amexTotal)}</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">{amexTxns.length} transactions</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Mercury</p>
              <p className="text-2xl font-bold text-red-600">{formatCents(mercuryTotal)}</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">{mercuryTxns.length} transactions</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Needs Review</p>
              <p className={`text-2xl font-bold ${amexReview + mercuryReview > 0 ? "text-amber-600" : "text-green-600"}`}>
                {amexReview + mercuryReview}
              </p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                {amexReview > 0 ? `${amexReview} Amex` : ""}{amexReview > 0 && mercuryReview > 0 ? " · " : ""}{mercuryReview > 0 ? `${mercuryReview} Mercury` : ""}
                {amexReview + mercuryReview === 0 ? "All categorized" : ""}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-2">
        {[
          { value: "all", label: "All" },
          { value: "needs_review", label: `Needs Review (${amexReview + mercuryReview})` },
          { value: "business", label: "Business" },
          { value: "payroll", label: "Payroll" },
          { value: "personal", label: "Personal" },
        ].map(f => (
          <Button
            key={f.value}
            size="sm"
            variant={filter === f.value ? "default" : "outline"}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Split View */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Amex Column */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Amex ({filteredAmex.length})</CardTitle>
                <span className="text-sm font-medium text-red-600">
                  {formatCents(filteredAmex.filter(t => t.classification !== "needs_review").reduce((s, t) => s + Math.abs(t.amountCents), 0))}
                </span>
              </div>
            </CardHeader>
            <CardContent className="max-h-[600px] overflow-y-auto">
              {filteredAmex.length > 0 ? (
                filteredAmex.map(renderTransaction)
              ) : (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-4">
                  {filter === "needs_review" ? "All Amex transactions categorized" : "No transactions"}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Mercury Column */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Mercury ({filteredMercury.length})</CardTitle>
                <span className="text-sm font-medium text-red-600">
                  {formatCents(filteredMercury.filter(t => t.classification !== "needs_review").reduce((s, t) => s + Math.abs(t.amountCents), 0))}
                </span>
              </div>
            </CardHeader>
            <CardContent className="max-h-[600px] overflow-y-auto">
              {filteredMercury.length > 0 ? (
                filteredMercury.map(renderTransaction)
              ) : (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-4">
                  {filter === "needs_review" ? "All Mercury transactions categorized" : "No transactions"}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
