// Fetch the FIRST call's Fireflies summary for the reconnect recap email.
// Ladder: (a) the original demo's stored transcript id -> transcript(id:),
// (b) most recent transcript for the prospect's email within 14 days with
// duration > 2 min. Returns summary.short_summary or null. Never throws —
// a Fireflies hiccup must not block the sequence (caller falls back to the
// no-recap variant / retries next tick).

const FIREFLIES_GQL = "https://api.fireflies.ai/graphql";

interface RecapTranscript {
  id: string;
  date: number; // millisecond timestamp
  duration: number; // minutes
  summary: { short_summary: string | null } | null;
}

function apiKey(): string | null {
  // Comma-separated (same convention as the fireflies sync); the first key is
  // Colin's team-admin key which sees all members' transcripts.
  const raw = process.env.FIREFLIES_API_KEY;
  return raw ? raw.split(",")[0].trim() : null;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(FIREFLIES_GQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors?.length) return null;
    return json.data as T;
  } catch {
    return null;
  }
}

const SUMMARY_FIELDS = `id date duration summary { short_summary }`;

export async function fetchRecapSummary(
  transcriptId: string | null,
  prospectEmail: string | null
): Promise<string | null> {
  // (a) stored transcript id from the original demo
  if (transcriptId) {
    const data = await gql<{ transcript: RecapTranscript | null }>(
      `query Recap($id: String!) { transcript(id: $id) { ${SUMMARY_FIELDS} } }`,
      { id: transcriptId }
    );
    const summary = data?.transcript?.summary?.short_summary?.trim();
    if (summary) return summary;
  }

  // (b) search by participant email — most recent sane call within 14 days
  if (prospectEmail) {
    const data = await gql<{ transcripts: RecapTranscript[] | null }>(
      `query RecapByEmail($email: String!) { transcripts(participant_email: $email, limit: 5) { ${SUMMARY_FIELDS} } }`,
      { email: prospectEmail }
    );
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const candidate = (data?.transcripts || [])
      .filter((t) => t.date >= cutoff && t.duration > 2 && t.summary?.short_summary?.trim())
      .sort((a, b) => b.date - a.date)[0];
    if (candidate) return candidate.summary!.short_summary!.trim();
  }

  return null;
}
