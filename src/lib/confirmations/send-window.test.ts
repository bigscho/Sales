import assert from "node:assert/strict";
import test from "node:test";
import { formatDemoTime } from "./copy";
import { checkSendWindow, resolveProspectTz, isNanpPhone, hourIn } from "./send-window";

const US = "+13105551234";
// 2026-07-15 is DST: PT = UTC-7, ET = UTC-4, CT = UTC-5.
const at = (utc: string) => new Date(`2026-07-15T${utc}:00Z`);

test("trusted zone: 8:00 AM local is the first allowed minute", () => {
  assert.equal(checkSendWindow("America/Los_Angeles", US, at("14:59")).ok, false); // 7:59 PT
  assert.equal(checkSendWindow("America/Los_Angeles", US, at("15:00")).ok, true); // 8:00 PT
});

test("trusted zone: 7:59 PM ok, 8:00 PM blocked", () => {
  assert.equal(checkSendWindow("America/Los_Angeles", US, at("02:59")).ok, true); // 7:59 PM PT (Jul 14)
  assert.equal(checkSendWindow("America/Los_Angeles", US, at("03:00")).ok, false); // 8:00 PM PT
});

test("3:49 AM PT (the bug) is blocked and retried at 8:00 AM PT", () => {
  // Summer offset, same as the July boundary tests above.
  const w = checkSendWindow("America/Los_Angeles", US, at("10:49")); // 3:49 AM PT
  assert.equal(w.ok, false);
  assert.equal(w.trusted, true);
  assert.equal(w.localHour, 3);
  assert.equal(w.retryAt.toISOString(), "2026-07-15T15:00:00.000Z");
});

test("2026-10-23 3:49 AM Pacific incident is blocked until 8:00 AM PT", () => {
  // Oct 23 2026 is still PDT (DST ends Nov 1). 10:49 UTC = 3:49 AM PT.
  const w = checkSendWindow("America/Los_Angeles", US, new Date("2026-10-23T10:49:00Z"));
  assert.equal(w.ok, false);
  assert.equal(w.trusted, true);
  assert.equal(w.localHour, 3);
  assert.equal(w.retryAt.toISOString(), "2026-10-23T15:00:00.000Z"); // 8:00 AM PDT
});

test("window is per prospect zone, not the rep's clock", () => {
  // 12:00 UTC = 8 AM ET ok, 5 AM PT blocked
  assert.equal(checkSendWindow("America/New_York", US, at("12:00")).ok, true);
  assert.equal(checkSendWindow("America/Los_Angeles", US, at("12:00")).ok, false);
});

test("retryAt is `now` when in window", () => {
  const now = at("17:20");
  const w = checkSendWindow("America/New_York", US, now);
  assert.equal(w.ok, true);
  assert.equal(w.retryAt.getTime(), now.getTime());
});

test("US phone + non-American zone is untrusted and resolves to ET", () => {
  const r = resolveProspectTz("Europe/London", US);
  assert.deepEqual(r, { tz: "America/New_York", trusted: false });
  assert.deepEqual(resolveProspectTz("Etc/GMT-1", US), { tz: "America/New_York", trusted: false });
  assert.deepEqual(resolveProspectTz("GMT+1", US), { tz: "America/New_York", trusted: false });
});

test("non-US phone keeps its zone; missing/invalid zones are untrusted", () => {
  assert.deepEqual(resolveProspectTz("Europe/London", "+447700900123"), { tz: "Europe/London", trusted: true });
  assert.equal(resolveProspectTz(null, US).trusted, false);
  assert.equal(resolveProspectTz("", US).trusted, false);
  assert.equal(resolveProspectTz("Not/AZone", US).trusted, false);
  assert.equal(resolveProspectTz("America/Los_Angeles", US).trusted, true);
  assert.equal(resolveProspectTz("Pacific/Honolulu", US).trusted, true);
  assert.equal(resolveProspectTz("US/Pacific", US).trusted, true);
});

test("non-US phone is gated on its own local hour", () => {
  // 02:49 UTC on Jul 15 = 3:49 AM BST. Trusted London zone, still quiet hours.
  const w = checkSendWindow("Europe/London", "+447700900123", new Date("2026-07-15T02:49:00Z"));
  assert.equal(w.trusted, true);
  assert.equal(w.localHour, 3);
  assert.equal(w.ok, false);
});

