// Client lock for the confirmations Send buttons.
// A lost response (timeout, non-JSON, HTTP error) stays "uncertain":
// the page does not re-enable the buttons and does not send again.

export type SendRunPhase =
  | { phase: "idle" }
  | { phase: "running"; bookingIds: string[] }
  | { phase: "uncertain"; bookingIds: string[]; message: string };

export const UNCERTAIN_MESSAGE =
  "The send request did not return. Buttons stay off so this page cannot start another batch. Check status reloads what the server already claimed — it does not send.";

/** Start a run only from idle. A second click or a lost run returns start: false.
 *  A second browser tab has its own memory; the database claim is what stops it. */
export function beginSend(
  state: SendRunPhase,
  bookingIds: string[]
): { state: SendRunPhase; start: boolean } {
  if (state.phase !== "idle" || bookingIds.length === 0) return { state, start: false };
  return { state: { phase: "running", bookingIds }, start: true };
}

export function finishSend(state: SendRunPhase, outcome: "completed" | "lost"): SendRunPhase {
  if (outcome === "completed") return { phase: "idle" };
  if (state.phase === "running") {
    return { phase: "uncertain", bookingIds: state.bookingIds, message: UNCERTAIN_MESSAGE };
  }
  return state;
}
