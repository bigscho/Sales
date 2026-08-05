// Rep nudges — sent as an iMessage from the SendBlue line to the show-rate
// rep's phone, NOT Slack. The AI Agent line can only reply to numbers that
// have texted it first, so ONE-TIME SETUP: the rep texts the line
// (SENDBLUE_LINE_NUMBER) once from their phone; from then on the line can
// nudge them daily.
//
// If the SendBlue nudge fails (or no rep number is configured), we fall back
// to #show-rate-tpds so the nudge never silently vanishes.
import { sendMessage } from "@/lib/sendblue";
import { sendSlackShowRate } from "@/lib/slack";

/** The show-rate rep's phone (E.164). They must have texted the line once. */
const REP_PHONE = process.env.CONFIRMATIONS_REP_PHONE;

export async function nudgeRep(text: string): Promise<"sendblue" | "slack" | "none"> {
  if (REP_PHONE) {
    try {
      // Nudges are operational, so they fire for real even in dry-run mode —
      // they only go to our own rep, never a prospect.
      await sendMessage({ number: REP_PHONE, content: text, live: true });
      return "sendblue";
    } catch (err) {
      console.error("SendBlue rep nudge failed, falling back to Slack:", err);
    }
  }
  try {
    await sendSlackShowRate(text);
    return "slack";
  } catch (err) {
    console.error("Slack nudge fallback failed:", err);
    return "none";
  }
}
