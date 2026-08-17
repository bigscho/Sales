"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Confirmations — the show-rate rep's daily work surface.
// T-1 tab: tomorrow's brand-new demos, call list + text QA merged into one row.
// Day-of tab: today's testimonial sends (mostly automated by the morning cron).

interface WorklistRow {
  bookingId: string;
  prospectName: string;
  prospectFirstName: string;
  prospectPhone: string | null;
  prospectEmail: string | null;
  demoDate: string;
  demoTimeLabel: string;
  closerName: string | null;
  setterName: string | null;
  caseType: "single" | "multiple" | "zip" | "area";
  addressVariable: string | null;
  addressSource: "calendly" | "db_fallback" | "none";
  ambiguous: boolean;
  emailCount: number | null;
  body: string;
  variant?: "standard" | "again";
  groupId: string | null;
  sendable: boolean;
  skipReason: string | null;
  blockReason: string | null;
  sendStatus: "not_sent" | "sent" | "failed";
  sentDryRun: boolean;
  sentAt: string | null;
}

interface Readiness {
  windowDays: number;
  totalSent: number;
  editedCount: number;
  editRate: number | null;
  skippedCount: number;
  fallbackEdited: number;
  autoSentShare: number | null;
}

const CASE_LABEL: Record<string, string> = {
  single: "Single address",
  multiple: "Multiple addresses",
  zip: "Zip codes — no count",
  area: "Area — no count",
};

const SKIP_LABEL: Record<string, string> = {
  already_contacted: "Already got the T-1 ask — don't re-ask",
  rescheduled_in: "Rescheduled in — already contacted",
  cancelled: "Cancelled",
  no_phone: "No phone number on the booking",
};

