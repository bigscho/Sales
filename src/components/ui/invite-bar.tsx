"use client";

// GCal invite RSVP composition bar — the sibling of StatusBar, same visual
// language so the two stack cleanly on a setter row. Segments: accepted /
// no response (needsAction/tentative — the prospect never clicked Yes or No) /
// declined. This is the prospect's RSVP state, NOT the demo timeline — an
// accepted invite counts as accepted whether or not the demo has happened yet.
// A mostly-green bar = prospects are firming their bookings.
interface InviteBarProps {
  accepted: number;
  none: number;
  declined: number;
  className?: string;
  size?: "sm" | "md";
}

export function InviteBar({ accepted, none, declined, className = "", size = "md" }: InviteBarProps) {
  const total = accepted + none + declined;
  if (total === 0) {
    return (
      <div className={className}>
        <div className="h-2 rounded-full bg-[var(--muted)]" />
        <div className="flex justify-center mt-1">
          <span className={`text-[var(--muted-foreground)] ${size === "sm" ? "text-xs" : "text-sm"}`}>No invites tracked</span>
        </div>
      </div>
    );
  }

  const acceptedPct = (accepted / total) * 100;
  const nonePct = (none / total) * 100;
  const declinedPct = (declined / total) * 100;

  const barH = size === "sm" ? "h-2" : "h-3";
  const numSize = size === "sm" ? "text-xs" : "text-sm font-semibold";
  const labelSize = size === "sm" ? "text-[10px]" : "text-xs";

  return (
    <div className={className}>
      {/* Numbers above bar */}
      <div className="flex" style={{ minHeight: size === "sm" ? "16px" : "20px" }}>
        {accepted > 0 && (
          <div style={{ width: `${acceptedPct}%` }} className="text-center">
            <span className={`${numSize} text-green-600`}>{accepted}</span>
          </div>
        )}
        {none > 0 && (
          <div style={{ width: `${nonePct}%` }} className="text-center">
            <span className={`${numSize} text-slate-500`}>{none}</span>
          </div>
        )}
        {declined > 0 && (
          <div style={{ width: `${declinedPct}%` }} className="text-center">
            <span className={`${numSize} text-red-600`}>{declined}</span>
          </div>
        )}
      </div>

      {/* Progress bar: accepted → none → declined */}
      <div className={`flex ${barH} rounded-full overflow-hidden bg-[var(--muted)]`}>
        {accepted > 0 && (
          <div className="bg-green-500 transition-all duration-500" style={{ width: `${acceptedPct}%` }} />
        )}
        {none > 0 && (
          <div className="bg-slate-400 transition-all duration-500" style={{ width: `${nonePct}%` }} />
        )}
        {declined > 0 && (
          <div className="bg-red-500 transition-all duration-500" style={{ width: `${declinedPct}%` }} />
        )}
      </div>

      {/* Labels below bar */}
      <div className="flex" style={{ minHeight: size === "sm" ? "14px" : "16px" }}>
        {accepted > 0 && (
          <div style={{ width: `${acceptedPct}%` }} className="text-center">
            <span className={`${labelSize} text-green-600`}>Accepted</span>
          </div>
        )}
        {none > 0 && (
          <div style={{ width: `${nonePct}%` }} className="text-center">
            <span className={`${labelSize} text-slate-500`}>No response</span>
          </div>
        )}
        {declined > 0 && (
          <div style={{ width: `${declinedPct}%` }} className="text-center">
            <span className={`${labelSize} text-red-600`}>Declined</span>
          </div>
        )}
      </div>
    </div>
  );
}
