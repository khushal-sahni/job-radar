import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterFeed } from "./feed-filter";
import { isQueueable, queueButtonLabel } from "./queue-state";
import { pastedRetry, transition } from "./apply/task-state";
import { fail, park, SUBMITTED, type TaskOutcome } from "./apply/outcome";
import { MANUAL_SOURCE, type JobMatch } from "./types";

function job(overrides: Partial<JobMatch>): JobMatch {
  return {
    id: "j",
    title: "Backend Engineer",
    company: "Acme",
    url: "https://jobs.lever.co/acme/1",
    location: null,
    country: null,
    isRemote: false,
    remoteScope: null,
    visaSponsorship: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryINRMin: null,
    salaryINRMax: null,
    salaryEstimated: false,
    salaryVerified: false,
    visaVerified: false,
    isBaseSalary: null,
    tags: [],
    source: "lever",
    postedAt: null,
    applicationStatus: null,
    statusUpdatedAt: null,
    queueStatus: null,
    queueCode: null,
    requiredYearsMin: null,
    requiredYearsMax: null,
    match: { matched: true, branchId: "germany", branchLabel: "Germany", reasons: [] },
    fitScore: 0,
    fitReasons: [],
    ...overrides,
  };
}

describe("queueing from the feed", () => {
  it("queues open jobs with no live task, and ones that failed on errors", () => {
    assert.equal(isQueueable(job({})), true);
    assert.equal(isQueueable(job({ queueStatus: "FAILED", queueCode: "error" })), true);
    for (const queueStatus of ["QUEUED", "IN_PROGRESS", "NEEDS_ANSWER", "NEEDS_YOU", "SUBMITTED"] as const) {
      assert.equal(isQueueable(job({ queueStatus })), false, queueStatus);
    }
  });

  it("leaves dismissed, closed and ineligible tasks failed", () => {
    assert.equal(isQueueable(job({ queueStatus: "FAILED", queueCode: "manual" })), false);
    assert.equal(isQueueable(job({ queueStatus: "FAILED", queueCode: "closed" })), false);
    assert.equal(isQueueable(job({ queueStatus: "FAILED", queueCode: "ineligible" })), false);
    assert.equal(queueButtonLabel(job({ queueStatus: "FAILED", queueCode: "closed" })), "Closed");
  });

  it("never queues a marked job or LinkedIn", () => {
    assert.equal(isQueueable(job({ applicationStatus: "saved" })), false);
    assert.equal(isQueueable(job({ url: "https://www.linkedin.com/jobs/view/1" })), false);
  });

  it("labels the card button by why it cannot queue", () => {
    assert.equal(queueButtonLabel(job({})), "Queue");
    assert.equal(queueButtonLabel(job({ queueStatus: "QUEUED" })), "Queued");
    assert.equal(queueButtonLabel(job({ queueStatus: "IN_PROGRESS" })), "Applying");
    assert.equal(queueButtonLabel(job({ queueStatus: "NEEDS_YOU" })), "Needs a look");
  });
});

describe("To apply tab", () => {
  const closed = job({ id: "c", queueStatus: "FAILED", queueCode: "closed" });
  const retryable = job({ id: "r", queueStatus: "FAILED", queueCode: "error" });
  const fresh = job({ id: "f" });

  it("drops jobs whose task ended for good, and keeps retryable failures", () => {
    const { filtered, statusCounts } = filterFeed([closed, retryable, fresh], { branchId: null, statusFilter: "open", country: "all" });
    assert.deepEqual(filtered.map((j) => j.id), ["r", "f"]);
    assert.equal(statusCounts.open, 2);
  });

  it("still lists closed jobs under All", () => {
    const { filtered, statusCounts } = filterFeed([closed, fresh], { branchId: null, statusFilter: "all", country: "all" });
    assert.deepEqual(filtered.map((j) => j.id), ["c", "f"]);
    assert.equal(statusCounts.all, 2);
  });
});

describe("pasted jobs in the feed", () => {
  const pasted = job({ id: "p", source: MANUAL_SOURCE, match: { matched: true, reasons: ["Added from a pasted link"] } });
  const japan = job({ id: "jp", match: { matched: true, branchId: "japan", reasons: [] } });

  it("shows under every branch and country", () => {
    const { filtered, countryCounts } = filterFeed([pasted, japan], { branchId: "germany", statusFilter: "open", country: "DE" });
    assert.deepEqual(filtered.map((j) => j.id), ["p"]);
    assert.equal(countryCounts.DE, 1);
  });

  it("leaves To apply once marked applied", () => {
    const applied = { ...pasted, applicationStatus: "applied" as const };
    assert.equal(filterFeed([applied], { branchId: null, statusFilter: "open", country: "all" }).filtered.length, 0);
  });
});

describe("pasted link retries", () => {
  const started = transition({ status: "QUEUED", attempts: 0 }, { type: "start", mode: "submit" });
  const outcome = (o: TaskOutcome) => transition(started, { type: "outcome", mode: "submit", outcome: o });

  it("goes back in the queue with fresh tries and keeps the reason", () => {
    const parked = outcome(park("missing_answer", "Required field left empty"));
    const retry = pastedRetry(parked);
    assert.ok(retry);
    assert.deepEqual(transition({ status: parked.status, attempts: parked.attempts }, retry), {
      status: "QUEUED",
      attempts: 0,
      code: "missing_answer",
      lastError: "Required field left empty",
    });
  });

  it("stays put when sent, ineligible, closed, or maybe already sent", () => {
    assert.equal(pastedRetry(transition(started, { type: "outcome", mode: "submit", outcome: SUBMITTED })), null);
    assert.equal(pastedRetry(outcome(fail("ineligible", "No India"))), null);
    assert.equal(pastedRetry(outcome(fail("closed", "Closed"))), null);
    assert.equal(pastedRetry(outcome(park("no_confirmation", "No confirmation page"))), null);
  });
});
