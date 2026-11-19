// Credit Colin or Matthew from a Fireflies transcript.
//
// The calendar owner is not evidence of who ran the call. Speaker names and
// talk time are. Organizer and participant emails count only when they are a
// personal closer address (colin@grsfd.co, matthew@grsfd.co, or the closer's
// own TeamMember email) — never colin@grassfed.tech or admin@grassfed.tech.
//
// Ambiguous recordings do not pick a winner:
//   both_on_call     — both closers actually spoke, or both were on the invite
//                      and nobody was labeled
//   unidentified     — no closer could be tied to the conversation
//   silent_or_short  — Fireflies marked it silent, or it is about a minute

import {
  isSharedDemoCalendarEmail,
  provisionalCloserFirstName,
} from "./demo-calendars";

export const CLOSER_SOURCE_CALENDAR = "calendar";
export const CLOSER_SOURCE_TRANSCRIPT = "transcript";
export const CLOSER_SOURCE_MANUAL = "manual";

export const REVIEW_BOTH_ON_CALL = "both_on_call";
export const REVIEW_UNIDENTIFIED = "unidentified";
export const REVIEW_SILENT_OR_SHORT = "silent_or_short";
export const REVIEW_DAY_LOCKED = "day_locked";
export const REVIEW_MANUAL_OVERRIDE = "manual_override";

const TALK_SECONDS = 10;
const TALK_SENTENCES = 3;
const SHORT_MINUTES = 1;

export type CloserCandidate = {
  id: string;
  name: string;
  email?: string | null;
};

export type TranscriptSentence = {
  text?: string | null;
  speaker_name?: string | null;
  speaker_id?: number | null;
  start_time?: number | null;
  end_time?: number | null;
};

export type TranscriptForCloser = {
  /** Fireflies meeting length in minutes. */
  duration?: number | null;
  organizer_email?: string | null;
  participants?: (string | null)[] | null;
  speakers?: { name?: string | null }[] | null;
  sentences?: TranscriptSentence[] | null;
  meeting_info?: { silent_meeting?: boolean | null; summary_status?: string | null } | null;
};

export type CloserAttribution =
  | { kind: "assigned"; closerId: string; share: number }
  | { kind: "ambiguous"; reason: typeof REVIEW_BOTH_ON_CALL | typeof REVIEW_UNIDENTIFIED | typeof REVIEW_SILENT_OR_SHORT };

export type CloserDecision = {
  closerId: string | null;
  closerSource: string | null;
  closerReviewReason: string | null;
  detectedCloserId: string | null;
  detectedCloserShare: number | null;
  /** True when closerId should move to a different person. */
  changeCloser: boolean;
};

type Talk = { seconds: number; sentences: number };

export function isRecordingCloserName(name: string | null | undefined): boolean {
  const first = firstName(name || "");
  return first === "colin" || first === "matthew";
}

export function closerReviewLabel(reason: string | null | undefined): string | null {
  switch (reason) {
    case REVIEW_BOTH_ON_CALL:
      return "Both closers on the call";
    case REVIEW_UNIDENTIFIED:
      return "Closer not in the recording";
    case REVIEW_SILENT_OR_SHORT:
      return "Recording too short to credit";
    case REVIEW_DAY_LOCKED:
      return "Day locked — recording disagrees";
    case REVIEW_MANUAL_OVERRIDE:
      return "Recording disagrees with the manual closer";
    default:
      return null;
  }
}

export function attributeCloserFromTranscript(
  transcript: TranscriptForCloser,
  closers: CloserCandidate[]
): CloserAttribution {
  const candidates = closers.filter((c) => isRecordingCloserName(c.name));
  if (isSilentOrShort(transcript)) {
    return { kind: "ambiguous", reason: REVIEW_SILENT_OR_SHORT };
  }
  if (candidates.length === 0) {
    return { kind: "ambiguous", reason: REVIEW_UNIDENTIFIED };
  }

  const sentences = transcript.sentences || [];
  const anyTiming = sentences.some(
    (s) => typeof s.start_time === "number" && typeof s.end_time === "number" && s.end_time > s.start_time
  );
  const talk = new Map<string, Talk>();

  for (const sentence of sentences) {
    const speaker = sentence.speaker_name?.trim();
    if (!speaker) continue;
    const closer = matchSpeaker(speaker, candidates);
    if (!closer) continue;
    const bucket = talk.get(closer.id) || { seconds: 0, sentences: 0 };
    bucket.sentences += 1;
    if (
      typeof sentence.start_time === "number" &&
      typeof sentence.end_time === "number" &&
      sentence.end_time > sentence.start_time
    ) {
      bucket.seconds += sentence.end_time - sentence.start_time;
    }
    talk.set(closer.id, bucket);
  }

  const present = [...talk.entries()].filter(([, t]) => spokeEnough(t, anyTiming));
  if (present.length >= 2) {
    return { kind: "ambiguous", reason: REVIEW_BOTH_ON_CALL };
  }
  if (present.length === 1) {
    const [id, mine] = present[0];
    const total = anyTiming
      ? [...talk.values()].reduce((sum, t) => sum + t.seconds, 0)
      : [...talk.values()].reduce((sum, t) => sum + t.sentences, 0);
    const mineValue = anyTiming ? mine.seconds : mine.sentences;
    const share = total > 0 ? roundShare(mineValue / total) : 1;
    return { kind: "assigned", closerId: id, share };
  }

  // Nobody was labeled as Colin or Matthew. A single personal closer email
  // can still identify them when the recording is a real conversation and
  // diarization failed. Two closer emails, or only a shared calendar address,
  // is not a guess we will make.
  if (!looksLikeRealCall(transcript)) {
    return { kind: "ambiguous", reason: REVIEW_UNIDENTIFIED };
  }
  const fromEmails = closersOnInvite(transcript, candidates);
  if (fromEmails.length >= 2) {
    return { kind: "ambiguous", reason: REVIEW_BOTH_ON_CALL };
  }
  if (fromEmails.length === 1) {
    return { kind: "assigned", closerId: fromEmails[0].id, share: 1 };
  }
  return { kind: "ambiguous", reason: REVIEW_UNIDENTIFIED };
}