test("isNanpPhone", () => {
  assert.equal(isNanpPhone("(310) 555-1234"), true);
  assert.equal(isNanpPhone("+1 310 555 1234"), true);
  assert.equal(isNanpPhone("+447700900123"), false);
  assert.equal(isNanpPhone(null), false);
});

test("fallback window: 11:00 AM ET inclusive .. 8:00 PM ET exclusive", () => {
  assert.equal(checkSendWindow(null, US, at("14:59")).ok, false); // 10:59 ET
  assert.equal(checkSendWindow(null, US, at("15:00")).ok, true); // 11:00 ET = 8:00 PT
  assert.equal(checkSendWindow(null, US, at("23:59")).ok, true); // 7:59 PM ET
  assert.equal(checkSendWindow(null, US, at("00:00")).ok, false); // 8:00 PM ET
  assert.equal(checkSendWindow(null, US, at("00:00")).trusted, false);
});

test("fallback window is inside 8 AM-8 PM in every contiguous-US zone", () => {
  const zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"];
  for (const month of [0, 6]) {
    // January (standard) and July (daylight). Phoenix does not observe DST.
    for (let h = 0; h < 24; h++) {
      const now = new Date(Date.UTC(2026, month, 15, h, 30));
      const w = checkSendWindow("Europe/London", US, now);
      if (w.ok) {
        for (const z of zones) {
          const lh = hourIn(z, now);
          assert.ok(lh >= 8 && lh < 20, `${z} local hour ${lh} at ${now.toISOString()}`);
        }
      }
    }
  }
});

test("fallback retryAt lands on 11:00 AM ET", () => {
  const w = checkSendWindow(null, US, at("06:30")); // 2:30 AM ET
  assert.equal(w.ok, false);
  assert.equal(w.retryAt.toISOString(), "2026-07-15T15:00:00.000Z");
});

test("DST: winter PT 8 AM is 16:00 UTC, summer PT 8 AM is 15:00 UTC", () => {
  assert.equal(checkSendWindow("America/Los_Angeles", US, new Date("2026-01-15T15:59:00Z")).ok, false);
  assert.equal(checkSendWindow("America/Los_Angeles", US, new Date("2026-01-15T16:00:00Z")).ok, true);
  assert.equal(checkSendWindow("America/Los_Angeles", US, new Date("2026-07-15T14:59:00Z")).ok, false);
  assert.equal(checkSendWindow("America/Los_Angeles", US, new Date("2026-07-15T15:00:00Z")).ok, true);
});

test("DST fall-back hour still resolves and stays blocked", () => {
  // 2026-11-01: 1:30 AM PDT (08:30Z) and the repeated 1:30 AM PST (09:30Z).
  const pdt = checkSendWindow("America/Los_Angeles", US, new Date("2026-11-01T08:30:00Z"));
  const pst = checkSendWindow("America/Los_Angeles", US, new Date("2026-11-01T09:30:00Z"));
  assert.equal(pdt.localHour, 1);
  assert.equal(pst.localHour, 1);
  assert.equal(pdt.ok, false);
  assert.equal(pst.ok, false);
});

test("US number never renders a foreign zone like GMT+1", () => {
  // The incident label: 23:00 UTC is 12:00 AM GMT+1 in London (BST) on Oct 22.
  const demo = new Date("2026-10-22T23:00:00Z");
  assert.equal(formatDemoTime(demo, "Europe/London", "+13105551234"), "7:00 PM EDT");
  assert.equal(formatDemoTime(demo, "Etc/GMT-1", "(310) 555-1234"), "7:00 PM EDT");
  assert.equal(formatDemoTime(demo, "Not/AZone", US), "7:00 PM EDT");
});

test("trusted zone still renders in the prospect's zone", () => {
  const demo = new Date("2026-10-23T15:00:00Z"); // 8:00 AM PDT
  assert.equal(formatDemoTime(demo, "America/Los_Angeles", US), "8:00 AM PDT");
  // A real London prospect keeps the foreign label.
  const london = new Date("2026-10-22T23:00:00Z");
  assert.equal(formatDemoTime(london, "Europe/London", "+447700900123"), "12:00 AM GMT+1");
});
