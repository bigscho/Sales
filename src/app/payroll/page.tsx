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

interface WeekVerifyStatus {
  weekStatus: string;
  confirmedBy: string | null;
  settersConfirmed: number;
  settersTotal: number;
  openFlags: number;
  pendingDemos: number;
}

export default function PayrollPage() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [payrollRun, setPayrollRun] = useState<PayrollRun | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<WeekVerifyStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/payroll?weekId=${weekId}`).then(r => r.json()),
      fetch(`/api/verify/admin?weekId=${weekId}`).then(r => r.json()).catch(() => null),
    ]).then(([payrollData, verifyData]) => {
      setPayrollRun(payrollData.payrollRun);
      if (verifyData && verifyData.week) {
        setVerifyStatus({
          weekStatus: verifyData.week.status,
          confirmedBy: verifyData.week.confirmedBy,
          settersConfirmed: verifyData.setters.filter((s: { verification: unknown }) => s.verification !== null).length,
          settersTotal: verifyData.setters.length,
          openFlags: verifyData.totalFlags,
          pendingDemos: verifyData.pendingDemoCount,
        });
      }
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
  const weekVerified = verifyStatus?.weekStatus === "confirmed";
  const hasBlockers = verifyStatus && (verifyStatus.openFlags > 0 || verifyStatus.pendingDemos > 0);

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
          <Button size="sm" onClick={generatePayroll} disabled={!weekVerified}>
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

      {/* Verification Status Banner */}
      {verifyStatus && !loading && (
        weekVerified ? (
          <div className="rounded-lg p-3 bg-green-50 border border-green-200 flex items-center justify-between">
            <p className="text-sm text-green-800 font-medium">
              Week verified — {verifyStatus.settersConfirmed}/{verifyStatus.settersTotal} setters confirmed, {verifyStatus.openFlags} open flags
            </p>
            <Badge variant="success">Ready for Payroll</Badge>
          </div>
        ) : (
          <div className="rounded-lg p-3 bg-yellow-50 border border-yellow-200 flex items-center justify-between">
            <div className="text-sm text-yellow-800">
              <p className="font-medium">Week not verified yet</p>
              <p className="text-xs mt-1">
                {verifyStatus.settersConfirmed}/{verifyStatus.settersTotal} setters confirmed
                {hasBlockers && ` · ${verifyStatus.pendingDemos} pending demos · ${verifyStatus.openFlags} open flags`}
              </p>
            </div>
            <a href={`/verify/admin?weekId=${weekId}`}>
              <Button size="sm" variant="outline" className="border-yellow-300 text-yellow-700 hover:bg-yellow-100">
                Verify Week
              </Button>
            </a>
          </div>
        )
      )}

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
            {weekVerified ? (
              <>
                <p className="text-[var(--muted-foreground)] mb-4">
                  Week verified. Ready to generate payroll.
                </p>
                <Button onClick={generatePayroll}>Generate Payroll</Button>
              </>
            ) : (
              <>
                <p className="text-[var(--muted-foreground)] mb-4">
                  Verify the week before generating payroll.
                </p>
                <a href={`/verify/admin?weekId=${weekId}`}>
                  <Button>Go to Week Verification</Button>
                </a>
              </>
            )}
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
