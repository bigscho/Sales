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
    const groups: Record<string, { merchant: string; total: number; count: number; txIds: string[]; dates: string[] }> = {};
    for (const tx of transactions) {
      const key = tx.merchantName || "Unknown";
      if (!groups[key]) groups[key] = { merchant: key, total: 0, count: 0, txIds: [], dates: [] };
      groups[key].total += Math.abs(tx.amountCents);
      groups[key].count++;
      groups[key].txIds.push(tx.id);
      groups[key].dates.push(tx.date);
    }
    return Object.values(groups).sort((a, b) => b.total - a.total);
  })() : [];

  const [currentIndex, setCurrentIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [mode, setMode] = useState<"tinder" | "list">("tinder");

  const currentMerchant = merchantGroups[currentIndex] || null;
  const totalMerchants = merchantGroups.length;

  // Parse voice/text input into classification
  const parseInput = (input: string): { classification: string; categoryId?: string } | null => {
    const lower = input.toLowerCase().trim();

    if (["personal", "p"].includes(lower)) return { classification: "personal" };
    if (["payroll", "pay"].includes(lower)) return { classification: "payroll" };
    if (["transfer", "internal", "t"].includes(lower)) return { classification: "internal_transfer" };
    if (["skip", "s", "next", "n"].includes(lower)) return null;

    // Business categories — match partial names
    for (const cat of categories) {
      const catLower = cat.name.toLowerCase();
      if (lower === catLower || catLower.includes(lower) || lower.includes(catLower.split(" ")[0])) {
        return { classification: "business", categoryId: cat.id };
      }
    }

    // Common shortcuts
    if (["email", "inbox", "inboxes"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("email"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["software", "soft", "sw"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("software"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["data"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase() === "data");
      return { classification: "business", categoryId: cat?.id };
    }
    if (["fees", "fee"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("fees"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["marketing", "mktg"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("marketing"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["comm", "communication", "comms"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("communication"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["verify", "verification"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("verification"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["auto", "automation"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("automation"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["accounting", "acct"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("accounting"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["crm"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("crm"));
      return { classification: "business", categoryId: cat?.id };
    }
    if (["education", "edu"].includes(lower)) {
      const cat = categories.find(c => c.name.toLowerCase().includes("education"));
      return { classification: "business", categoryId: cat?.id };
    }
    // Business with no specific category
    if (["business", "biz", "b"].includes(lower)) {
      return { classification: "business" };
    }

    return null;
  };

  const handleSubmit = async () => {
    if (!currentMerchant || !inputValue.trim()) return;

    const parsed = parseInput(inputValue);
    if (!parsed) {
      // Skip — move to next
      setCurrentIndex(prev => prev + 1);
      setInputValue("");
      return;
    }

    await categorizeBulk(currentMerchant.merchant, parsed.classification, parsed.categoryId);
    setInputValue("");
    // Don't increment index since the array shrinks when we remove items
  };

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

      {/* Review Mode */}
      {isReviewMode && merchantGroups.length > 0 && (
        <>
          {/* Mode toggle */}
          <div className="flex gap-2">
            <Button size="sm" variant={mode === "tinder" ? "default" : "outline"} onClick={() => setMode("tinder")}>
              Card View
            </Button>
            <Button size="sm" variant={mode === "list" ? "default" : "outline"} onClick={() => setMode("list")}>
              List View
            </Button>
          </div>

          {/* Tinder-style card view */}
          {mode === "tinder" && currentMerchant && (
            <Card className="border-amber-200 max-w-2xl mx-auto">
              <CardContent className="pt-8 pb-6 px-8">
                {/* Progress */}
                <div className="flex items-center justify-between mb-6">
                  <p className="text-sm text-[var(--muted-foreground)]">
                    {currentIndex + 1} of {totalMerchants} merchants
                  </p>
                  <div className="w-48 bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-amber-500 h-2 rounded-full transition-all"
                      style={{ width: `${((totalMerchants - merchantGroups.length) / Math.max(totalMerchants, 1)) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Merchant card */}
                <div className="text-center mb-6">
                  <p className="text-2xl font-bold mb-2">{currentMerchant.merchant}</p>
                  <p className="text-3xl font-bold text-red-600">{formatCents(currentMerchant.total)}</p>
                  <p className="text-sm text-[var(--muted-foreground)] mt-2">
                    {currentMerchant.count} transaction{currentMerchant.count !== 1 ? "s" : ""}
                    {currentMerchant.count <= 5 && (
                      <span> · {currentMerchant.dates.map(d => formatDate(d)).join(", ")}</span>
                    )}
                  </p>
                </div>

                {/* Input */}
                <form
                  onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
                  className="mb-4"
                >
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="Type: personal, payroll, software, data, fees, skip..."
                    className="w-full border-2 border-amber-300 rounded-xl px-4 py-3 text-lg text-center focus:outline-none focus:border-amber-500"
                    autoFocus
                  />
                </form>

                {/* Quick buttons as backup */}
                <div className="flex gap-2 justify-center flex-wrap">
                  <button
                    onClick={() => { categorizeBulk(currentMerchant.merchant, "personal"); }}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200"
                  >
                    Personal
                  </button>
                  <button
                    onClick={() => { categorizeBulk(currentMerchant.merchant, "payroll"); }}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-orange-100 text-orange-700 hover:bg-orange-200"
                  >
                    Payroll
                  </button>
                  <button
                    onClick={() => { categorizeBulk(currentMerchant.merchant, "internal_transfer"); }}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
                  >
                    Transfer
                  </button>
                  {categories.slice(0, 6).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => { categorizeBulk(currentMerchant.merchant, "business", c.id); }}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-100 text-blue-700 hover:bg-blue-200"
                    >
                      {c.name}
                    </button>
                  ))}
                  <button
                    onClick={() => setCurrentIndex(prev => prev + 1)}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-white border text-gray-500 hover:bg-gray-50"
                  >
                    Skip
                  </button>
                </div>

                {/* Shortcuts hint */}
                <p className="text-xs text-center text-[var(--muted-foreground)] mt-4">
                  Shortcuts: personal · payroll · software · data · email · fees · verification · communication · skip
                </p>
              </CardContent>
            </Card>
          )}

          {/* List view */}
          {mode === "list" && (
            <div className="space-y-2">
              {merchantGroups.map((group) => (
                <Card key={group.merchant} className="border-amber-100">
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1">
                        <p className="font-medium">{group.merchant}</p>
                        <p className="text-xs text-[var(--muted-foreground)]">
                          {formatCents(group.total)} · {group.count}x
                        </p>
                      </div>
                      <div className="flex gap-1.5 flex-wrap">
                        <button onClick={() => categorizeBulk(group.merchant, "personal")} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-100 text-purple-700 hover:bg-purple-200">Personal</button>
                        <button onClick={() => categorizeBulk(group.merchant, "payroll")} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-orange-100 text-orange-700 hover:bg-orange-200">Payroll</button>
                        <button onClick={() => categorizeBulk(group.merchant, "internal_transfer")} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">Transfer</button>
                        <select className="px-2 py-1.5 text-xs font-medium rounded-lg bg-blue-100 text-blue-700 border-0 cursor-pointer" defaultValue="" onChange={(e) => { if (e.target.value) categorizeBulk(group.merchant, "business", e.target.value); }}>
                          <option value="" disabled>Business ▾</option>
                          {categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                        </select>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
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
