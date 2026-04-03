"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getWeekLabel } from "@/lib/utils";

interface WeekOption {
  id: string;
  weekStart: string;
  weekEnd: string;
  status: string;
}

const STORAGE_KEY = "grassfed_weekId";

export function WeekSelector() {
  const router = useRouter();
  const pathname = usePathname();
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

        // Restore from localStorage or auto-select current week
        const savedWeekId = localStorage.getItem(STORAGE_KEY);
        const paramWeekId = new URLSearchParams(window.location.search).get("weekId");

        if (paramWeekId) {
          // URL already has a weekId — save it
          localStorage.setItem(STORAGE_KEY, paramWeekId);
        } else if (savedWeekId && data.weeks?.some((w: WeekOption) => w.id === savedWeekId)) {
          // Restore saved week
          router.replace(`${pathname}?weekId=${savedWeekId}`);
        } else if (data.weeks?.length > 0) {
          // Default to most recent week
          const defaultId = data.weeks[0].id;
          localStorage.setItem(STORAGE_KEY, defaultId);
          router.replace(`${pathname}?weekId=${defaultId}`);
        }
      })
      .catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const weekId = e.target.value;
      localStorage.setItem(STORAGE_KEY, weekId);
      router.push(`${pathname}?weekId=${weekId}`);
    },
    [router, pathname]
  );

  if (loading) return <div className="h-10 w-56 bg-[var(--muted)] animate-pulse rounded-lg" />;

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-[var(--muted-foreground)]">Week:</label>
      <select
        value={currentWeekId}
        onChange={handleChange}
        className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
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
