// Claude rewrite of the Fireflies first-call summary into a short,
// prospect-facing recap paragraph in the closer's voice. Raw fetch against the
// Messages API (repo convention — every integration here is bare fetch).
// Returns null on ANY failure or guard trip; the caller falls back to the
// no-recap email variant. Never blocks the sequence on AI availability.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Most capable Opus-tier model; volume is a handful of reconnects/day so cost
// is negligible and quality matters — this email goes to a hot prospect.
const MODEL = "claude-opus-4-8";
const MAX_OUTPUT_CHARS = 320;

function systemPrompt(closerFirst: string, prospectFirst: string): string {
  return (
    `You write ONE super-brief recap line on behalf of ${closerFirst}, a sales rep at Grassfed ` +
    `(done-for-you cold-email marketing for real estate agents), to the prospect ${prospectFirst} after their first call, ` +
    `ahead of a second call they booked. Rewrite the meeting summary the user provides into AT MOST two short sentences ` +
    `(under 35 words total) in ${closerFirst}'s casual first-person voice: the single main thing you two talked about, and ` +
    `what the next call will nail down. Sound like a quick note typed between calls, not marketing copy. Rules: use ONLY ` +
    `facts present in the summary — never invent numbers, names, or commitments; skip anything internal or awkward to repeat ` +
    `(pricing negotiation, objections, hesitations, competitor mentions, team talk); never address the prospect by name — ` +
    `the email template already greets them; no greeting, no sign-off, no subject line — output the sentence(s) only.`
  );
}

interface AnthropicResponse {
  stop_reason?: string;
  content?: { type: string; text?: string }[];
}

export async function rewriteRecap(
  summary: string,
  prospectFirst: string,
  closerFirst: string
): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(closerFirst, prospectFirst),
        messages: [{ role: "user", content: summary }],
      }),
    });
    if (!res.ok) {
      console.error(`recap rewrite: anthropic ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as AnthropicResponse;
    if (data.stop_reason === "refusal") return null;
    const text = (data.content || [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text || text.length > MAX_OUTPUT_CHARS) return null;

    // Hallucination guard: any dollar amount in the output must literally
    // appear in the source summary — invented numbers kill the whole email.
    const amounts = text.match(/\$[\d,]+(?:\.\d+)?/g) || [];
    for (const amt of amounts) {
      if (!summary.includes(amt)) return null;
    }
    return text;
  } catch (err) {
    console.error("recap rewrite failed:", err);
    return null;
  }
}
