"use client";

interface StatusBarProps {
  showed: number;
  noShow: number;
  pending: number;
  cancelled?: number;
  className?: string;
  size?: "sm" | "md";
}

export function StatusBar({ showed, noShow, pending, cancelled = 0, className = "", size = "md" }: StatusBarProps) {
  const total = showed + noShow + pending + cancelled;
  if (total === 0) {
    return (
      <div className={`${className}`}>
        <div className="h-2 rounded-full bg-[var(--muted)]" />
        <div className="flex justify-center mt-1">
          <span className={`text-[var(--muted-foreground)] ${size === "sm" ? "text-xs" : "text-sm"}`}>No data</span>
        </div>
      </div>
    );
  }

  const showPct = (showed / total) * 100;
  const pendingPct = (pending / total) * 100;
  const noShowPct = (noShow / total) * 100;
  const cancelledPct = (cancelled / total) * 100;

  const barH = size === "sm" ? "h-2" : "h-3";
  const numSize = size === "sm" ? "text-xs" : "text-sm font-semibold";
  const labelSize = size === "sm" ? "text-[10px]" : "text-xs";

  return (
    <div className={className}>
      {/* Numbers above bar */}
      <div className="flex" style={{ minHeight: size === "sm" ? "16px" : "20px" }}>
        {showed > 0 && (
          <div style={{ width: `${showPct}%` }} className="text-center">
            <span className={`${numSize} text-green-600`}>{showed}</span>
          </div>
        )}
        {pending > 0 && (
          <div style={{ width: `${pendingPct}%` }} className="text-center">
            <span className={`${numSize} text-yellow-600`}>{pending}</span>
          </div>
        )}
        {noShow > 0 && (
          <div style={{ width: `${noShowPct}%` }} className="text-center">
            <span className={`${numSize} text-red-600`}>{noShow}</span>
          </div>
        )}
        {cancelled > 0 && (
          <div style={{ width: `${cancelledPct}%` }} className="text-center">
            <span className={`${numSize} text-slate-500`}>{cancelled}</span>
          </div>
        )}
      </div>

      {/* Progress bar: showed → pending → no-show → cancelled */}
      <div className={`flex ${barH} rounded-full overflow-hidden bg-[var(--muted)]`}>
        {showed > 0 && (
          <div
            className="bg-green-500 transition-all duration-500"
            style={{ width: `${showPct}%` }}
          />
        )}
        {pending > 0 && (
          <div
            className="bg-yellow-400 transition-all duration-500"
            style={{ width: `${pendingPct}%` }}
          />
        )}
        {noShow > 0 && (
          <div
            className="bg-red-500 transition-all duration-500"
            style={{ width: `${noShowPct}%` }}
          />
        )}
        {cancelled > 0 && (
          <div
            className="bg-slate-400 transition-all duration-500"
            style={{ width: `${cancelledPct}%` }}
          />
        )}
      </div>

      {/* Labels below bar */}
      <div className="flex" style={{ minHeight: size === "sm" ? "14px" : "16px" }}>
        {showed > 0 && (
          <div style={{ width: `${showPct}%` }} className="text-center">
            <span className={`${labelSize} text-green-600`}>Show</span>
          </div>
        )}
        {pending > 0 && (
          <div style={{ width: `${pendingPct}%` }} className="text-center">
            <span className={`${labelSize} text-yellow-600`}>Pending</span>
          </div>
        )}
        {noShow > 0 && (
          <div style={{ width: `${noShowPct}%` }} className="text-center">
            <span className={`${labelSize} text-red-600`}>No-show</span>
          </div>
        )}
        {cancelled > 0 && (
          <div style={{ width: `${cancelledPct}%` }} className="text-center">
            <span className={`${labelSize} text-slate-500`}>Cancel</span>
          </div>
        )}
      </div>
    </div>
  );
}
