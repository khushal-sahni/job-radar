import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffHours, emptyDailyState, isStepDue, recordStep } from "./daily-state";

const HOUR = 60 * 60 * 1000;

describe("daily steps", () => {
  it("runs a step that never ran", () => {
    assert.equal(isStepDue(emptyDailyState().ingest, Date.now()), true);
  });

  it("skips a step that succeeded within 20 hours", () => {
    const now = Date.now();
    const done = recordStep(emptyDailyState().apply, now - 5 * HOUR, { ok: true, summary: "" });
    assert.equal(isStepDue(done, now), false);
    assert.equal(isStepDue(done, now + 16 * HOUR), true);
  });

  it("retries a failed step with growing backoff", () => {
    const now = Date.now();
    let step = recordStep(emptyDailyState().naukri, now, { ok: false, summary: "Postgres down" });
    assert.equal(isStepDue(step, now + 0.5 * HOUR), false);
    assert.equal(isStepDue(step, now + HOUR), true);
    step = recordStep(step, now + HOUR, { ok: false, summary: "again" });
    assert.equal(step.failures, 2);
    assert.equal(isStepDue(step, now + 2.5 * HOUR), false);
    assert.equal(isStepDue(step, now + 3 * HOUR), true);
  });

  it("caps the backoff at 6 hours and clears it on success", () => {
    assert.deepEqual([1, 2, 3, 4, 9].map(backoffHours), [1, 2, 4, 6, 6]);
    const failed = { ...emptyDailyState().ingest, failures: 5, lastAttemptAt: 0 };
    const ok = recordStep(failed, 10, { ok: true, summary: "fine" });
    assert.equal(ok.failures, 0);
    assert.equal(ok.ok, true);
  });

  it("a failure keeps the last success time", () => {
    const ok = recordStep(emptyDailyState().ingest, 100, { ok: true, summary: "" });
    const failed = recordStep(ok, 200, { ok: false, summary: "x" });
    assert.equal(failed.lastSuccessAt, 100);
  });
});
