"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getWeekLabel } from "@/lib/utils";

interface WeekOption {
  id: string;
  weekStart: string;
  weekEnd: string;
  status: string;
}

export function WeekSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentWeekId = searchParams.get("weekId") || "";
  const [weeks, setWeeks] = useState<WeekOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/weeks")
      .then((r) => r.json())
      .then((data) => {
        setWeeks(data.weeks || []);
        setLoading(false);
        // Auto-select current week if none selected
        if (!currentWeekId && data.weeks?.length > 0) {
          const params = new URLSearchParams(searchParams.toString());
          params.set("weekId", data.weeks[0].id);
          router.replace(`?${params.toString()}`);
        }
      })
      .catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("weekId", e.target.value);
      router.push(`?${params.toString()}`);
    },
    [router, searchParams]
  );

  if (loading) return <div className="h-10 w-56 bg-gray-100 animate-pulse rounded-lg" />;

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-[var(--muted-foreground)]">Week:</label>
      <select
        value={currentWeekId}
        onChange={handleChange}
        className="h-10 px-3 rounded-lg border border-[var(--border)] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        {weeks.length === 0 && <option value="">No weeks yet</option>}
        {weeks.map((w) => (
          <option key={w.id} value={w.id}>
            {getWeekLabel(w.weekStart, w.weekEnd)} {w.status === "confirmed" ? " ✓" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
