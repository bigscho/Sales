"use client";

import { type TimeDimension } from "@/lib/time-range";

const LABELS: Record<TimeDimension, string> = {
  daily: "Today",
  weekly: "Weekly",
  monthly: "Monthly",
  all_time: "All-Time",
};

interface TimeDimensionToggleProps {
  value: TimeDimension;
  onChange: (dim: TimeDimension) => void;
  options?: TimeDimension[];
}

export function TimeDimensionToggle({
  value,
  onChange,
  options = ["daily", "weekly", "monthly", "all_time"],
}: TimeDimensionToggleProps) {
  return (
    <div className="inline-flex rounded-lg border bg-gray-50 p-0.5">
      {options.map((dim) => (
        <button
          key={dim}
          onClick={() => onChange(dim)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            value === dim
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {LABELS[dim]}
        </button>
      ))}
    </div>
  );
}
