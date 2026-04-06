"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
  category: { id: string; name: string; costPurpose?: string } | null;
}

interface Category {
  id: string;
  name: string;
  costPurpose: string;
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
  const [filter, setFilter] = useState<string>("all");

  // Category config
  const [showCategoryConfig, setShowCategoryConfig] = useState(false);

  // Selection state
  const [selectedAmex, setSelectedAmex] = useState<Set<string>>(new Set());
  const [selectedMercury, setSelectedMercury] = useState<Set<string>>(new Set());

  // Bulk action state
  const [bulkTarget, setBulkTarget] = useState<"amex" | "mercury" | null>(null);
  const [showNoteInput, setShowNoteInput] = useState<string | null>(null); // txId or "bulk"
  const [noteText, setNoteText] = useState("");

  // Tinder quick input per column
  const [amexInput, setAmexInput] = useState("");
  const [mercuryInput, setMercuryInput] = useState("");
  const amexInputRef = useRef<HTMLInputElement>(null);
  const mercuryInputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/ceo/transactions?month=${month}&year=${year}&source=amex&limit=500`).then(r => r.json()),
      fetch(`/api/ceo/transactions?month=${month}&year=${year}&source=mercury&limit=500`).then(r => r.json()),
      fetch("/api/ceo/categories").then(r => r.json()),
    ]).then(([amex, mercury, cats]) => {
      setAmexTxns((amex.transactions || []).filter((t: Transaction) => t.amountCents < 0 && t.classification !== "internal_transfer"));
      setMercuryTxns((mercury.transactions || []).filter((t: Transaction) => t.amountCents < 0 && t.classification !== "internal_transfer"));
      setCategories(cats.categories || []);
      setSelectedAmex(new Set());
      setSelectedMercury(new Set());
      setLoading(false);
    });
  }, [month, year]);

  useEffect(() => { loadData(); }, [loadData]);

  // --- Categorization ---
  const categorizeTxns = async (txIds: string[], classification: string, categoryId?: string, notes?: string) => {
    await fetch("/api/ceo/categorize", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionIds: txIds,
        classification,
        categoryId: categoryId || null,
        notes: notes || null,
      }),
    });
    const idSet = new Set(txIds);
    const update = (txns: Transaction[]) =>
      txns.map(t => idSet.has(t.id) ? {
        ...t,
        classification,
        categoryId: categoryId || t.categoryId,
        status: "confirmed",
        notes: notes || t.notes,
        category: categoryId ? categories.find(c => c.id === categoryId) ? { id: categoryId, name: categories.find(c => c.id === categoryId)!.name } : t.category : classification !== "business" ? null : t.category,
      } : t);
    setAmexTxns(update);
    setMercuryTxns(update);
  };

  const handleSingleCategorize = async (txId: string, value: string) => {
    if (value === "personal" || value === "payroll" || value === "internal_transfer") {
      await categorizeTxns([txId], value);
    } else if (value === "__note__") {
      setShowNoteInput(txId);
      setNoteText("");
    } else if (value) {
      await categorizeTxns([txId], "business", value);
    }
  };

  const handleBulkCategorize = async (value: string) => {
    const ids = bulkTarget === "amex" ? [...selectedAmex] : [...selectedMercury];
    if (ids.length === 0) return;

    if (value === "personal" || value === "payroll" || value === "internal_transfer") {
      await categorizeTxns(ids, value);
    } else if (value === "__note__") {
      setShowNoteInput("bulk");
      setNoteText("");
      return;
    } else if (value) {
      await categorizeTxns(ids, "business", value);
    }
    if (bulkTarget === "amex") setSelectedAmex(new Set());
    else setSelectedMercury(new Set());
    setBulkTarget(null);
  };

  const submitNote = async (txIdOrBulk: string) => {
    if (!noteText.trim()) { setShowNoteInput(null); return; }

    if (txIdOrBulk === "bulk") {
      const ids = bulkTarget === "amex" ? [...selectedAmex] : [...selectedMercury];
      // Save note without changing classification
      for (const id of ids) {
        await fetch("/api/ceo/categorize", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId: id, notes: noteText.trim() }),
        });
      }
      const idSet = new Set(ids);
      const update = (txns: Transaction[]) => txns.map(t => idSet.has(t.id) ? { ...t, notes: noteText.trim() } : t);
      setAmexTxns(update);
      setMercuryTxns(update);
      if (bulkTarget === "amex") setSelectedAmex(new Set());
      else setSelectedMercury(new Set());
      setBulkTarget(null);
    } else {
      await fetch("/api/ceo/categorize", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: txIdOrBulk, notes: noteText.trim() }),
      });
      const update = (txns: Transaction[]) => txns.map(t => t.id === txIdOrBulk ? { ...t, notes: noteText.trim() } : t);
      setAmexTxns(update);
      setMercuryTxns(update);
    }
    setShowNoteInput(null);
    setNoteText("");
  };

  // --- Quick input parsing (from Tinder page) ---
  const parseInput = (input: string): { classification: string; categoryId?: string; note?: string } | null => {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/[,.\-—]+/).map(s => s.trim());
    const command = parts[0].toLowerCase();
    const note = parts.slice(1).join(", ").trim() || undefined;

    if (["personal", "p"].includes(command)) return { classification: "personal", note };
    if (["payroll", "pay"].includes(command)) return { classification: "payroll", note };
    if (["transfer", "internal", "t"].includes(command)) return { classification: "internal_transfer", note };
    if (["business", "biz", "b"].includes(command)) return { classification: "business", note };

    const categoryMap: Array<{ keywords: string[]; search: string }> = [
      { keywords: ["email", "inbox"], search: "email" },
      { keywords: ["software", "soft", "sw"], search: "software" },
      { keywords: ["data"], search: "data" },
      { keywords: ["fees", "fee"], search: "fees" },
      { keywords: ["marketing", "mktg"], search: "marketing" },
      { keywords: ["comm", "communication", "comms"], search: "communication" },
      { keywords: ["verify", "verification"], search: "verification" },
      { keywords: ["auto", "automation"], search: "automation" },
      { keywords: ["accounting", "acct"], search: "accounting" },
      { keywords: ["crm"], search: "crm" },
      { keywords: ["education", "edu"], search: "education" },
    ];

    for (const { keywords, search } of categoryMap) {
      if (keywords.some(k => command.includes(k))) {
        const cat = categories.find(c => c.name.toLowerCase().includes(search));
        return { classification: "business", categoryId: cat?.id, note };
      }
    }

    for (const cat of categories) {
      const catLower = cat.name.toLowerCase();
      if (command === catLower || catLower.includes(command) || command.includes(catLower.split(" ")[0])) {
        return { classification: "business", categoryId: cat.id, note };
      }
    }

    const lower = trimmed.toLowerCase();
    if (["restaurant", "food", "cafe", "coffee", "uber", "taxi", "gym", "barber", "grocery", "pharmacy"].some(w => lower.includes(w))) {
      return { classification: "personal", note: trimmed };
    }
    if (["salary", "contractor", "employee", "payroll"].some(w => lower.includes(w))) {
      return { classification: "payroll", note: trimmed };
    }
    if (["legal", "incorporation", "filing", "corp", "llc"].some(w => lower.includes(w))) {
      return { classification: "business", note: trimmed };
    }

    return null;
  };

  const handleQuickInput = async (source: "amex" | "mercury") => {
    const input = source === "amex" ? amexInput : mercuryInput;
    const selected = source === "amex" ? selectedAmex : selectedMercury;
    if (!input.trim() || selected.size === 0) return;

    const parsed = parseInput(input);
    if (!parsed) return;

    await categorizeTxns([...selected], parsed.classification, parsed.categoryId, parsed.note);
    if (source === "amex") { setSelectedAmex(new Set()); setAmexInput(""); }
    else { setSelectedMercury(new Set()); setMercuryInput(""); }
  };

  // --- Selection helpers ---
  const toggleSelect = (id: string, source: "amex" | "mercury") => {
    const [selected, setSelected] = source === "amex" ? [selectedAmex, setSelectedAmex] : [selectedMercury, setSelectedMercury];
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const selectAll = (source: "amex" | "mercury") => {
    const txns = source === "amex" ? filteredAmex : filteredMercury;
    const [selected, setSelected] = source === "amex" ? [selectedAmex, setSelectedAmex] : [selectedMercury, setSelectedMercury];
    if (selected.size === txns.length) setSelected(new Set());
    else setSelected(new Set(txns.map(t => t.id)));
  };

  // --- Import handlers ---
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

  // --- Filtering ---
  const filterTxns = (txns: Transaction[]) => {
    if (filter === "all") return txns;
    if (filter === "needs_review") return txns.filter(t => t.status === "needs_review");
    return txns.filter(t => t.classification === filter);
  };

  const filteredAmex = filterTxns(amexTxns);
  const filteredMercury = filterTxns(mercuryTxns);

  // --- Totals ---
  const amexTotal = amexTxns.filter(t => t.classification === "business" || t.classification === "payroll").reduce((s, t) => s + Math.abs(t.amountCents), 0);
  const mercuryTotal = mercuryTxns.filter(t => t.classification === "business" || t.classification === "payroll").reduce((s, t) => s + Math.abs(t.amountCents), 0);
  const amexReview = amexTxns.filter(t => t.status === "needs_review").length;
  const mercuryReview = mercuryTxns.filter(t => t.status === "needs_review").length;

  const totalSelected = selectedAmex.size + selectedMercury.size;

  const classColor = (c: string): "success" | "warning" | "danger" | "secondary" => {
    switch (c) {
      case "business": return "success";
      case "personal": return "warning";
      case "payroll": return "warning";
      default: return "danger";
    }
  };

  // --- Cost purpose helpers ---
  const updateCostPurpose = async (categoryId: string, costPurpose: string) => {
    await fetch("/api/ceo/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId, costPurpose }),
    });
    setCategories(prev => prev.map(c => c.id === categoryId ? { ...c, costPurpose } : c));
  };

  const purposeColor = (p: string) => {
    switch (p) {
      case "cogs": return "bg-red-100 text-red-700 border-red-200";
      case "cac": return "bg-blue-100 text-blue-700 border-blue-200";
      default: return "bg-gray-100 text-gray-600 border-gray-200";
    }
  };

  const purposeLabel = (p: string) => {
    switch (p) {
      case "cogs": return "COGS";
      case "cac": return "CAC";
      default: return "Overhead";
    }
  };

  // --- COGS / CAC / Overhead totals ---
  const allTxns = [...amexTxns, ...mercuryTxns];
  const cogsCategoryIds = new Set(categories.filter(c => c.costPurpose === "cogs").map(c => c.id));
  const cacCategoryIds = new Set(categories.filter(c => c.costPurpose === "cac").map(c => c.id));
  const cogsTotal = allTxns.filter(t => t.categoryId && cogsCategoryIds.has(t.categoryId)).reduce((s, t) => s + Math.abs(t.amountCents), 0);
  const cacTotal = allTxns.filter(t => t.categoryId && cacCategoryIds.has(t.categoryId)).reduce((s, t) => s + Math.abs(t.amountCents), 0);
  const payrollTotal = allTxns.filter(t => t.classification === "payroll").reduce((s, t) => s + Math.abs(t.amountCents), 0);

  // --- Categorization dropdown (works on every transaction) ---
  const renderDropdown = (txId: string, currentClassification: string) => (
    <select
      className="text-xs border rounded px-1 py-0.5 bg-white min-w-[80px]"
      value=""
      onChange={(e) => handleSingleCategorize(txId, e.target.value)}
    >
      <option value="" disabled>{currentClassification === "needs_review" ? "Classify" : "Re-classify"}</option>
      <optgroup label="Quick">
        <option value="personal">Personal</option>
        <option value="payroll">Payroll</option>
        <option value="internal_transfer">Transfer</option>
      </optgroup>
      <optgroup label="Business">
        {categories.map(c => <option key={c.id} value={c.id}>{c.name} [{purposeLabel(c.costPurpose)}]</option>)}
      </optgroup>
      <optgroup label="Other">
        <option value="__note__">Add Note...</option>
      </optgroup>
    </select>
  );

  const renderTransaction = (tx: Transaction, source: "amex" | "mercury") => {
    const selected = source === "amex" ? selectedAmex : selectedMercury;
    const isSelected = selected.has(tx.id);

    return (
      <div key={tx.id} className={`flex items-center gap-2 py-2 border-b last:border-0 ${isSelected ? "bg-blue-50" : ""}`}>
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => toggleSelect(tx.id, source)}
          className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{tx.merchantName || "Unknown"}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-[var(--muted-foreground)]">{formatDate(tx.date)}</span>
            <Badge variant={classColor(tx.classification)}>
              {tx.classification === "needs_review" ? "Review" : tx.classification}
            </Badge>
            {tx.category && (
              <span className="flex items-center gap-1">
                <span className="text-xs text-[var(--muted-foreground)]">{tx.category.name}</span>
                {tx.category.costPurpose && (
                  <span className={`text-[10px] px-1 py-0 rounded border font-medium ${purposeColor(tx.category.costPurpose)}`}>
                    {purposeLabel(tx.category.costPurpose)}
                  </span>
                )}
              </span>
            )}
            {tx.notes && <span className="text-xs text-blue-600 italic truncate max-w-[120px]" title={tx.notes}>{tx.notes}</span>}
          </div>
        </div>

        {/* Amount + dropdown */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="font-medium text-sm text-red-600 whitespace-nowrap">{formatCents(Math.abs(tx.amountCents))}</span>
          {renderDropdown(tx.id, tx.classification)}
        </div>

        {/* Note input inline */}
        {showNoteInput === tx.id && (
          <div className="absolute right-0 top-full mt-1 z-10 bg-white border rounded-lg shadow-lg p-2 flex gap-1">
            <input
              type="text"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitNote(tx.id); if (e.key === "Escape") setShowNoteInput(null); }}
              placeholder="Add a note..."
              className="text-xs border rounded px-2 py-1 w-48"
              autoFocus
            />
            <button onClick={() => submitNote(tx.id)} className="text-xs bg-blue-600 text-white px-2 py-1 rounded">Save</button>
          </div>
        )}
      </div>
    );
  };

  const renderColumn = (source: "amex" | "mercury", txns: Transaction[], selected: Set<string>) => {
    const label = source === "amex" ? "Amex" : "Mercury";
    const input = source === "amex" ? amexInput : mercuryInput;
    const setInput = source === "amex" ? setAmexInput : setMercuryInput;
    const inputRef = source === "amex" ? amexInputRef : mercuryInputRef;
    const allSelected = txns.length > 0 && selected.size === txns.length;
    const someSelected = selected.size > 0;
    const reviewCount = source === "amex" ? amexReview : mercuryReview;

    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base">{label} ({txns.length})</CardTitle>
              {reviewCount > 0 && (
                <Badge variant="danger">{reviewCount} to review</Badge>
              )}
            </div>
            <span className="text-sm font-medium text-red-600">
              {formatCents(txns.filter(t => t.classification !== "needs_review").reduce((s, t) => s + Math.abs(t.amountCents), 0))}
            </span>
          </div>

          {/* Select All + Quick Input */}
          <div className="flex items-center gap-2 mt-2">
            <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                onChange={() => selectAll(source)}
                className="w-3.5 h-3.5 rounded"
              />
              {allSelected ? "Deselect all" : "Select all"}
            </label>

            {someSelected && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleQuickInput(source); }}
                className="flex-1 flex gap-1"
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={`Classify ${selected.size} selected: personal, software, fees...`}
                  className="flex-1 text-xs border rounded px-2 py-1 focus:outline-none focus:border-blue-400"
                />
                <button type="submit" className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700">Go</button>
              </form>
            )}
          </div>

          {/* Bulk action bar */}
          {someSelected && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-xs font-medium text-blue-700">{selected.size} selected:</span>
              <button onClick={() => { setBulkTarget(source); handleBulkCategorize("personal"); }} className="px-2 py-1 text-xs rounded bg-purple-100 text-purple-700 hover:bg-purple-200">Personal</button>
              <button onClick={() => { setBulkTarget(source); handleBulkCategorize("payroll"); }} className="px-2 py-1 text-xs rounded bg-orange-100 text-orange-700 hover:bg-orange-200">Payroll</button>
              <button onClick={() => { setBulkTarget(source); handleBulkCategorize("internal_transfer"); }} className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-700 hover:bg-gray-200">Transfer</button>
              <select
                className="px-2 py-1 text-xs rounded bg-blue-100 text-blue-700 border-0 cursor-pointer"
                value=""
                onChange={(e) => { if (e.target.value) { setBulkTarget(source); handleBulkCategorize(e.target.value); } }}
              >
                <option value="" disabled>Business...</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button onClick={() => { setBulkTarget(source); setShowNoteInput("bulk"); setNoteText(""); }} className="px-2 py-1 text-xs rounded bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200">Add Note</button>
            </div>
          )}

          {/* Bulk note input */}
          {showNoteInput === "bulk" && bulkTarget === source && (
            <div className="flex gap-1 mt-2">
              <input
                type="text"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitNote("bulk"); if (e.key === "Escape") setShowNoteInput(null); }}
                placeholder="Note for selected transactions..."
                className="flex-1 text-xs border rounded px-2 py-1"
                autoFocus
              />
              <button onClick={() => submitNote("bulk")} className="text-xs bg-blue-600 text-white px-2 py-1 rounded">Save</button>
              <button onClick={() => setShowNoteInput(null)} className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">Cancel</button>
            </div>
          )}
        </CardHeader>

        <CardContent className="max-h-[600px] overflow-y-auto">
          {txns.length > 0 ? (
            txns.map(tx => renderTransaction(tx, source))
          ) : (
            <p className="text-sm text-[var(--muted-foreground)] text-center py-4">
              {filter === "needs_review" ? `All ${label} transactions categorized` : "No transactions"}
            </p>
          )}
        </CardContent>
      </Card>
    );
  };

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
          }}>&#8592;</Button>
          <span className="text-sm font-medium w-24 text-center">{MONTH_NAMES[month - 1]} {year}</span>
          <Button size="sm" variant="outline" onClick={() => {
            if (month === 12) { setMonth(1); setYear(year + 1); } else setMonth(month + 1);
          }}>&#8594;</Button>
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
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-[var(--muted-foreground)]">Total Expenses</p>
                <p className="text-2xl font-bold text-red-600">{formatCents(amexTotal + mercuryTotal)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">Amex {formatCents(amexTotal)} · Mercury {formatCents(mercuryTotal)}</p>
              </CardContent>
            </Card>
            <Card className="border-red-200">
              <CardContent className="pt-6">
                <p className="text-sm text-red-700 font-medium">COGS</p>
                <p className="text-2xl font-bold text-red-600">{formatCents(cogsTotal)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">Cost of delivery</p>
              </CardContent>
            </Card>
            <Card className="border-blue-200">
              <CardContent className="pt-6">
                <p className="text-sm text-blue-700 font-medium">CAC Spend</p>
                <p className="text-2xl font-bold text-blue-600">{formatCents(cacTotal + payrollTotal)}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">Tools {formatCents(cacTotal)} · Payroll {formatCents(payrollTotal)}</p>
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
        </>
      )}

      {/* Filter + Config Toggle */}
      <div className="flex items-center justify-between">
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
        <Button size="sm" variant="outline" onClick={() => setShowCategoryConfig(!showCategoryConfig)}>
          {showCategoryConfig ? "Hide" : "Configure"} Cost Types
        </Button>
      </div>

      {/* Category Cost Purpose Config */}
      {showCategoryConfig && (
        <Card className="border-amber-200 bg-amber-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Category Cost Classification</CardTitle>
            <p className="text-xs text-[var(--muted-foreground)]">
              Tag each category as <span className="font-medium text-red-700">COGS</span> (cost to deliver service),{" "}
              <span className="font-medium text-blue-700">CAC</span> (cost to acquire customers), or{" "}
              <span className="font-medium text-gray-600">Overhead</span> (general business). This drives your unit economics.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {categories.map(cat => (
                <div key={cat.id} className="flex items-center justify-between py-1.5 px-2 rounded bg-white border">
                  <span className="text-sm font-medium">{cat.name}</span>
                  <div className="flex gap-1">
                    {(["cogs", "cac", "overhead"] as const).map(purpose => (
                      <button
                        key={purpose}
                        onClick={() => updateCostPurpose(cat.id, purpose)}
                        className={`text-xs px-2 py-0.5 rounded border font-medium transition-all ${
                          cat.costPurpose === purpose
                            ? purposeColor(purpose)
                            : "bg-white text-gray-400 border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        {purposeLabel(purpose)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-[var(--muted-foreground)] mt-3">
              Payroll is automatically counted as CAC (setter/closer pay = acquisition cost).
            </p>
          </CardContent>
        </Card>
      )}

      {/* Keyboard shortcuts hint */}
      {totalSelected > 0 && (
        <p className="text-xs text-[var(--muted-foreground)]">
          Quick classify: type <code className="bg-gray-100 px-1 rounded">personal</code>, <code className="bg-gray-100 px-1 rounded">payroll</code>, <code className="bg-gray-100 px-1 rounded">software</code>, <code className="bg-gray-100 px-1 rounded">fees</code>, <code className="bg-gray-100 px-1 rounded">marketing</code>, etc. in the input above the column, or add a note with <code className="bg-gray-100 px-1 rounded">software, for zapier</code>
        </p>
      )}

      {/* Split View */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {renderColumn("amex", filteredAmex, selectedAmex)}
          {renderColumn("mercury", filteredMercury, selectedMercury)}
        </div>
      )}
    </div>
  );
}
