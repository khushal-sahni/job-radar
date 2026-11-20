import type { TaskOutcome } from "./outcome";
import { saveReviewSample, saveSubmission, type ReviewAnswer } from "./review-sample";
import { pastedRetry, type RunMode, type TaskEvent, type TaskUpdate } from "./task-state";
import { applyTaskEvent } from "./task-store";

export interface RunSummary {
  queued: number;
  attempted: number;
  submitted: number;
  needsAnswer: number;
  needsYou: number;
  failed: number;
  ready: number;
  /** Started but handed back to the queue (login wall, Chrome trouble, error to retry). */
  requeued: number;
  skippedReason: string | null;
}

export function emptySummary(): RunSummary {
  return { queued: 0, attempted: 0, submitted: 0, needsAnswer: 0, needsYou: 0, failed: 0, ready: 0, requeued: 0, skippedReason: null };
}

function count(summary: RunSummary, update: TaskUpdate, outcome: TaskOutcome | null): void {
  if (outcome?.status === "READY") summary.ready += 1;
  switch (update.status) {
    case "SUBMITTED":
      summary.submitted += 1;
      return;
    case "NEEDS_ANSWER":
      summary.needsAnswer += 1;
      return;
    case "NEEDS_YOU":
      summary.needsYou += 1;
      return;
    case "FAILED":
      summary.failed += 1;
      return;
    case "QUEUED":
      if (outcome?.status !== "READY") summary.requeued += 1;
      return;
  }
}

export interface FinishedTask {
  id: string;
  company: string;
  title: string;
  vendor: string;
  url: string;
  /** Added from a pasted link: stays queued until it is sent. */
  pasted: boolean;
}

/** Writes the task's new state and its review sample, and counts it. */
export async function recordResult(
  root: string,
  task: FinishedTask,
  mode: RunMode,
  result: { outcome: TaskOutcome } | { error: string; browser: boolean },
  review: ReviewAnswer[],
  summary: RunSummary,
  log: (message: string) => void,
): Promise<TaskUpdate> {
  const event: TaskEvent =
    "outcome" in result
      ? { type: "outcome", mode, outcome: result.outcome }
      : { type: "error", mode, message: result.error, browser: result.browser };
  let update = await applyTaskEvent(task.id, event);
  const retry = task.pasted && mode === "submit" ? pastedRetry(update) : null;
  if (retry) update = await applyTaskEvent(task.id, retry);
  count(summary, update, "outcome" in result ? result.outcome : null);
  log(`  → ${update.status}${update.lastError ? `: ${update.lastError}` : ""}`);

  const outcomeText = "outcome" in result
    ? `${result.outcome.status}${"reason" in result.outcome ? ` (${result.outcome.reason})` : ""}`
    : `ERROR (${result.error})`;
  const sample = {
    taskId: task.id,
    company: task.company,
    title: task.title,
    vendor: task.vendor,
    url: task.url,
    outcome: outcomeText,
    answers: review,
    at: new Date(),
  };
  try {
    saveReviewSample(root, sample);
    if (update.status === "SUBMITTED") saveSubmission(root, sample);
  } catch (err) {
    log(`  review sample not saved: ${err instanceof Error ? err.message : String(err)}`);
  }
  return update;
}
