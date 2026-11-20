import type { ApplyTaskStatus } from "@/generated/prisma/client";
import { FREE_RETRY_CODES, type OutcomeCode, type TaskOutcome } from "./outcome";

/**
 * The ApplyTask state machine. Every status change goes through `transition`, which is pure;
 * `task-store.ts` reads the task, applies the result and writes it.
 *
 * Tries: a submit run spends one when it starts a task. It is given back when the try never
 * reached the form for reasons outside the task (no one for a captcha, a login wall, Chrome
 * unreachable, a stopped or crashed run) and for dry runs. Three real failures fail the task.
 */

export const MAX_ATTEMPTS = 3;

export type RunMode = "submit" | "fill_only";

export interface TaskSnapshot {
  status: ApplyTaskStatus;
  attempts: number;
}

export type TaskEvent =
  | { type: "start"; mode: RunMode }
  | { type: "outcome"; mode: RunMode; outcome: TaskOutcome }
  | { type: "error"; mode: RunMode; message: string; browser?: boolean }
  /** A stopped or crashed run left the task mid-apply. */
  | { type: "interrupted"; reason: string }
  /** Retry, answered questions, captcha retry: back in the queue with fresh tries. */
  | { type: "requeue" }
  /** A pasted link that did not go through: back in the queue with fresh tries, the reason kept. */
  | { type: "retry_later"; code: OutcomeCode | null; reason: string | null }
  | { type: "user_applied" }
  | { type: "user_dismissed" }
  | { type: "linkedin" };

export interface TaskUpdate {
  status: ApplyTaskStatus;
  attempts: number;
  code: OutcomeCode | null;
  lastError: string | null;
  /** Set the submitted time and mark the job applied. */
  submitted?: boolean;
}

export const LOOK_FILLED_REASON = "Filled in the open window and not submitted; check it and send it yourself";

function giveBack(attempts: number): number {
  return Math.max(0, attempts - 1);
}

function sent(task: TaskSnapshot, outcome: Extract<TaskOutcome, { status: "SUBMITTED" }>): TaskUpdate {
  if (outcome.alreadySent) return { status: "SUBMITTED", attempts: task.attempts, code: "manual", lastError: outcome.alreadySent, submitted: true };
  return { status: "SUBMITTED", attempts: task.attempts, code: null, lastError: null, submitted: true };
}

function submitOutcome(task: TaskSnapshot, outcome: TaskOutcome): TaskUpdate {
  switch (outcome.status) {
    case "SUBMITTED":
      return sent(task, outcome);
    case "READY":
      return { status: "QUEUED", attempts: giveBack(task.attempts), code: outcome.code, lastError: outcome.reason };
    case "NEEDS_ANSWER":
      return { status: "NEEDS_ANSWER", attempts: task.attempts, code: outcome.code, lastError: outcome.reason };
    case "FAILED":
      return { status: "FAILED", attempts: task.attempts, code: outcome.code, lastError: outcome.reason };
    case "NEEDS_YOU": {
      const free = FREE_RETRY_CODES.has(outcome.code);
      // A login wall or challenge clears up by itself once the session is fixed, so the job waits in the queue.
      const status = outcome.code === "login_required" || outcome.code === "challenge" ? "QUEUED" : "NEEDS_YOU";
      return {
        status,
        attempts: free ? giveBack(task.attempts) : task.attempts,
        code: outcome.code,
        lastError: outcome.reason,
      };
    }
  }
}

/** A fill-only run never submits: the task stays under "needs a look" whatever happened. */
function fillOnlyOutcome(task: TaskSnapshot, outcome: TaskOutcome): TaskUpdate {
  switch (outcome.status) {
    case "SUBMITTED":
      return sent(task, outcome);
    case "READY":
      return { status: "NEEDS_YOU", attempts: task.attempts, code: "left_open", lastError: LOOK_FILLED_REASON };
    case "NEEDS_ANSWER":
      return {
        status: "NEEDS_YOU",
        attempts: task.attempts,
        code: outcome.code,
        lastError: `Filled what it could; ${outcome.reason}`,
      };
    case "FAILED":
      // The job rules you out wherever it is opened; there is nothing to look at.
      if (outcome.code === "ineligible") return { status: "FAILED", attempts: task.attempts, code: outcome.code, lastError: outcome.reason };
      return { status: "NEEDS_YOU", attempts: task.attempts, code: outcome.code, lastError: outcome.reason };
    default:
      return { status: "NEEDS_YOU", attempts: task.attempts, code: outcome.code, lastError: outcome.reason };
  }
}

/**
 * Outcomes a retry cannot fix, or where it could send twice (the form may have gone through
 * without a confirmation page).
 */
const NO_PASTED_RETRY: ReadonlySet<OutcomeCode> = new Set<OutcomeCode>(["ineligible", "closed", "linkedin", "no_confirmation"]);

/**
 * A pasted link stays in the queue until it is sent, so the link never has to be pasted again.
 * Questions still wait for the modal.
 */
export function pastedRetry(update: TaskUpdate): TaskEvent | null {
  if (update.status !== "NEEDS_YOU" && update.status !== "FAILED") return null;
  if (update.code && NO_PASTED_RETRY.has(update.code)) return null;
  return { type: "retry_later", code: update.code, reason: update.lastError };
}

export function transition(task: TaskSnapshot, event: TaskEvent): TaskUpdate {
  switch (event.type) {
    case "start":
      if (event.mode === "fill_only") return { status: task.status, attempts: task.attempts, code: null, lastError: null };
      return { status: "IN_PROGRESS", attempts: task.attempts + 1, code: null, lastError: null };
    case "outcome":
      return event.mode === "submit" ? submitOutcome(task, event.outcome) : fillOnlyOutcome(task, event.outcome);
    case "error": {
      if (event.mode === "fill_only") {
        return { status: "NEEDS_YOU", attempts: task.attempts, code: "error", lastError: `Fill stopped on an error: ${event.message}` };
      }
      if (event.browser) {
        return { status: "QUEUED", attempts: giveBack(task.attempts), code: "browser", lastError: event.message };
      }
      if (task.attempts < MAX_ATTEMPTS) {
        return { status: "QUEUED", attempts: task.attempts, code: "error", lastError: `Error, will retry: ${event.message}` };
      }
      return {
        status: "FAILED",
        attempts: task.attempts,
        code: "error",
        lastError: `Gave up after ${MAX_ATTEMPTS} tries: ${event.message}`,
      };
    }
    case "interrupted":
      return {
        status: "QUEUED",
        attempts: task.status === "IN_PROGRESS" ? giveBack(task.attempts) : task.attempts,
        code: "stopped",
        lastError: event.reason,
      };
    case "requeue":
      return { status: "QUEUED", attempts: 0, code: null, lastError: null };
    case "retry_later":
      return { status: "QUEUED", attempts: 0, code: event.code, lastError: event.reason };
    case "user_applied":
      return { status: "SUBMITTED", attempts: task.attempts, code: "manual", lastError: "Applied by hand", submitted: true };
    case "user_dismissed":
      return { status: "FAILED", attempts: task.attempts, code: "manual", lastError: "Dismissed" };
    case "linkedin":
      return { status: "FAILED", attempts: task.attempts, code: "linkedin", lastError: "LinkedIn is never auto-applied" };
  }
}