export function decideCloserUpdate(args: {
  currentCloserId: string | null;
  closerSource: string | null;
  humanReassigned: boolean;
  dayLocked: boolean;
  attribution: CloserAttribution;
}): CloserDecision {
  const manual = args.closerSource === CLOSER_SOURCE_MANUAL || args.humanReassigned;
  const currentSource = manual ? CLOSER_SOURCE_MANUAL : args.closerSource;

  if (args.attribution.kind === "ambiguous") {
    return {
      closerId: args.currentCloserId,
      closerSource: currentSource,
      closerReviewReason: args.attribution.reason,
      detectedCloserId: null,
      detectedCloserShare: null,
      changeCloser: false,
    };
  }

  const nextId = args.attribution.closerId;
  const share = args.attribution.share;
  if (manual) {
    const disagrees = nextId !== args.currentCloserId;
    return {
      closerId: args.currentCloserId,
      closerSource: CLOSER_SOURCE_MANUAL,
      closerReviewReason: disagrees ? REVIEW_MANUAL_OVERRIDE : null,
      detectedCloserId: nextId,
      detectedCloserShare: share,
      changeCloser: false,
    };
  }
  if (args.dayLocked && nextId !== args.currentCloserId) {
    return {
      closerId: args.currentCloserId,
      closerSource: args.closerSource,
      closerReviewReason: REVIEW_DAY_LOCKED,
      detectedCloserId: nextId,
      detectedCloserShare: share,
      changeCloser: false,
    };
  }
  return {
    closerId: nextId,
    closerSource: CLOSER_SOURCE_TRANSCRIPT,
    closerReviewReason: null,
    detectedCloserId: nextId,
    detectedCloserShare: share,
    changeCloser: nextId !== args.currentCloserId,
  };
}

function isSilentOrShort(transcript: TranscriptForCloser): boolean {
  if (transcript.meeting_info?.silent_meeting === true) return true;
  const duration = transcript.duration;
  return typeof duration === "number" && duration >= 0 && duration <= SHORT_MINUTES;
}

function looksLikeRealCall(transcript: TranscriptForCloser): boolean {
  const substantive = (transcript.sentences || []).filter((s) => (s.text || "").trim().length > 5);
  if (substantive.length >= 6) return true;
  return typeof transcript.duration === "number" && transcript.duration >= 5;
}

function spokeEnough(talk: Talk, anyTiming: boolean): boolean {
  if (anyTiming) return talk.seconds >= TALK_SECONDS;
  return talk.sentences >= TALK_SENTENCES;
}

function matchSpeaker(speakerName: string, closers: CloserCandidate[]): CloserCandidate | null {
  const nm = speakerName.trim().toLowerCase();
  const nmFirst = firstName(nm);
  if (nmFirst !== "colin" && nmFirst !== "matthew") return null;
  const matches = closers.filter((c) => {
    const full = c.name.trim().toLowerCase();
    return full === nm || firstName(full) === nmFirst;
  });
  return matches.length === 1 ? matches[0] : null;
}

function closersOnInvite(transcript: TranscriptForCloser, closers: CloserCandidate[]): CloserCandidate[] {
  const emails = extractEmails([
    transcript.organizer_email,
    ...(transcript.participants || []),
  ]);
  const found = new Map<string, CloserCandidate>();
  for (const email of emails) {
    if (isSharedDemoCalendarEmail(email)) continue;
    const personal = provisionalCloserFirstName(email);
    if (personal) {
      const closer = closers.find((c) => firstName(c.name) === personal.toLowerCase());
      if (closer) found.set(closer.id, closer);
      continue;
    }
    const byTeamEmail = closers.filter((c) => c.email && c.email.trim().toLowerCase() === email);
    if (byTeamEmail.length === 1) found.set(byTeamEmail[0].id, byTeamEmail[0]);
  }
  return [...found.values()];
}

function extractEmails(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    if (!raw) continue;
    const matches = raw.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g);
    if (matches) out.push(...matches);
  }
  return out;
}

function firstName(name: string): string {
  return name.trim().toLowerCase().split(/\s+/)[0] || "";
}

function roundShare(n: number): number {
  return Math.round(n * 10000) / 10000;
}