export default function ConfirmationsPage() {
  const [view, setView] = useState<"t1" | "dayof">("t1");
  const [rows, setRows] = useState<WorklistRow[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [showSkips, setShowSkips] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async (v: "t1" | "dayof") => {
    setLoading(true);
    try {
      const res = await fetch(`/api/confirmations?view=${v}`);
      const data = await res.json();
      setRows(data.rows || []);
      setReadiness(data.readiness || null);
      setLive(!!data.live);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(view);
  }, [view, load]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const sendItems = async (items: Array<{ bookingId: string; body?: string }>) => {
    if (!items.length) return;
    setSending((prev) => new Set([...prev, ...items.map((i) => i.bookingId)]));
    try {
      const res = await fetch("/api/confirmations/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touchpoint: view === "dayof" ? "day_of" : "t1", items }),
      });
      const data = await res.json();
      flash(`${data.sent} of ${data.total} sent${live ? "" : " (dry run)"}`);
      await load(view);
    } finally {
      setSending(new Set());
    }
  };

  const sendOne = (row: WorklistRow) =>
    sendItems([{ bookingId: row.bookingId, body: edits[row.bookingId] }]);

  const sendAll = () => {
    const items = rows
      .filter((r) => r.sendable && r.sendStatus === "not_sent")
      .map((r) => ({ bookingId: r.bookingId, body: edits[r.bookingId] }));
    sendItems(items);
  };

  const active = useMemo(() => rows.filter((r) => !r.skipReason), [rows]);
  const skips = useMemo(() => rows.filter((r) => !!r.skipReason), [rows]);
  const pendingCount = active.filter((r) => r.sendable && r.sendStatus === "not_sent").length;
  const sentCount = rows.filter((r) => r.sendStatus === "sent").length;
  const noGroupCount = active.filter((r) => r.blockReason === "no_group").length;

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold">Confirmations</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            {view === "t1"
              ? "Tomorrow's brand-new demos — text + call in tandem"
              : "Today's testimonial reminders"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!live && (
            <span className="text-xs font-semibold px-3 py-1.5 rounded-full bg-amber-500/15 text-amber-600 border border-amber-500/30">
              🧪 Dry run — no real texts fire
            </span>
          )}
          <button
            onClick={sendAll}
            disabled={pendingCount === 0 || sending.size > 0}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--lime)] text-black hover:opacity-90 disabled:opacity-40"
          >
            Send all ({pendingCount})
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-[var(--border)] mb-5">
        {(
          [
            ["t1", "T-1 confirmations"],
            ["dayof", "Today's testimonials"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`pb-2.5 text-sm font-semibold border-b-2 -mb-px ${
              view === v
                ? "border-[var(--lime)] text-[var(--foreground)]"
                : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Readiness strip (T-1 only) */}
      {view === "t1" && readiness && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 mb-5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-3">
            <span className="text-xs font-bold uppercase tracking-wider text-[var(--muted-foreground)]">
              Automation readiness · last {readiness.windowDays}d
            </span>
            <span className="text-xs text-[var(--muted-foreground)]">
              Auto-send unlocks at &lt;3% edit rate + 0 catches for 14 days
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric
              label="Edit rate"
              value={readiness.editRate === null ? "—" : `${(readiness.editRate * 100).toFixed(1)}%`}
              good={readiness.editRate !== null && readiness.editRate < 0.03}
            />
            <Metric label="Texts sent" value={String(readiness.totalSent)} />
            <Metric
              label="Fallback edits"
              value={String(readiness.fallbackEdited)}
              good={readiness.fallbackEdited === 0}
            />
            <Metric
              label="Auto-sent share"
              value={
                readiness.autoSentShare === null ? "—" : `${(readiness.autoSentShare * 100).toFixed(0)}%`
              }
            />
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Tile label={view === "t1" ? "To confirm" : "Demos today"} value={active.length} />
        <Tile label="Sent" value={sentCount} />
        <Tile label="No group yet" value={noGroupCount} warn={noGroupCount > 0} />
        <Tile label="Skip" value={skips.length} />
      </div>

      {loading ? (
        <div className="text-sm text-[var(--muted-foreground)] py-12 text-center">Loading…</div>
      ) : (
        <>
          {/* Worklist */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] divide-y divide-[var(--border)] overflow-hidden">
            {active.length === 0 && (
              <div className="p-8 text-center text-sm text-[var(--muted-foreground)]">
                Nothing on the list {view === "t1" ? "for tomorrow" : "today"}.
              </div>
            )}
            {active.map((row) => (
              <Row
                key={row.bookingId}
                row={row}
                view={view}
                busy={sending.has(row.bookingId)}
                editValue={edits[row.bookingId]}
                isEditing={editing.has(row.bookingId)}
                onEditToggle={() =>
                  setEditing((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.bookingId)) next.delete(row.bookingId);
                    else next.add(row.bookingId);
                    return next;
                  })
                }
                onEditChange={(v) => setEdits((prev) => ({ ...prev, [row.bookingId]: v }))}
                onSend={() => sendOne(row)}
              />
            ))}
          </div>

          {/* Skip section */}
          {skips.length > 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-[var(--border)]">
              <button
                onClick={() => setShowSkips((s) => !s)}
                className="w-full flex items-center gap-2 px-4 py-3 text-left"
              >
                <span className="text-xs font-bold uppercase tracking-wider text-[var(--muted-foreground)]">
                  Skip — already handled · {skips.length}
                </span>
                <span className="ml-auto text-[var(--muted-foreground)]">{showSkips ? "▾" : "▸"}</span>
              </button>
              {showSkips && (
                <div className="px-4 pb-3 divide-y divide-[var(--border)]">
                  {skips.map((row) => (
                    <div key={row.bookingId} className="py-2.5 flex items-center gap-3 text-sm">
                      <span
                        className={`font-semibold ${
                          row.skipReason === "cancelled" ? "line-through text-[var(--muted-foreground)]" : ""
                        }`}
                      >
                        {row.prospectName}
                      </span>
                      <span className="text-[var(--muted-foreground)] tabular-nums">{row.demoTimeLabel}</span>
                      <span className="ml-auto text-xs text-[var(--muted-foreground)]">
                        {SKIP_LABEL[row.skipReason!] || row.skipReason}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="mt-4 text-xs text-[var(--muted-foreground)]">
            {view === "t1" ? (
              <>
                The email count is frozen per demo — what you see is exactly what sends. Rescheduled demos
                already got this ask and sit in Skip. Replies land in the SendBlue inbox.
              </>
            ) : (
              <>
                Copy is picked automatically: first-timers get the standard testimonial text, anyone who
                already received a day-of gets the &ldquo;dropping this again&rdquo; version.
              </>
            )}
          </p>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-full bg-[var(--foreground)] text-[var(--background)] text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
      <div className="text-xs text-[var(--muted-foreground)] font-medium">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${warn ? "text-amber-500" : ""}`}>{value}</div>
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="rounded-lg bg-[var(--muted)] px-3 py-2">
      <div className="text-[11px] text-[var(--muted-foreground)] font-medium">{label}</div>
      <div className="text-lg font-bold tabular-nums">
        {value} {good && <span className="text-[var(--lime)] text-sm">✓</span>}
      </div>
    </div>
  );
}

function Row({
  row,
  view,
  busy,
  editValue,
  isEditing,
  onEditToggle,
  onEditChange,
  onSend,
}: {
  row: WorklistRow;
  view: "t1" | "dayof";
  busy: boolean;
  editValue: string | undefined;
  isEditing: boolean;
  onEditToggle: () => void;
  onEditChange: (v: string) => void;
  onSend: () => void;
}) {
  const noGroup = row.blockReason === "no_group";
  const sent = row.sendStatus === "sent";
  const failed = row.sendStatus === "failed";

  return (
    <div className={`p-4 flex flex-col sm:flex-row gap-4 ${noGroup ? "bg-red-500/5" : ""}`}>
      {/* Who + call info */}
      <div className="sm:w-56 flex-shrink-0 space-y-1">
        <div className="font-semibold">{row.prospectName}</div>
        <div className="text-xs text-[var(--muted-foreground)] tabular-nums">
          {row.demoTimeLabel}
          {row.closerName && <> · with <b>{row.closerName}</b></>}
        </div>
        {row.prospectPhone && (
          <a href={`tel:${row.prospectPhone}`} className="text-xs text-[var(--teal)] hover:underline font-mono">
            {row.prospectPhone}
          </a>
        )}
        {row.setterName && (
          <div className="text-[11px] text-[var(--muted-foreground)]">booked by {row.setterName}</div>
        )}
      </div>

      {/* Message */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1.5 text-[11px]">
          {view === "t1" && (
            <span className="font-bold uppercase tracking-wide text-[var(--muted-foreground)]">
              {CASE_LABEL[row.caseType]}
            </span>
          )}
          {view === "dayof" && row.variant === "again" && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 font-semibold">
              &ldquo;Again&rdquo; — day-of sent before
            </span>
          )}
          {row.addressSource === "db_fallback" && (
            <span className="px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-500 font-semibold">
              Calendly blank → pulled from DB — double-check
            </span>
          )}
          {row.ambiguous && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 font-semibold">
              Parse unsure — check the address
            </span>
          )}
          {noGroup && (
            <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-500 font-semibold">
              No group chat yet
            </span>
          )}
        </div>

        {isEditing ? (
          <textarea
            value={editValue ?? row.body}
            onChange={(e) => onEditChange(e.target.value)}
            rows={4}
            className="w-full text-[13px] rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 leading-relaxed"
          />
        ) : (
          <div
            className={`text-[13px] leading-relaxed rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--muted)] px-3.5 py-2.5 max-w-xl ${
              noGroup ? "opacity-50" : ""
            }`}
          >
            {editValue ?? row.body}
            {view === "dayof" && <span className="text-[var(--teal)]"> ▶ testimonial video</span>}
          </div>
        )}

        {noGroup ? (
          <p className="mt-1.5 text-[11px] text-red-500 max-w-xl">
            The Grassfed line isn&apos;t in a group with this agent yet, so it can&apos;t text them. Create the
            group (line + agent), send one message, and this row goes live. Call-only until then.
          </p>
        ) : (
          !sent && (
            <button onClick={onEditToggle} className="mt-1.5 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] underline">
              {isEditing ? "Done editing" : "Edit text"}
            </button>
          )
        )}
      </div>

      {/* Action */}
      <div className="sm:w-32 flex-shrink-0 flex sm:flex-col items-end gap-2">
        {sent ? (
          <span className="text-sm font-semibold text-[var(--lime)]">
            Sent ✓{row.sentDryRun && <span className="block text-[10px] text-[var(--muted-foreground)] font-normal">dry run</span>}
          </span>
        ) : noGroup ? (
          <span className="text-xs text-[var(--muted-foreground)]">Call only</span>
        ) : (
          <button
            onClick={onSend}
            disabled={busy || !row.sendable}
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-[var(--lime)] text-black hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send text"}
          </button>
        )}
        {failed && <span className="text-[11px] text-red-500">Failed — retry</span>}
      </div>
    </div>
  );
}
