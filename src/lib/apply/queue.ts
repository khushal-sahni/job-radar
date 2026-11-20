import { db } from "@/lib/db";
import type { FeedFilter } from "@/lib/feed-filter";
import { listFeedJobs, listMatchedJobs } from "@/lib/matches";
import {
  DEFAULT_DAILY_APPLY_CAP,
  getPreferences,
} from "@/lib/preferences";
import { isQueueable } from "@/lib/queue-state";
import { MANUAL_SOURCE, type DateRange } from "@/lib/types";
import { postingPath } from "./manual-url";
import { MAX_ATTEMPTS } from "./task-state";
import { applyTaskEvent } from "./task-store";
import { detectVendor, isLinkedInUrl, postingKey } from "./vendor";

export async function getDailyCap(): Promise<number> {
  try {
    const prefs = await getPreferences();
    return prefs.dailyApplyCap;
  } catch {
    const envRaw = process.env.APPLY_DAILY_CAP;
    if (envRaw != null && envRaw.trim() !== "") {
      const parsed = Number(envRaw);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    }
    return DEFAULT_DAILY_APPLY_CAP;
  }
}

export async function isNaukriApplyEnabled(): Promise<boolean> {
  if (process.env.APPLY_NAUKRI === "0") return false;
  if (process.env.APPLY_NAUKRI === "1") return true;
  try {
    const prefs = await getPreferences();
    return prefs.naukriEnabled;
  } catch {
    return false;
  }
}

export function startOfLocalDay(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function countSubmittedToday(): Promise<number> {
  return db.applyTask.count({
    where: { status: "SUBMITTED", submittedAt: { gte: startOfLocalDay() } },
  });
}

export async function remainingToday(): Promise<number> {
  return Math.max(0, (await getDailyCap()) - (await countSubmittedToday()));
}

export async function countQueued(): Promise<number> {
  return db.applyTask.count({ where: { status: "QUEUED", attempts: { lt: MAX_ATTEMPTS } } });
}

export interface EnqueueResult {
  matched: number;
  queued: number;
  skippedLinkedIn: number;
}

/**
 * Queue matched jobs from the last week that have no application status and no task yet.
 * LinkedIn URLs are never queued.
 */
export async function enqueueMatchedJobs(): Promise<EnqueueResult> {
  const { matches } = await listMatchedJobs("7d");
  const open = matches.filter((m) => !m.applicationStatus);

  const existing = await db.applyTask.findMany({
    where: { jobId: { in: open.map((m) => m.id) } },
    select: { jobId: true },
  });
  const taken = new Set(existing.map((t) => t.jobId));

  let queued = 0;
  let skippedLinkedIn = 0;
  for (const job of open) {
    if (taken.has(job.id)) continue;
    if (isLinkedInUrl(job.url)) {
      skippedLinkedIn += 1;
      continue;
    }
    await db.applyTask.create({
      data: { jobId: job.id, vendor: detectVendor(job.url, job.source) },
    });
    queued += 1;
  }

  return { matched: open.length, queued, skippedLinkedIn };
}

/**
 * A job row for the same posting (same `postingKey`) that was already sent or marked applied,
 * other than `exceptTaskId`'s own. Checked before a task starts and on a Naukri company-site redirect.
 */
export async function sentPostingTwin(url: string, exceptTaskId: string): Promise<{ company: string; title: string } | null> {
  const key = postingKey(url);
  if (!key) return null;
  const id = key.slice(key.lastIndexOf(":") + 1);
  const rows = await db.job.findMany({
    where: {
      url: { contains: id, mode: "insensitive" },
      OR: [{ application: { status: "APPLIED" } }, { applyTask: { status: "SUBMITTED" } }],
      NOT: { applyTask: { is: { id: exceptTaskId } } },
    },
    select: { url: true, company: true, title: true },
    take: 20,
  });
  return rows.find((r) => postingKey(r.url) === key) ?? null;
}

/** Another pasted row for the same posting was already sent or marked applied. */
async function postingAlreadySent(jobId: string, url: string): Promise<boolean> {
  const sibling = await db.job.findFirst({
    where: {
      id: { not: jobId },
      url: { startsWith: postingPath(url) },
      OR: [{ application: { status: "APPLIED" } }, { applyTask: { status: "SUBMITTED" } }],
    },
    select: { id: true },
  });
  return sibling !== null;
}

export interface QueueJobsResult {
  queued: number;
  /** Already waiting, running, parked or applied; left as they were. */
  alreadyWaiting: number;
}

/**
 * Puts feed jobs in the queue. A job with no task gets one; a failed task starts over with fresh
 * tries. Jobs with any other task, an application status, or a LinkedIn URL are left alone.
 */
export async function queueJobs(jobIds: string[]): Promise<QueueJobsResult> {
  const jobs = await db.job.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, url: true, source: true, application: { select: { id: true } }, applyTask: { select: { id: true, status: true, code: true } } },
  });
  let queued = 0;
  for (const job of jobs) {
    const queueable = isQueueable({
      applicationStatus: job.application ? "applied" : null,
      queueStatus: job.applyTask?.status ?? null,
      queueCode: job.applyTask?.code ?? null,
      url: job.url,
    });
    if (!queueable) continue;
    if (job.source === MANUAL_SOURCE && (await postingAlreadySent(job.id, job.url))) continue;
    if (job.applyTask) {
      await applyTaskEvent(job.applyTask.id, { type: "requeue" });
    } else {
      await db.applyTask.create({ data: { jobId: job.id, vendor: detectVendor(job.url, job.source) } });
    }
    queued += 1;
  }
  return { queued, alreadyWaiting: jobs.length - queued };
}

/** Queues every job the feed shows for these filters, across all pages. */
export async function queueFeedJobs(dateRange: DateRange, filter: FeedFilter): Promise<QueueJobsResult> {
  const jobs = await listFeedJobs(dateRange, filter);
  return queueJobs(jobs.map((j) => j.id));
}

/**
 * Tasks for a look run, in the order given: parked ones, or a pasted link still queued. Callers
 * pick the ids. LinkedIn is still filtered by the runner.
 */
export async function parkedTasks(taskIds: string[]) {
  const rows = await db.applyTask.findMany({
    where: { status: { in: ["NEEDS_YOU", "QUEUED"] }, id: { in: taskIds }, job: { application: null } },
    include: { job: true },
  });
  return rows.sort((a, b) => taskIds.indexOf(a.id) - taskIds.indexOf(b.id));
}

/** Oldest queued first; each enqueue batch is inserted best match first. */
export async function claimableTasks(options: {
  limit: number;
  taskIds?: string[];
}) {
  const vendorFilter = (await isNaukriApplyEnabled()) ? {} : { vendor: { not: "naukri" } };
  return db.applyTask.findMany({
    where: {
      status: "QUEUED",
      attempts: { lt: MAX_ATTEMPTS },
      job: { isActive: true, application: null },
      ...(options.taskIds ? { id: { in: options.taskIds } } : {}),
      ...vendorFilter,
    },
    include: { job: true },
    orderBy: { createdAt: "asc" },
    take: options.limit,
  });
}
