import assert from "node:assert/strict";
import test from "node:test";
import { beginSend, finishSend, UNCERTAIN_MESSAGE } from "./send-run";

test("a lost request stays locked and does not start another send", () => {
  const started = beginSend({ phase: "idle" }, ["b1", "b2"]);
  assert.equal(started.start, true);
  assert.equal(started.state.phase, "running");

  const again = beginSend(started.state, ["b1"]);
  assert.equal(again.start, false);
  assert.equal(again.state.phase, "running");

  const lost = finishSend(started.state, "lost");
  assert.equal(lost.phase, "uncertain");
  assert.equal(lost.phase === "uncertain" && lost.message, UNCERTAIN_MESSAGE);
  const retried = beginSend(lost, ["b1", "b2"]);
  assert.equal(retried.start, false);
  assert.equal(retried.state.phase, "uncertain");
});

test("a completed request can send again, and an empty batch cannot start", () => {
  const started = beginSend({ phase: "idle" }, ["b1"]);
  const done = finishSend(started.state, "completed");
  assert.deepEqual(done, { phase: "idle" });
  assert.equal(beginSend(done, []).start, false);
  assert.equal(beginSend(done, ["b2"]).start, true);
});
