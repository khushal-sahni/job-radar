import type {
  ApplicationStatus,
  StatusFilter,
} from "@/lib/application-status";
import { isStillToApply } from "@/lib/queue-state";
import type { JobMatch } from "@/lib/types";

export type GroupAction =
  | {
      type: "set_job_status";
      jobId: string;
      status: ApplicationStatus | null;
    }
  | { type: "company_not_interested" };

/**
 * Apply a per-job or company-wide status change to a list of jobs.
 * `set_job_status` touches only the matching id; `company_not_interested`
 * sets every job in the list to not_interested.
 */
export function applyGroupAction(
  jobs: JobMatch[],
  action: GroupAction,
): JobMatch[] {
  const now = new Date().toISOString();

  if (action.type === "company_not_interested") {
    return jobs.map((job) => ({
      ...job,
      applicationStatus: "not_interested" as const,
      statusUpdatedAt: now,
    }));
  }

  return jobs.map((job) =>
    job.id === action.jobId
      ? {
          ...job,
          applicationStatus: action.status,
          statusUpdatedAt: action.status === null ? null : now,
        }
      : job,
  );
}

/** Jobs that belong on a given status filter tab. */
export function jobsVisibleForFilter(
  jobs: JobMatch[],
  statusFilter: StatusFilter,
): JobMatch[] {
  if (statusFilter === "all") return jobs;
  if (statusFilter === "open") {
    return jobs.filter(isStillToApply);
  }
  return jobs.filter((j) => j.applicationStatus === statusFilter);
}
