// Rep nudges — sent as an iMessage from the SendBlue line to the show-rate
// rep's phone. The AI Agent line can only reply to numbers that have texted
// it first, so ONE-TIME SETUP: the rep texts the line (SENDBLUE_LINE_NUMBER)
// once from their phone; from then on the line can nudge them daily.
//
// There is no fallback. If CONFIRMATIONS_REP_PHONE is unset, or SendBlue
// fails, the nudge is logged and dropped.
import { isLive, sendMessage } from "@/lib/sendblue";

/** The show-rate rep's phone (E.164). They must have texted the line once. */
function repPhone(): string | undefined {
  const phone = process.env.CONFIRMATIONS_REP_PHONE?.trim();
  return phone || undefined;
}

export async function nudgeRep(text: string): Promise<"sendblue" | "none"> {
  const phone = repPhone();
  if (!phone) {
    console.warn("CONFIRMATIONS_REP_PHONE not set, skipping rep nudge");
    return "none";
  }
  // Same kill switch as prospect texts. A nudge is still a Sendblue call.
  if (!isLive()) {
    console.log("confirmation rep nudge dry-run (SENDBLUE_LIVE is not true)");
    return "none";
  }
  try {
    await sendMessage({ number: phone, content: text });
    return "sendblue";
  } catch (err) {
    console.error("SendBlue rep nudge failed:", err);
    return "none";
  }
}
