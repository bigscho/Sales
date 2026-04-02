"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback } from "react";
import { type TimeDimension, getDateRange } from "@/lib/time-range";

export function useTimeDimension() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const dimension = (searchParams.get("dimension") as TimeDimension) || "weekly";
  const dateRange = getDateRange(dimension);

  const setDimension = useCallback(
    (dim: TimeDimension) => {
      const params = new URLSearchParams(searchParams.toString());
      if (dim === "weekly") {
        params.delete("dimension");
      } else {
        params.set("dimension", dim);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname],
  );

  return { dimension, setDimension, dateRange };
}
