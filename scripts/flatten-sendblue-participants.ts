/**
 * One-time repair for SendblueGroup.participants rows that accumulated nested
 * copies of the same roster. Safe to re-run: flat rows are skipped.
 *
 *   npx tsx scripts/flatten-sendblue-participants.ts
 */
import { flattenNestedParticipantRows } from "../src/lib/confirmations/worklist";

async function main() {
  const line = process.env.SENDBLUE_LINE_NUMBER || "";
  let total = 0;
  for (;;) {
    const updated = await flattenNestedParticipantRows(line, 50);
    total += updated;
    if (updated === 0) break;
  }
  console.log(`Flattened participants on ${total} SendBlue group(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
