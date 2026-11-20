import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { MANUAL_SOURCE } from "@/lib/types";
import { activeRunPid } from "./lock";
import { checkJobUrl, companyFromUrl, urlVariants } from "./manual-url";
import type { RunPlan } from "./plan";
import { remainingToday } from "./queue";
import { applyTaskEvent } from "./task-store";
import { detectVendor } from "./vendor";

export type PreparedUrlTask = { taskId: string; company: string; title: string } | { skip: string };

/**
 * Finds or creates the job and puts its apply task in the queue for a fresh try. With `keepWaiting`
 * a task already queued or under "needs a look" keeps its place, for a fill that sends nothing.
 */
export async function prepareUrlTask(url: string, options: { keepWaiting?: boolean } = {}): Promise<PreparedUrlTask> {
  let job = await db.job.findFirst({
    where: { url: { in: urlVariants(url) } },
    include: { application: true, applyTask: true },
    orderBy: { fetchedAt: "desc" },
  });
  if (!job) {
    job = await db.job.create({
      data: {
        source: MANUAL_SOURCE,
        externalId: createHash("sha256").update(url).digest("hex").slice(0, 24),
        url,
        title: "Pasted job",
        company: companyFromUrl(url),
        description: "",
      },
      include: { application: true, applyTask: true },
    });
  }

  const name = `${job.company}: ${job.title}`;
  if (job.application?.status === "APPLIED" || job.applyTask?.status === "SUBMITTED") {
    return { skip: `Already applied to ${name}` };
  }
  if (job.application) {
    return { skip: `${name} is marked ${job.application.status.toLowerCase().replace("_", " ")} in the feed` };
  }
  if (job.applyTask?.status === "IN_PROGRESS") return { skip: `${name} is being applied to now` };
  if (!job.isActive) await db.job.update({ where: { id: job.id }, data: { isActive: true } });

  const label = { company: job.company, title: job.title };
  if (!job.applyTask) {
    const task = await db.applyTask.create({ data: { jobId: job.id, vendor: detectVendor(url, job.source) } });
    return { taskId: task.id, ...label };
  }
  const waiting = job.applyTask.status === "QUEUED" || job.applyTask.status === "NEEDS_YOU";
  if (!(options.keepWaiting && waiting)) await applyTaskEvent(job.applyTask.id, { type: "requeue" });
  return { taskId: job.applyTask.id, ...label };
}

export type UrlRun =
  | { plan: RunPlan; company: string; title: string }
  | { queued: string }
  | { skip: string };

/**
 * One pasted link as a watched run: the same Chrome, captcha wait and submit rules as Apply now,
 * for that job only. While another run is going the job is queued and left for the next run.
 * With `fill` the form is filled and left open in Chrome; nothing is submitted.
 */
export async function prepareUrlRun(root: string, rawUrl: string, options: { fill?: boolean } = {}): Promise<UrlRun> {
  const checked = checkJobUrl(rawUrl);
  if ("error" in checked) return { skip: checked.error };
  if (options.fill) {
    // A fill is never queued for later: the next run would submit it.
    if (activeRunPid(root)) return { skip: "An apply run is already in progress; fill this link once it ends" };
    const prepared = await prepareUrlTask(checked.url, { keepWaiting: true });
    if ("skip" in prepared) return prepared;
    return {
      plan: { mode: "fill_only", attended: true, dryRun: true, taskIds: [prepared.taskId], enqueue: false },
      company: prepared.company,
      title: prepared.title,
    };
  }
  if ((await remainingToday()) <= 0) return { skip: "Today's cap is used up" };
  const prepared = await prepareUrlTask(checked.url);
  if ("skip" in prepared) return prepared;
  if (activeRunPid(root)) {
    return { queued: `A run is going; ${prepared.company} is queued for Apply now or the next run` };
  }
  return {
    plan: { mode: "submit", attended: true, dryRun: false, taskIds: [prepared.taskId], enqueue: false },
    company: prepared.company,
    title: prepared.title,
  };
}
