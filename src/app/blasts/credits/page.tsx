"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreditBadge } from "@/components/credit-badge";

interface CreditTx {
  id: string;
  amount: number;
  balance: number;
  type: string;
  description: string;
  createdAt: string;
}

export default function CreditHistoryPage() {
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState<CreditTx[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/credits?page=${page}&limit=30`)
      .then(r => r.json())
      .then(data => {
        setBalance(data.balance || 0);
        setTransactions(data.transactions || []);
        setTotal(data.totalTransactions || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [page]);

  const totalPages = Math.ceil(total / 30);

  const typeLabel = (type: string) => {
    const labels: Record<string, string> = {
      weekly_award: "Weekly Award",
      verification_bonus: "Verification",
      pigeon_bonus: "Pigeon Tier",
      blast_spend: "Text Blast",
      admin_adjust: "Admin",
      refund: "Refund",
    };
    return labels[type] || type;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Credit History</h2>
        <CreditBadge balance={balance} size="md" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-10 bg-[var(--muted)] rounded animate-pulse" />
              ))}
            </div>
          ) : transactions.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No credit transactions yet.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--muted)] border-b">
                    <tr>
                      <th className="text-left p-3 font-medium">Date</th>
                      <th className="text-left p-3 font-medium">Type</th>
                      <th className="text-left p-3 font-medium">Description</th>
                      <th className="text-right p-3 font-medium">Amount</th>
                      <th className="text-right p-3 font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => (
                      <tr key={tx.id} className="border-b last:border-0">
                        <td className="p-3 text-[var(--muted-foreground)] whitespace-nowrap">
                          {new Date(tx.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                        <td className="p-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            tx.amount > 0
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}>
                            {typeLabel(tx.type)}
                          </span>
                        </td>
                        <td className="p-3 text-[var(--muted-foreground)]">{tx.description}</td>
                        <td className={`p-3 text-right font-medium ${tx.amount > 0 ? "text-green-600" : "text-red-600"}`}>
                          {tx.amount > 0 ? "+" : ""}{tx.amount.toLocaleString()}
                        </td>
                        <td className="p-3 text-right text-[var(--muted-foreground)]">{tx.balance.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="text-sm text-[var(--teal)] hover:underline disabled:opacity-50"
                  >
                    ← Previous
                  </button>
                  <span className="text-xs text-[var(--muted-foreground)]">Page {page} of {totalPages}</span>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="text-sm text-[var(--teal)] hover:underline disabled:opacity-50"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
