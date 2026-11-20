import type { ApplyIssue } from "@/generated/prisma/client";
import type { Resolution } from "./resolve";

/**
 * What happened to one application. `code` says why in a form code can act on; `reason` is
 * the sentence shown to the user and is never parsed.
 */
export type OutcomeCode = ApplyIssue;

export type TaskOutcome =
  /** `alreadySent`: nothing was sent now; the same posting went out through another listing. */
  | { status: "SUBMITTED"; alreadySent?: string }
  | { status: "NEEDS_ANSWER"; code: OutcomeCode; reason: string }
  | { status: "NEEDS_YOU"; code: OutcomeCode; reason: string }
  | { status: "FAILED"; code: OutcomeCode; reason: string }
  | { status: "READY"; code: OutcomeCode; reason: string };

export const SUBMITTED: TaskOutcome = { status: "SUBMITTED" };

/** The posting was already applied to from another job row; this one is closed without filling. */
export function alreadySent(company: string, title: string): TaskOutcome {
  return { status: "SUBMITTED", alreadySent: `Already applied to this posting (${company}: ${title}); not sent again` };
}

export function park(code: OutcomeCode, reason: string): TaskOutcome {
  return { status: "NEEDS_YOU", code, reason };
}

export function fail(code: OutcomeCode, reason: string): TaskOutcome {
  return { status: "FAILED", code, reason };
}

export function needsAnswer(reason: string): TaskOutcome {
  return { status: "NEEDS_ANSWER", code: "questions", reason };
}

export function ready(reason: string): TaskOutcome {
  return { status: "READY", code: "dry_run", reason };
}

/**
 * A question the form does not require is filled only when the answer is in hand. Asking you,
 * parking or failing the job over it is worse than leaving it blank, so those become a skip.
 */
export function optionalResolution(res: Resolution | undefined): Resolution | undefined {
  if (res?.kind === "ask" || res?.kind === "park" || res?.kind === "ineligible") return { kind: "skip", keys: res.keys };
  return res;
}

/**
 * Not the task's fault: nobody was there for a captcha, the site wanted a login, or Chrome
 * could not be reached. These never use up one of the task's tries.
 */
export const FREE_RETRY_CODES: ReadonlySet<OutcomeCode> = new Set<OutcomeCode>([
  "captcha",
  "login_required",
  "challenge",
  "browser",
]);

/** The vendor is blocked for the rest of the run: its other jobs would hit the same wall. */
export const VENDOR_BLOCK_CODES: ReadonlySet<OutcomeCode> = new Set<OutcomeCode>(["login_required", "challenge"]);

export const CAPTCHA_REASON = "Captcha. Apply now opens a window so you can solve it.";
