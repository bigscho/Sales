"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

interface PayrollLineItem {
  id: string;
  lineType: string;
  description: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
  teamMember: { id: string; name: string; role: string; tier: number };
}

interface PayrollRun {
  id: string;
  weekId: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  lineItems: PayrollLineItem[];
}

export default function PayrollPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [payrollRun, setPayrollRun] = useState<PayrollRun | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    fetch(`/api/payroll?weekId=${weekId}`)
      .then((r) => r.json())
      .then((data) => {
        setPayrollRun(data.payrollRun);
        setLoading(false);
      });
  }, [weekId]);

  useEffect(() => { loadData(); }, [loadData]);

  const generatePayroll = async () => {
    setLoading(true);
    await fetch("/api/payroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekId, action: "generate" }),
    });
    loadData();
  };

  const confirmPayroll = async () => {
    if (!payrollRun) return;
    await fetch("/api/payroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payrollRunId: payrollRun.id, action: "confirm" }),
    });
    loadData();
  };

  const markPaid = async () => {
    if (!payrollRun) return;
    await fetch("/api/payroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payrollRunId: payrollRun.id, action: "mark_paid" }),
    });
    loadData();
  };

  const exportCSV = () => {
    if (!payrollRun) return;
    const grouped = groupByMember(payrollRun.lineItems);
    const rows = [["Name", "Role", "Tier", "Line Type", "Description", "Amount"]];
    Array.from(grouped.values()).forEach((items) => {
      items.forEach((item) => {
        rows.push([
          item.teamMember.name,
          item.teamMember.role,
          String(item.teamMember.tier),
          item.lineType,
          item.description,
          (item.amountCents / 100).toFixed(2),
        ]);
      });
    });
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${weekId}.csv`;
    a.click();
  };

  if (!weekId) return <p className="text-[var(--muted-foreground)]">Select a week first</p>;

  function groupByMember(items: PayrollLineItem[]): Map<string, PayrollLineItem[]> {
    const map = new Map<string, PayrollLineItem[]>();
    for (const item of items) {
      const key = item.teamMember.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }

  const grandTotal = payrollRun?.lineItems.reduce((s, i) => s + i.amountCents, 0) || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Payroll</h2>
          {payrollRun && (
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={
                payrollRun.status === "paid" ? "success" :
                payrollRun.status === "confirmed" ? "default" : "warning"
              }>
                {payrollRun.status}
              </Badge>
              <span className="text-sm text-[var(--muted-foreground)]">
                Total: {formatCents(grandTotal)}
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={generatePayroll}>
            {payrollRun ? "Regenerate" : "Generate"} Payroll
          </Button>
          {payrollRun?.status === "draft" && (
            <Button size="sm" variant="outline" onClick={confirmPayroll}>Confirm</Button>
          )}
          {payrollRun?.status === "confirmed" && (
            <Button size="sm" variant="outline" onClick={markPaid}>Mark Paid</Button>
          )}
          {payrollRun && (
            <Button size="sm" variant="secondary" onClick={exportCSV}>Export CSV</Button>
          )}
        </div>
      </div>

      {loading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-white rounded-xl border animate-pulse" />
          ))}
        </div>
      )}

      {!loading && !payrollRun && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[var(--muted-foreground)] mb-4">
              No payroll generated for this week yet. Make sure demos are confirmed first.
            </p>
            <Button onClick={generatePayroll}>Generate Payroll</Button>
          </CardContent>
        </Card>
      )}

      {!loading && payrollRun && (() => {
        const grouped = groupByMember(payrollRun.lineItems);
        return (
          <div className="space-y-4">
            {Array.from(grouped.entries()).map(([memberId, items]) => {
              const member = items[0].teamMember;
              const memberTotal = items.reduce((s, i) => s + i.amountCents, 0);
              return (
                <Card key={memberId}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CardTitle className="text-base">{member.name}</CardTitle>
                        <Badge variant="secondary">{member.role}</Badge>
                        {member.role === "setter" && (
                          <Badge variant="secondary">Tier {member.tier}</Badge>
                        )}
                      </div>
                      <span className="text-lg font-bold">{formatCents(memberTotal)}</span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {items.map((item) => (
                        <div key={item.id} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                          <div>
                            <Badge variant="secondary" className="mr-2">{item.lineType}</Badge>
                            <span>{item.description}</span>
                          </div>
                          <span className="font-medium">{formatCents(item.amountCents)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            <Card className="border-2 border-[var(--primary)]">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <span className="text-lg font-semibold">Total Payroll</span>
                  <span className="text-2xl font-bold text-[var(--primary)]">
                    {formatCents(grandTotal)}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        );
      })()}
    </div>
  );
}
