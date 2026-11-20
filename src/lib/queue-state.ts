import { isLinkedInUrl } from "@/lib/apply/vendor";
import type { JobMatch, QueueStatus } from "@/lib/types";

type QueueFields = Pick<JobMatch, "applicationStatus" | "queueStatus" | "queueCode" | "url">;

/** Why a failed task stays failed: you dismissed it, the posting is gone, or it rules you out. */
const FINAL_FAILURES: Record<string, string> = {
  manual: "Dismissed",
  closed: "Closed",
  ineligible: "Not eligible",
  linkedin: "LinkedIn",
};

function isFinalFailure(job: Pick<QueueFields, "queueStatus" | "queueCode">): boolean {
  return job.queueStatus === "FAILED" && !!job.queueCode && job.queueCode in FINAL_FAILURES;
}

/** On To apply: no mark from you, and no task that ended for good (closed, dismissed, ineligible). */
export function isStillToApply(job: Pick<QueueFields, "applicationStatus" | "queueStatus" | "queueCode">): boolean {
  return !job.applicationStatus && !isFinalFailure(job);
}

/**
 * A job the feed can put in the auto-apply queue: still to apply, not LinkedIn, and either no
 * task or one that failed on errors.
 */
export function isQueueable(job: QueueFields): boolean {
  if (job.applicationStatus) return false;
  if (isLinkedInUrl(job.url)) return false;
  if (!job.queueStatus) return true;
  return job.queueStatus === "FAILED" && !isFinalFailure(job);
}

/** The card's queue button text: an action when the job can be queued, else why it cannot. */
export function queueButtonLabel(job: QueueFields): string {
  if (isQueueable(job)) return "Queue";
  if (isLinkedInUrl(job.url)) return "LinkedIn";
  switch (job.queueStatus) {
    case "QUEUED":
      return "Queued";
    case "IN_PROGRESS":
      return "Applying";
    case "NEEDS_ANSWER":
      return "Needs answers";
    case "NEEDS_YOU":
      return "Needs a look";
    case "FAILED":
      return FINAL_FAILURES[job.queueCode ?? ""] ?? "Failed";
    default:
      return "Applied";
  }
}

/** Card badge for a task that is waiting or running; other states have their own UI. */
export const QUEUE_BADGE: Partial<Record<QueueStatus, { label: string; className: string }>> = {
  QUEUED: { label: "Queued", className: "bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-400/30" },
  IN_PROGRESS: { label: "Applying", className: "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30" },
};
