// Performance color coding for KPI values
// great = lime/light green, good = dark green (teal), bad = red

export function perfColor(value: number, thresholds: { great: number; good: number }, higherIsBetter = true): string {
  if (higherIsBetter) {
    if (value >= thresholds.great) return "text-[var(--lime)]";   // great
    if (value >= thresholds.good) return "text-[var(--teal)]";    // good
    return "text-red-600";                                         // bad
  } else {
    // Lower is better (e.g. no-show count)
    if (value <= thresholds.great) return "text-[var(--lime)]";
    if (value <= thresholds.good) return "text-[var(--teal)]";
    return "text-red-600";
  }
}

// Show rate color: 60%+ great, 40%+ good, below bad
export function showRateColor(rate: number): string {
  return perfColor(rate, { great: 0.6, good: 0.4 });
}

// Close rate color: 30%+ great, 15%+ good, below bad
export function closeRateColor(rate: number): string {
  return perfColor(rate, { great: 0.3, good: 0.15 });
}

// Cash color: always teal (good) unless zero
export function cashColor(cents: number): string {
  if (cents === 0) return "text-[var(--muted-foreground)]";
  return "text-[var(--teal)]";
}
