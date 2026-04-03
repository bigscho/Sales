"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, formatDate } from "@/lib/utils";

interface ExpenseRecord {
  id: string;
  category: string;
  vendor: string | null;
  description: string | null;
  amountCents: number;
  date: string;
  source: string;
}

interface PaymentRecord {
  id: string;
  amountCents: number;
  paidAt: string;
  customerName: string | null;
  customerEmail: string | null;
  status: string;
}

export default function PnLPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showRevenue, setShowRevenue] = useState(false);
  const [showExpenses, setShowExpenses] = useState(false);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/expenses?weekId=${weekId}`).then((r) => r.json()),
      fetch(`/api/deals?weekId=${weekId}`).then((r) => r.json()),
    ]).then(([expData, dealData]) => {
      setExpenses(expData.expenses || []);
      setCategories(expData.categories || []);
      // Collect all payments from deals + unlinked payments
      const allPayments: PaymentRecord[] = [];
      for (const deal of dealData.deals || []) {
        for (const p of deal.payments || []) {
          allPayments.push({ ...p, customerName: deal.prospectName, customerEmail: deal.prospectEmail });
        }
      }
      // Include unlinked Stripe payments as revenue too
      for (const p of dealData.unlinkedPayments || []) {
        allPayments.push({ id: p.id, amountCents: p.amountCents, paidAt: p.paidAt, customerName: p.customerName, customerEmail: p.customerEmail, status: "succeeded" });
      }
      setPayments(allPayments);
      setLoading(false);
    });
  }, [weekId]);

  useEffect(() => { loadData(); }, [loadData]);

  const addExpense = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await fetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        weekId,
        category: form.get("category"),
        vendor: form.get("vendor") || null,
        description: form.get("description") || null,
        amountCents: Math.round(Number(form.get("amount")) * 100),
        date: form.get("date"),
      }),
    });
    setShowAddForm(false);
    loadData();
  };

  const deleteExpense = async (id: string) => {
    await fetch("/api/expenses", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    loadData();
  };

  const handleCSVUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.split("\n").slice(1); // skip header
    for (const line of lines) {
      const parts = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      if (parts.length < 3) continue;
      const [category, vendor, description, amount, date] = parts;
      await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekId,
          category: category || "Other",
          vendor: vendor || null,
          description: description || null,
          amountCents: Math.round(Number(amount) * 100),
          date: date || new Date().toISOString(),
          source: "csv_import",
        }),
      });
    }
    loadData();
  };

  if (!weekId) return <p className="text-[var(--muted-foreground)]">Select a week first</p>;

  const totalRevenue = payments.reduce((s, p) => s + p.amountCents, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amountCents, 0);
  const netProfit = totalRevenue - totalExpenses;
  const margin = totalRevenue > 0 ? netProfit / totalRevenue : 0;

  // Group expenses by category
  const byCategory = new Map<string, ExpenseRecord[]>();
  for (const exp of expenses) {
    if (!byCategory.has(exp.category)) byCategory.set(exp.category, []);
    byCategory.get(exp.category)!.push(exp);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Profit & Loss</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
            + Add Expense
          </Button>
          <label className="h-8 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--muted)] flex items-center gap-2 cursor-pointer">
            Import CSV
            <input type="file" accept=".csv" onChange={handleCSVUpload} className="hidden" />
          </label>
        </div>
      </div>

      {showAddForm && (
        <Card>
          <CardHeader><CardTitle>Add Expense</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addExpense} className="grid grid-cols-2 md:grid-cols-6 gap-3">
              <select name="category" required className="border rounded-lg px-3 py-2 text-sm">
                <option value="">Category</option>
                {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                <option value="Setter Payroll">Setter Payroll</option>
                <option value="Closer Payroll">Closer Payroll</option>
                <option value="Ad Spend">Ad Spend</option>
                <option value="Software">Software</option>
                <option value="Contractors">Contractors</option>
                <option value="Other">Other</option>
              </select>
              <input name="vendor" placeholder="Vendor" className="border rounded-lg px-3 py-2 text-sm" />
              <input name="description" placeholder="Description" className="border rounded-lg px-3 py-2 text-sm" />
              <input name="amount" type="number" step="0.01" placeholder="Amount ($)" required className="border rounded-lg px-3 py-2 text-sm" />
              <input name="date" type="date" required className="border rounded-lg px-3 py-2 text-sm" />
              <Button type="submit" size="sm">Add</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* P&L Summary */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="cursor-pointer hover:shadow-md" onClick={() => setShowRevenue(!showRevenue)}>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Revenue</p>
              <p className="text-2xl font-bold text-green-600">{formatCents(totalRevenue)}</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">{payments.length} payments - click to expand</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-md" onClick={() => setShowExpenses(!showExpenses)}>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Expenses</p>
              <p className="text-2xl font-bold text-red-600">{formatCents(totalExpenses)}</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">{expenses.length} line items - click to expand</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Net Profit</p>
              <p className={`text-2xl font-bold ${netProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                {formatCents(netProfit)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-[var(--muted-foreground)]">Margin</p>
              <p className={`text-2xl font-bold ${margin >= 0 ? "text-green-600" : "text-red-600"}`}>
                {(margin * 100).toFixed(1)}%
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Revenue drill-down */}
      {showRevenue && (
        <Card>
          <CardHeader><CardTitle>Revenue Breakdown (Stripe Payments)</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr>
                  <th className="text-left p-2 font-medium">Customer</th>
                  <th className="text-left p-2 font-medium">Date</th>
                  <th className="text-right p-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="p-2">{p.customerName || p.customerEmail || "Unknown"}</td>
                    <td className="p-2">{formatDate(p.paidAt)}</td>
                    <td className="p-2 text-right font-medium">{formatCents(p.amountCents)}</td>
                  </tr>
                ))}
                {payments.length === 0 && (
                  <tr><td colSpan={3} className="p-4 text-center text-[var(--muted-foreground)]">No payments this week</td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Expense drill-down by category */}
      {showExpenses && (
        <div className="space-y-4">
          {Array.from(byCategory.entries()).map(([cat, items]) => (
            <Card key={cat}>
              <CardHeader className="pb-2">
                <div className="flex justify-between items-center">
                  <CardTitle className="text-base">{cat}</CardTitle>
                  <span className="font-bold">{formatCents(items.reduce((s, e) => s + e.amountCents, 0))}</span>
                </div>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <tbody>
                    {items.map((exp) => (
                      <tr key={exp.id} className="border-b last:border-0">
                        <td className="py-2">{exp.vendor || "—"}</td>
                        <td className="py-2">{exp.description || "—"}</td>
                        <td className="py-2">{formatDate(exp.date)}</td>
                        <td className="py-2 text-right font-medium">{formatCents(exp.amountCents)}</td>
                        <td className="py-2 text-right">
                          <button onClick={() => deleteExpense(exp.id)} className="text-red-500 text-xs hover:underline">
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* All expenses table */}
      {!showExpenses && !loading && expenses.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Expense Line Items</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr>
                  <th className="text-left p-2 font-medium">Category</th>
                  <th className="text-left p-2 font-medium">Vendor</th>
                  <th className="text-left p-2 font-medium">Description</th>
                  <th className="text-left p-2 font-medium">Date</th>
                  <th className="text-right p-2 font-medium">Amount</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((exp) => (
                  <tr key={exp.id} className="border-b last:border-0">
                    <td className="p-2">{exp.category}</td>
                    <td className="p-2">{exp.vendor || "—"}</td>
                    <td className="p-2">{exp.description || "—"}</td>
                    <td className="p-2">{formatDate(exp.date)}</td>
                    <td className="p-2 text-right font-medium">{formatCents(exp.amountCents)}</td>
                    <td className="p-2 text-right">
                      <button onClick={() => deleteExpense(exp.id)} className="text-red-500 text-xs hover:underline">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
