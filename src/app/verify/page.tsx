"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface DemoItem {
  id: string;
  prospectName: string;
  prospectEmail: string | null;
  demoDate: string;
  status: string;
  closer: string | null;
  source: string;
  isLocked: boolean;
  existingFlag: {
    id: string;
    flagType: string;
    note: string | null;
    ceoAction: string;
  } | null;
}

interface MissingFlag {
  id: string;
  prospectName: string | null;
  prospectEmail: string | null;
  demoDate: string | null;
  note: string | null;
  ceoAction: string;
}

interface VerifyData {
  setter: { id: string; name: string };
  weekStart: string;
  weekEnd: string;
  demos: DemoItem[];
  missingFlags: MissingFlag[];
  verification: { status: string; confirmedAt: string } | null;
}

type FlagDraft = {
  demoId?: string;
  flagType: "wrong_status" | "not_mine" | "missing_demo";
  note?: string;
  missingProspectName?: string;
  missingProspectEmail?: string;
  missingDemoDate?: string;
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  showed: "Showed",
  no_show: "No Show",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  showed: "bg-green-100 text-green-800",
  no_show: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-600",
  rescheduled: "bg-blue-100 text-blue-700",
};

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatWeekRange(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export default function VerifyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const weekId = searchParams.get("weekId") || "";
  const setterId = searchParams.get("setter") || "";

  const [data, setData] = useState<VerifyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // If no setter param, redirect to admin view
  useEffect(() => {
    if (weekId && !setterId) {
      router.replace(`/verify/admin?weekId=${weekId}`);
    }
  }, [weekId, setterId, router]);

  // Track which demos the setter has checked off as correct
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  // Track flags being drafted
  const [flagDrafts, setFlagDrafts] = useState<Map<string, FlagDraft>>(new Map());
  // Track which demos have the flag form open
  const [flagOpen, setFlagOpen] = useState<Set<string>>(new Set());
  // Missing demo form
  const [showMissingForm, setShowMissingForm] = useState(false);
  const [missingName, setMissingName] = useState("");
  const [missingEmail, setMissingEmail] = useState("");
  const [missingDate, setMissingDate] = useState("");
  const [missingNote, setMissingNote] = useState("");
  // Pending missing demo flags to submit
  const [missingDrafts, setMissingDrafts] = useState<FlagDraft[]>([]);

  const loadData = useCallback(() => {
    if (!weekId || !setterId) return;
    setLoading(true);
    fetch(`/api/verify?weekId=${weekId}&setter=${setterId}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
        // Pre-check demos that don't have existing flags and aren't locked
        // (if already confirmed before, check all)
        if (d.verification?.status === "confirmed") {
          setConfirmedIds(new Set(d.demos.map((dm: DemoItem) => dm.id)));
          setSubmitted(true);
        }
      })
      .catch(() => setLoading(false));
  }, [weekId, setterId]);

  useEffect(() => { loadData(); }, [loadData]);

  if (!weekId || !setterId) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Invalid verification link. Contact your manager.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-white rounded-xl border animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data) return <p className="text-center mt-10 text-gray-500">Error loading data</p>;

  const { setter, demos, missingFlags, verification } = data;

  // Separate unlocked (actionable) and locked demos
  const unlockedDemos = demos.filter(d => !d.isLocked);
  const lockedDemos = demos.filter(d => d.isLocked);

  // Stats
  const showCount = demos.filter(d => d.status === "showed").length;
  const noShowCount = demos.filter(d => d.status === "no_show").length;
  const pendingCount = demos.filter(d => d.status === "pending").length;
  const confirmed = showCount + noShowCount;
  const showRate = confirmed > 0 ? ((showCount / confirmed) * 100).toFixed(0) : "--";

  const toggleConfirm = (demoId: string) => {
    const next = new Set(confirmedIds);
    if (next.has(demoId)) {
      next.delete(demoId);
    } else {
      next.add(demoId);
      // Remove any flag draft for this demo
      const nextFlags = new Map(flagDrafts);
      nextFlags.delete(demoId);
      setFlagDrafts(nextFlags);
      const nextOpen = new Set(flagOpen);
      nextOpen.delete(demoId);
      setFlagOpen(nextOpen);
    }
    setConfirmedIds(next);
  };

  const toggleFlagForm = (demoId: string) => {
    const next = new Set(flagOpen);
    if (next.has(demoId)) {
      next.delete(demoId);
    } else {
      next.add(demoId);
      // Uncheck confirmed
      const nextConfirmed = new Set(confirmedIds);
      nextConfirmed.delete(demoId);
      setConfirmedIds(nextConfirmed);
    }
    setFlagOpen(next);
  };

  const saveFlagDraft = (demoId: string, flagType: "wrong_status" | "not_mine", note: string) => {
    const next = new Map(flagDrafts);
    next.set(demoId, { demoId, flagType, note });
    setFlagDrafts(next);
    // Close the form
    const nextOpen = new Set(flagOpen);
    nextOpen.delete(demoId);
    setFlagOpen(nextOpen);
  };

  const removeFlagDraft = (demoId: string) => {
    const next = new Map(flagDrafts);
    next.delete(demoId);
    setFlagDrafts(next);
  };

  const addMissingDraft = () => {
    if (!missingName.trim()) return;
    setMissingDrafts([...missingDrafts, {
      flagType: "missing_demo",
      missingProspectName: missingName.trim(),
      missingProspectEmail: missingEmail.trim() || undefined,
      missingDemoDate: missingDate.trim() || undefined,
      note: missingNote.trim() || undefined,
    }]);
    setMissingName("");
    setMissingEmail("");
    setMissingDate("");
    setMissingNote("");
    setShowMissingForm(false);
  };

  const removeMissingDraft = (idx: number) => {
    setMissingDrafts(missingDrafts.filter((_, i) => i !== idx));
  };

  const confirmAll = () => {
    const ids = new Set(unlockedDemos.filter(d => !d.existingFlag).map(d => d.id));
    setConfirmedIds(ids);
    setFlagDrafts(new Map());
    setFlagOpen(new Set());
  };

  // Every unlocked demo without an existing flag must be either confirmed or flagged
  const unlockedActionable = unlockedDemos.filter(d => !d.existingFlag);
  const allAccountedFor = unlockedActionable.every(
    d => confirmedIds.has(d.id) || flagDrafts.has(d.id)
  );

  const handleSubmit = async () => {
    setSubmitting(true);
    const allFlags: FlagDraft[] = [...flagDrafts.values(), ...missingDrafts];

    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        weekId,
        setterId,
        confirmedDemoIds: Array.from(confirmedIds),
        flags: allFlags,
      }),
    });

    if (res.ok) {
      setSubmitted(true);
      loadData(); // Refresh to show updated state
    }
    setSubmitting(false);
  };

  const alreadyConfirmed = verification?.status === "confirmed" || verification?.status === "has_flags";

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{setter.name} — Weekly Verification</h1>
        <p className="text-sm text-gray-500 mt-1">
          {formatWeekRange(data.weekStart, data.weekEnd)}
        </p>
        <p className="text-sm text-gray-600 mt-2">
          Here are the bookings and shows we&apos;re crediting you for this week.
          Confirm what&apos;s correct, and flag anything that needs fixing.
        </p>
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className="text-2xl font-bold">{demos.length}</p>
            <p className="text-xs text-gray-500">Booked</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className="text-2xl font-bold text-green-600">{showCount}</p>
            <p className="text-xs text-gray-500">Showed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className="text-2xl font-bold text-red-600">{noShowCount}</p>
            <p className="text-xs text-gray-500">No Show</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3 text-center">
            <p className={`text-2xl font-bold ${Number(showRate) >= 60 ? "text-green-600" : Number(showRate) >= 40 ? "text-yellow-600" : "text-gray-600"}`}>
              {showRate}%
            </p>
            <p className="text-xs text-gray-500">Show Rate</p>
          </CardContent>
        </Card>
      </div>

      {/* Already confirmed banner */}
      {alreadyConfirmed && submitted && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
          <p className="text-green-800 font-medium">
            {verification?.status === "confirmed"
              ? "You confirmed all demos. No issues reported."
              : "Submitted with flags. Issues are under review."}
          </p>
          <p className="text-xs text-green-600 mt-1">
            Confirmed {verification?.confirmedAt ? new Date(verification.confirmedAt).toLocaleString() : ""}
          </p>
        </div>
      )}

      {/* Confirm All shortcut */}
      {!submitted && unlockedActionable.length > 0 && (
        <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-sm text-blue-800">Everything look right?</p>
          <Button size="sm" variant="outline" onClick={confirmAll} className="border-blue-300 text-blue-700 hover:bg-blue-100">
            Confirm All Correct
          </Button>
        </div>
      )}

      {/* Demo List */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Your Demos This Week</CardTitle>
          {pendingCount > 0 && (
            <p className="text-xs text-yellow-600">{pendingCount} still pending confirmation</p>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {demos.length === 0 && (
            <p className="text-sm text-gray-500 py-4 text-center">No demos attributed to you this week.</p>
          )}

          {/* Unlocked demos first */}
          {unlockedDemos.map((demo) => (
            <DemoRow
              key={demo.id}
              demo={demo}
              isConfirmed={confirmedIds.has(demo.id)}
              hasFlagDraft={flagDrafts.has(demo.id)}
              flagDraft={flagDrafts.get(demo.id)}
              isFlagOpen={flagOpen.has(demo.id)}
              submitted={submitted}
              onToggleConfirm={() => toggleConfirm(demo.id)}
              onToggleFlag={() => toggleFlagForm(demo.id)}
              onSaveFlag={(type, note) => saveFlagDraft(demo.id, type, note)}
              onRemoveFlag={() => removeFlagDraft(demo.id)}
            />
          ))}

          {/* Locked demos */}
          {lockedDemos.length > 0 && (
            <>
              <div className="border-t pt-3 mt-3">
                <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Locked Days</p>
              </div>
              {lockedDemos.map((demo) => (
                <DemoRow
                  key={demo.id}
                  demo={demo}
                  isConfirmed={false}
                  hasFlagDraft={false}
                  flagDraft={undefined}
                  isFlagOpen={false}
                  submitted={true}
                  onToggleConfirm={() => {}}
                  onToggleFlag={() => {}}
                  onSaveFlag={() => {}}
                  onRemoveFlag={() => {}}
                />
              ))}
            </>
          )}
        </CardContent>
      </Card>

      {/* Existing missing demo flags (previously submitted) */}
      {missingFlags.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Previously Flagged Missing Demos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {missingFlags.map((f) => (
              <div key={f.id} className="flex items-center justify-between p-3 rounded-lg bg-orange-50 border border-orange-200">
                <div>
                  <p className="text-sm font-medium">{f.prospectName || "Unknown"}</p>
                  <p className="text-xs text-gray-500">
                    {f.prospectEmail && <span>{f.prospectEmail} &middot; </span>}
                    {f.demoDate && <span>~{f.demoDate}</span>}
                  </p>
                  {f.note && <p className="text-xs text-gray-600 mt-1">{f.note}</p>}
                </div>
                <Badge variant={f.ceoAction === "approved" ? "success" : f.ceoAction === "rejected" ? "danger" : "warning"}>
                  {f.ceoAction === "pending" ? "Under Review" : f.ceoAction === "approved" ? "Approved" : "Rejected"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Missing Demo Section */}
      {!submitted && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Missing a Demo?</CardTitle>
            <p className="text-xs text-gray-500">If you booked a demo this week that&apos;s not listed above, let us know.</p>
          </CardHeader>
          <CardContent>
            {/* Pending missing drafts */}
            {missingDrafts.map((draft, idx) => (
              <div key={idx} className="flex items-center justify-between p-2 mb-2 rounded bg-orange-50 border border-orange-200">
                <div>
                  <p className="text-sm font-medium">{draft.missingProspectName}</p>
                  <p className="text-xs text-gray-500">
                    {draft.missingProspectEmail && <span>{draft.missingProspectEmail} &middot; </span>}
                    {draft.missingDemoDate && <span>~{draft.missingDemoDate}</span>}
                  </p>
                </div>
                <button onClick={() => removeMissingDraft(idx)} className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
            ))}

            {showMissingForm ? (
              <div className="space-y-2 mt-2">
                <input
                  value={missingName}
                  onChange={e => setMissingName(e.target.value)}
                  placeholder="Prospect name *"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={missingEmail}
                  onChange={e => setMissingEmail(e.target.value)}
                  placeholder="Prospect email"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={missingDate}
                  onChange={e => setMissingDate(e.target.value)}
                  placeholder="Approx date & time (e.g. Thursday 3pm)"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={missingNote}
                  onChange={e => setMissingNote(e.target.value)}
                  placeholder="Additional notes (optional)"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={addMissingDraft} disabled={!missingName.trim()}>
                    Add to Report
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowMissingForm(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setShowMissingForm(true)} className="mt-1">
                + Report Missing Demo
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Submit */}
      {!submitted && (
        <div className="sticky bottom-4">
          <Button
            className="w-full py-6 text-base font-semibold"
            disabled={!allAccountedFor || submitting}
            onClick={handleSubmit}
          >
            {submitting
              ? "Submitting..."
              : flagDrafts.size > 0 || missingDrafts.length > 0
                ? `Submit Confirmation (${flagDrafts.size + missingDrafts.length} flagged)`
                : "Confirm All Correct"}
          </Button>
          {!allAccountedFor && unlockedActionable.length > 0 && (
            <p className="text-xs text-center text-gray-500 mt-2">
              {unlockedActionable.length - confirmedIds.size - flagDrafts.size} demo(s) still need to be confirmed or flagged
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// === Demo Row Component ===

function DemoRow({
  demo,
  isConfirmed,
  hasFlagDraft,
  flagDraft,
  isFlagOpen,
  submitted,
  onToggleConfirm,
  onToggleFlag,
  onSaveFlag,
  onRemoveFlag,
}: {
  demo: DemoItem;
  isConfirmed: boolean;
  hasFlagDraft: boolean;
  flagDraft?: FlagDraft;
  isFlagOpen: boolean;
  submitted: boolean;
  onToggleConfirm: () => void;
  onToggleFlag: () => void;
  onSaveFlag: (type: "wrong_status" | "not_mine", note: string) => void;
  onRemoveFlag: () => void;
}) {
  const [flagType, setFlagType] = useState<"wrong_status" | "not_mine">("wrong_status");
  const [flagNote, setFlagNote] = useState("");

  const hasExistingFlag = !!demo.existingFlag;
  const isLocked = demo.isLocked;
  const isActionable = !isLocked && !hasExistingFlag && !submitted;

  return (
    <div className={`p-3 rounded-lg border transition-colors ${
      isLocked ? "bg-gray-50 border-gray-200 opacity-60" :
      hasExistingFlag ? "bg-orange-50 border-orange-200" :
      isConfirmed ? "bg-green-50 border-green-200" :
      hasFlagDraft ? "bg-orange-50 border-orange-200" :
      "bg-white border-gray-200"
    }`}>
      <div className="flex items-center gap-3">
        {/* Checkbox / Status indicator */}
        <div className="flex-shrink-0 w-8">
          {isLocked ? (
            <span className="text-gray-400 text-lg" title="Day locked">🔒</span>
          ) : hasExistingFlag ? (
            <span className="text-orange-500 text-lg" title="Flagged">🚩</span>
          ) : hasFlagDraft ? (
            <span className="text-orange-500 text-lg" title="Will be flagged">🚩</span>
          ) : isConfirmed ? (
            <button onClick={isActionable ? onToggleConfirm : undefined} className={isActionable ? "cursor-pointer" : ""}>
              <span className="text-green-600 text-lg">✓</span>
            </button>
          ) : isActionable ? (
            <button onClick={onToggleConfirm} className="w-5 h-5 border-2 border-gray-300 rounded hover:border-green-400 transition-colors" />
          ) : (
            <span className="text-gray-300 text-lg">—</span>
          )}
        </div>

        {/* Demo info */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{demo.prospectName}</p>
          <p className="text-xs text-gray-500">
            {formatDate(demo.demoDate)}
            {demo.closer && <span> &middot; w/ {demo.closer}</span>}
          </p>
        </div>

        {/* Status badge */}
        <div className="flex-shrink-0">
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${STATUS_COLORS[demo.status] || "bg-gray-100 text-gray-600"}`}>
            {STATUS_LABELS[demo.status] || demo.status}
          </span>
        </div>

        {/* Flag button */}
        {isActionable && !isConfirmed && !hasFlagDraft && (
          <button
            onClick={onToggleFlag}
            className="flex-shrink-0 text-xs text-gray-400 hover:text-orange-500 transition-colors"
            title="Flag an issue"
          >
            Flag
          </button>
        )}

        {/* Remove flag draft */}
        {hasFlagDraft && isActionable && (
          <button onClick={onRemoveFlag} className="flex-shrink-0 text-xs text-red-400 hover:text-red-600">
            Remove
          </button>
        )}
      </div>

      {/* Existing flag info */}
      {hasExistingFlag && (
        <div className="mt-2 ml-11 text-xs">
          <span className="text-orange-700">
            {demo.existingFlag!.ceoAction === "pending" ? "Under review" :
             demo.existingFlag!.ceoAction === "approved" ? "Approved" : "Rejected"}
            {demo.existingFlag!.note && ` — "${demo.existingFlag!.note}"`}
          </span>
        </div>
      )}

      {/* Flag draft info */}
      {hasFlagDraft && flagDraft && (
        <div className="mt-2 ml-11 text-xs text-orange-700">
          {flagDraft.flagType === "wrong_status" ? "Wrong status" : "Not my booking"}
          {flagDraft.note && ` — "${flagDraft.note}"`}
        </div>
      )}

      {/* Flag form */}
      {isFlagOpen && (
        <div className="mt-3 ml-11 space-y-2 p-3 bg-gray-50 rounded-lg">
          <div className="flex gap-2">
            <button
              onClick={() => setFlagType("wrong_status")}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                flagType === "wrong_status" ? "bg-orange-100 border-orange-300 text-orange-700" : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              Wrong status
            </button>
            <button
              onClick={() => setFlagType("not_mine")}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                flagType === "not_mine" ? "bg-orange-100 border-orange-300 text-orange-700" : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              Not my booking
            </button>
          </div>
          <input
            value={flagNote}
            onChange={e => setFlagNote(e.target.value)}
            placeholder={flagType === "wrong_status" ? 'e.g. "This showed, not no-show"' : 'e.g. "This was booked by Luke"'}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { onSaveFlag(flagType, flagNote); setFlagNote(""); }}>
              Save Flag
            </Button>
            <Button size="sm" variant="outline" onClick={onToggleFlag}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
