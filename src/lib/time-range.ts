import { getWeekRange } from "./utils";

export type TimeDimension = "daily" | "weekly" | "monthly" | "all_time";

/**
 * Returns date boundaries for a given time dimension.
 * Returns null for all_time (no date filter).
 * All dates are in ET for daily/monthly, UTC for weekly (matches existing getWeekRange).
 */
export function getDateRange(
  dimension: TimeDimension,
  referenceDate?: Date,
): { start: Date; end: Date } | null {
  const now = referenceDate || new Date();

  if (dimension === "all_time") return null;

  if (dimension === "weekly") {
    return getWeekRange(now);
  }

  // ET date parts for daily and monthly
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = etFormatter.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === "year")!.value);
  const month = parseInt(parts.find((p) => p.type === "month")!.value) - 1;
  const day = parseInt(parts.find((p) => p.type === "day")!.value);

  // Compute ET→UTC offset
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etString);
  const diffMs = now.getTime() - etDate.getTime();

  if (dimension === "daily") {
    const start = new Date(Date.UTC(year, month, day) + diffMs);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  if (dimension === "monthly") {
    const start = new Date(Date.UTC(year, month, 1) + diffMs);
    const end = new Date(Date.UTC(year, month + 1, 1) + diffMs);
    return { start, end };
  }

  return null;
}
