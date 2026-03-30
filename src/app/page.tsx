"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { KPICard } from "@/components/dashboard/kpi-card";
import { Badge } from "@/components/ui/badge";
import { formatCents, formatPercent } from "@/lib/utils";

interface KPIData {
  weekId: string;
  totalBookings: number;
  totalShows: number;
  totalNoShows: number;
  totalPending: number;
  showRate: number;
  totalCloses: number;
  totalHeld: number;
  totalLost: number;
  closeRate: number;
  cashCollected: number;
  avgCashPerClose: number;
  cashPerBooking: number;
  cashPerShow: number;
  setterStats: { setterId: string; setterName: string; bookings: number; shows: number; noShows: number; showRate: number }[];
  closerStats: { closerId: string; closerName: string; shows: number; closes: number; held: number; lost: number; closeRate: number; cashCollected: number }[];
}

interface DemoRecord {
  id: string;
  status: string;
  booking: { prospectName: string; prospectEmail: string; demoDate: string; setter: { name: string } | null };
  closer: { name: string } | null;
}

export default function Dashboard() {
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const [kpis, setKpis] = useState<KPIData | null>(null);
  const [demos, setDemos] = useState<DemoRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    if (!weekId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/kpis?weekId=${weekId}`).then((r) => r.json()),
      fetch(`/api/demos?weekId=${weekId}`).then((r) => r.json()),
    ]).then(([kpiData, demoData]) => {
      setKpis(kpiData);
      setDemos(demoData.demos || []);
      setLoading(false);
    });
  }, [weekId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => { loadData(); }, 60000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (!weekId) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-[var(--muted-foreground)]">Select a week to view KPIs</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-32 bg-white rounded-xl border animate-pulse" />
        ))}
      </div>
    );
  }

  if (!kpis) return <p>Error loading KPIs</p>;

  const showedDemos = demos.filter((d) => d.status === "showed");
  const noShowDemos = demos.filter((d) => d.status === "no_show");
  const pendingDemos = demos.filter((d) => d.status === "pending");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Weekly Dashboard</h2>
        {kpis.totalPending > 0 && (
          <Badge variant="warning">{kpis.totalPending} demos pending confirmation</Badge>
        )}
      </div>

      {/* Top-level KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard
          title="Total Bookings"
          value={String(kpis.totalBookings)}
          subtitle={`${kpis.totalPending} pending`}
          detail={
            <div className="space-y-1">
              {demos.map((d) => (
                <div key={d.id} className="flex justify-between text-sm">
                  <span>{d.booking.prospectName}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">{d.booking.setter?.name || "—"}</span>
                    <Badge variant={d.status === "showed" ? "success" : d.status === "no_show" ? "danger" : "warning"}>
                      {d.status}
                    </Badge>
                  </div>
                </div>
              ))}
              {demos.length === 0 && <p className="text-sm text-gray-500">No bookings this week</p>}
            </div>
          }
        />
        <KPICard
          title="Shows"
          value={String(kpis.totalShows)}
          subtitle={`${kpis.totalNoShows} no-shows`}
          detail={
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-600 mb-2">Showed:</p>
              {showedDemos.map((d) => (
                <div key={d.id} className="flex justify-between text-sm">
                  <span>{d.booking.prospectName}</span>
                  <span className="text-xs text-gray-500">{d.booking.setter?.name}</span>
                </div>
              ))}
              {noShowDemos.length > 0 && <p className="text-xs font-medium text-gray-600 mt-3 mb-2">No-shows:</p>}
              {noShowDemos.map((d) => (
                <div key={d.id} className="flex justify-between text-sm text-red-600">
                  <span>{d.booking.prospectName}</span>
                  <span className="text-xs">{d.booking.setter?.name}</span>
                </div>
              ))}
              {pendingDemos.length > 0 && <p className="text-xs font-medium text-gray-600 mt-3 mb-2">Pending:</p>}
              {pendingDemos.map((d) => (
                <div key={d.id} className="flex justify-between text-sm text-yellow-600">
                  <span>{d.booking.prospectName}</span>
                  <span className="text-xs">{d.booking.setter?.name}</span>
                </div>
              ))}
            </div>
          }
        />
        <KPICard
          title="Show Rate"
          value={formatPercent(kpis.showRate)}
          subtitle={`${kpis.totalShows} of ${kpis.totalBookings} booked`}
        />
        <KPICard
          title="Close Rate"
          value={formatPercent(kpis.closeRate)}
          subtitle={`${kpis.totalCloses} closes, ${kpis.totalHeld} held`}
        />
      </div>

      {/* Revenue KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard
          title="Cash Collected"
          value={formatCents(kpis.cashCollected)}
          subtitle={`${kpis.totalCloses} deals closed`}
        />
        <KPICard
          title="Avg Cash / Close"
          value={formatCents(kpis.avgCashPerClose)}
        />
        <KPICard
          title="Cash / Booking"
          value={formatCents(kpis.cashPerBooking)}
        />
        <KPICard
          title="Cash / Show"
          value={formatCents(kpis.cashPerShow)}
        />
      </div>

      {/* Setter Performance */}
      {kpis.setterStats.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Setter Performance</h3>
          <div className="bg-white rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Setter</th>
                  <th className="text-right p-3 font-medium">Bookings</th>
                  <th className="text-right p-3 font-medium">Shows</th>
                  <th className="text-right p-3 font-medium">No-Shows</th>
                  <th className="text-right p-3 font-medium">Show Rate</th>
                </tr>
              </thead>
              <tbody>
                {kpis.setterStats.map((s) => (
                  <tr key={s.setterId} className="border-b last:border-0">
                    <td className="p-3 font-medium">{s.setterName}</td>
                    <td className="p-3 text-right">{s.bookings}</td>
                    <td className="p-3 text-right">{s.shows}</td>
                    <td className="p-3 text-right">{s.noShows}</td>
                    <td className="p-3 text-right font-medium">{formatPercent(s.showRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Closer Performance */}
      {kpis.closerStats.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Closer Performance</h3>
          <div className="bg-white rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Closer</th>
                  <th className="text-right p-3 font-medium">Shows</th>
                  <th className="text-right p-3 font-medium">Closes</th>
                  <th className="text-right p-3 font-medium">Held</th>
                  <th className="text-right p-3 font-medium">Close Rate</th>
                  <th className="text-right p-3 font-medium">Cash</th>
                </tr>
              </thead>
              <tbody>
                {kpis.closerStats.map((c) => (
                  <tr key={c.closerId} className="border-b last:border-0">
                    <td className="p-3 font-medium">{c.closerName}</td>
                    <td className="p-3 text-right">{c.shows}</td>
                    <td className="p-3 text-right">{c.closes}</td>
                    <td className="p-3 text-right">{c.held}</td>
                    <td className="p-3 text-right font-medium">{formatPercent(c.closeRate)}</td>
                    <td className="p-3 text-right font-medium">{formatCents(c.cashCollected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
