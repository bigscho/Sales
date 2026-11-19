/**
 * One-time closer backfill from Fireflies transcripts.
 *
 * Credits Colin or Matthew from the recording. Does not guess when both
 * spoke, neither can be identified, or the recording is silent / about a
 * minute. Those rows are listed and, on --apply, flagged for review with
 * closerId left unchanged.
 *
 * Dry-run is the default. Nothing is written unless --apply is passed.
 *
 * Prerequisites (do these yourself; this script does not migrate):
 *   1. Apply prisma/migrations/20261119190000_demo_closer_source/migration.sql
 *   2. DATABASE_URL and FIREFLIES_API_KEY in the environment.
 *      FIREFLIES_API_KEY may be comma-separated; each key is tried.
 *      The key is never printed.
 *
 *   npx tsx scripts/backfill-closer-from-transcript.ts
 *   npx tsx scripts/backfill-closer-from-transcript.ts --since 2026-01-01
 *   npx tsx scripts/backfill-closer-from-transcript.ts --limit 50
 *   npx tsx scripts/backfill-closer-from-transcript.ts --apply
 *
 * Rows a person already reassigned (closerSource = manual, or a
 * closer_reassigned audit) are reported and not overwritten.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { applyTranscriptCloser, planTranscriptCloser } from "../src/lib/apply-transcript-closer";
import type { TranscriptForCloser } from "../src/lib/closer-from-transcript";

const FIREFLIES_GQL = "https://api.fireflies.ai/graphql";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

async function fetchTranscript(apiKeys: string[], id: string): Promise<TranscriptForCloser | null> {
  const query = `
    query($id: String!) {
      transcript(id: $id) {
        id
        title
        duration
        organizer_email
        participants
        speakers { name }
        sentences { text speaker_name start_time end_time }
        meeting_info { summary_status silent_meeting }
      }
    }
  `;
  for (const key of apiKeys) {
    const res = await fetch(FIREFLIES_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ query, variables: { id } }),
    });
    if (!res.ok) continue;
    const data = await res.json();
    const transcript = data?.data?.transcript;
    if (transcript) return transcript as TranscriptForCloser;
  }
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sinceRaw = argValue("--since");
  const limitRaw = argValue("--limit");
  const limit = limitRaw ? Number(limitRaw) : 500;
  if (!Number.isFinite(limit) || limit < 1) {
    console.error("--limit must be a positive number");
    process.exit(1);
  }
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && Number.isNaN(since.getTime())) {
    console.error("--since must be YYYY-MM-DD");
    process.exit(1);
  }

  const apiKeyEnv = process.env.FIREFLIES_API_KEY;
  if (!apiKeyEnv) {
    console.error("FIREFLIES_API_KEY is not set");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const apiKeys = apiKeyEnv.split(",").map((k) => k.trim()).filter(Boolean);

  console.log(apply ? "APPLY — writing closer credit" : "DRY RUN — no rows will be written");

  const demos = await prisma.demo.findMany({
    where: {
      firefliesTranscriptId: { not: null },
      ...(since ? { booking: { demoDate: { gte: since } } } : {}),
    },
    select: {
      id: true,
      firefliesTranscriptId: true,
      closerId: true,
      closerSource: true,
      closerReviewReason: true,
      closer: { select: { name: true } },
      booking: { select: { prospectName: true, demoDate: true } },
    },
    orderBy: { booking: { demoDate: "desc" } },
    take: limit,
  });

  let wouldChange = 0;
  let flagged = 0;
  let unchanged = 0;
  let missing = 0;

  for (const demo of demos) {
    const transcriptId = demo.firefliesTranscriptId;
    if (!transcriptId) continue;
    const transcript = await fetchTranscript(apiKeys, transcriptId);
    if (!transcript) {
      missing++;
      console.log(`${demo.id}\t${demo.booking.demoDate.toISOString().slice(0, 10)}\t${demo.booking.prospectName}\ttranscript_not_fetched`);
      continue;
    }

    const plan = apply
      ? await applyTranscriptCloser(demo.id, transcript, "closer_backfill")
      : await planTranscriptCloser(demo.id, transcript);
    if (!plan) {
      missing++;
      continue;
    }

    const nextCloser = plan.closerId;
    const changed = plan.changeCloser || (demo.closerReviewReason ?? null) !== plan.closerReviewReason || (demo.closerSource ?? null) !== plan.closerSource;
    if (plan.changeCloser) wouldChange++;
    else if (plan.closerReviewReason) flagged++;
    else unchanged++;

    if (changed) {
      console.log(
        [
          demo.id,
          demo.booking.demoDate.toISOString().slice(0, 10),
          demo.booking.prospectName,
          demo.closer?.name || "—",
          plan.changeCloser ? `-> ${nextCloser}` : "closer unchanged",
          plan.closerSource || "—",
          plan.closerReviewReason || "—",
          apply && "wrote" in plan && plan.wrote ? "wrote" : "planned",
        ].join("\t")
      );
    }
  }

  console.log(
    `Checked ${demos.length}. Closer changes: ${wouldChange}. Review flags: ${flagged}. Unchanged: ${unchanged}. Transcript missing: ${missing}.`
  );
  if (!apply) console.log("Dry run only. Re-run with --apply to write.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : "";
    const safe = /postgres|password|api[_-]?key|bearer|secret|token|:\/\//i.test(message)
      ? "backfill failed"
      : message || "backfill failed";
    console.error(safe);
    await prisma.$disconnect();
    process.exit(1);
  });
