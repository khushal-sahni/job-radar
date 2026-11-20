import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserError, leaseBrowser, type Lease } from "@/lib/browser/manager";
import { isOutOfCredits } from "@/lib/openrouter";
import type { ProfileName } from "@/lib/browser/profiles";
import { loadApplicant, resolveContextFor } from "./applicant";
import { OUT_OF_CREDITS_REASON, acquireLock, writeRunResult } from "./lock";
import { closedListTarget } from "@/lib/location";
import { stillMatchesRules } from "@/lib/matches";
import { getActiveRules } from "@/lib/rule-store";
import { MANUAL_SOURCE } from "@/lib/types";
import { VENDOR_BLOCK_CODES, alreadySent, fail, type TaskOutcome } from "./outcome";
import type { RunPlan } from "./plan";
import { claimableTasks, enqueueMatchedJobs, isNaukriApplyEnabled, parkedTasks, remainingToday, sentPostingTwin } from "./queue";
import { emptySummary, recordResult, type FinishedTask, type RunSummary } from "./record";
import type { ReviewAnswer } from "./review-sample";
import { clearOpenQuestions } from "./question-store";
import type { TaskUpdate } from "./task-state";
import { applyTaskEvent, closeDecidedTasks, requeueInterruptedTasks, taskStatus } from "./task-store";
import type { ApplyVendor } from "./types";
import { isLinkedInUrl } from "./vendor";
import { applierFor, type RunEnv, type VendorApplier } from "./vendors";

export type { RunSummary } from "./record";

/** A button that never took the click (covered by a banner or still loading): the page's fault, not the job's. */
const CLICK_TIMEOUT_RE = /\blocator\.click: Timeout \d+ms exceeded\b/;

async function shootLastPage(lease: Lease, root: string, taskId: string, log: (message: string) => void): Promise<void> {
  const page = lease.openPages().at(-1);
  if (!page) return;
  try {
    const dir = path.join(root, ".cache", "apply-shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${taskId}.png`);
    await page.screenshot({ path: file });
    log(`  screenshot: ${file}`);
  } catch {
    // The page may already be gone.
  }
}

/** Leases per Chrome profile for one run, reopened if the user quit that Chrome mid-run. */
class Leases {
  private readonly open = new Map<ProfileName, Lease>();

  constructor(
    private readonly root: string,
    private readonly log: (message: string) => void,
  ) {}

  async get(profile: ProfileName): Promise<Lease> {
    const current = this.open.get(profile);
    if (current?.isConnected()) return current;
    const lease = await leaseBrowser(profile, { root: this.root, log: this.log });
    this.open.set(profile, lease);
    return lease;
  }

  async releaseAll(keepOpen: boolean): Promise<void> {
    for (const lease of this.open.values()) await lease.release({ keepOpen });
  }
}

/** Fill-only runs show one job at a time: the next opens once you close the last one's tabs. */
async function waitForUserToClose(lease: Lease, log: (message: string) => void): Promise<void> {
  if (lease.openPages().length === 0) return;
  log("  Waiting for you to close this form's window before the next job");
  while (lease.openPages().length > 0 && lease.isConnected()) await delay(1_000);
}

type Task = Awaited<ReturnType<typeof claimableTasks>>[number];

function finishedTask(task: Task, vendor: ApplyVendor): FinishedTask {
  return { id: task.id, company: task.job.company, title: task.job.title, vendor, url: task.job.url, pasted: task.job.source === MANUAL_SOURCE };
}

/**
 * Wait before the next job: 1s after a send, none after a closed posting (no form was touched),
 * else 15–35s so a stuck page or a site's rate limit has time to clear.
 */
export function pauseAfter(update: TaskUpdate, result: { outcome: TaskOutcome } | { error: string }): number {
  if (update.submitted) return 1_000;
  if ("outcome" in result && "code" in result.outcome && result.outcome.code === "closed") return 0;
  return 15_000 + Math.floor(Math.random() * 20_000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

/**
 * Works the queue for one plan, one job at a time. Never touches LinkedIn. Each vendor's
 * jobs run in that vendor's Chrome; a vendor that is logged out or challenged is skipped for
 * the rest of the run and its jobs stay queued.
 */
export async function runApply(plan: RunPlan, options: { root: string; log?: (message: string) => void }): Promise<RunSummary> {
  const { root } = options;
  const log = options.log ?? ((m: string) => console.log(m));
  const summary = emptySummary();
  const fillOnly = plan.mode === "fill_only";

  const releaseLock = acquireLock(root);
  if (!releaseLock) {
    summary.skippedReason = "another apply run is in progress";
    return summary;
  }

  const leases = new Leases(root, log);
  try {
    if (!fillOnly) {
      const orphans = await requeueInterruptedTasks("An earlier run stopped before finishing this job");
      if (orphans > 0) log(`Put back ${orphans} job(s) an earlier run left unfinished`);
      const decided = await closeDecidedTasks();
      if (decided > 0) log(`Closed ${decided} queued job(s) already marked in the feed`);
    }
    if (plan.enqueue) {
      const enq = await enqueueMatchedJobs();
      summary.queued = enq.queued;
      log(`Queued ${enq.queued} new match(es) (${enq.matched} open, ${enq.skippedLinkedIn} LinkedIn skipped)`);
    }

    const remaining = plan.dryRun ? Number.POSITIVE_INFINITY : await remainingToday();
    const limit = Math.min(remaining, plan.maxJobs ?? (plan.dryRun && !fillOnly ? 3 : remaining));
    if (limit <= 0) {
      summary.skippedReason = "daily submit cap reached";
      log("Daily submit cap reached; nothing to do");
      return summary;
    }

    const tasks =
      fillOnly && plan.taskIds
        ? await parkedTasks(plan.taskIds)
        : await claimableTasks({ limit: Number.isFinite(limit) ? limit : 50, taskIds: plan.taskIds ?? undefined });
    if (tasks.length === 0) {
      log("No queued applications");
      return summary;
    }
    if (!(await isNaukriApplyEnabled())) log("Naukri apply is off");

    const env: RunEnv = { plan, root, applicant: await loadApplicant(root), log };
    const rules = fillOnly ? null : await getActiveRules();
    const prepared = new Map<VendorApplier, TaskOutcome | null>();
    let submitsLeft = remaining;
    let lastLease: Lease | null = null;

    for (const [index, task] of tasks.entries()) {
      if (submitsLeft <= 0) {
        log("Daily submit cap reached; stopping");
        break;
      }
      if (isLinkedInUrl(task.job.url)) {
        if (!fillOnly) await applyTaskEvent(task.id, { type: "linkedin" });
        continue;
      }
      if (closedListTarget(task.job) === null) {
        const reason = "Hiring locations have no India, Germany or Japan";
        const update = await applyTaskEvent(task.id, { type: "outcome", mode: plan.mode, outcome: fail("ineligible", reason) });
        if (update.status === "FAILED") summary.failed += 1;
        log(`${task.job.company}: ${task.job.title} → ${update.status}: ${reason}`);
        continue;
      }
      if (rules && !stillMatchesRules(task.job, rules)) {
        const reason = "No longer matches the preference rules";
        const update = await applyTaskEvent(task.id, { type: "outcome", mode: plan.mode, outcome: fail("ineligible", reason) });
        if (update.status === "FAILED") summary.failed += 1;
        log(`${task.job.company}: ${task.job.title} → ${update.status}: ${reason}`);
        continue;
      }
      const vendor = task.vendor as ApplyVendor;
      const applier = applierFor(vendor);
      if (prepared.get(applier)) continue;

      if (fillOnly && lastLease) await waitForUserToClose(lastLease, log);

      let lease: Lease;
      try {
        lease = await leases.get(applier.profile);
      } catch (err) {
        // Chrome never opened, so the job was not tried: it keeps its place and its tries.
        summary.skippedReason = errorMessage(err);
        log(`  ${summary.skippedReason}`);
        break;
      }

      if (!prepared.has(applier)) {
        const blocked = applier.prepare ? await applier.prepare(lease, env) : null;
        prepared.set(applier, blocked);
        if (blocked && "reason" in blocked) {
          log(`  ${vendor} is blocked for this run; its jobs stay queued: ${blocked.reason}`);
          summary.skippedReason ??= blocked.reason;
          continue;
        }
      }

      // The list was read when the run started; a task parked, dismissed or sent since then is left alone.
      if (!fillOnly && (await taskStatus(task.id)) !== "QUEUED") {
        log(`${task.job.company}: ${task.job.title} → skipped, no longer queued`);
        continue;
      }
      log(`[${index + 1}/${tasks.length}] ${task.job.company}: ${task.job.title} (${vendor})${fillOnly ? " [fill only]" : ""}`);
      const twin = await sentPostingTwin(task.job.url, task.id);
      if (twin) {
        await recordResult(root, finishedTask(task, vendor), plan.mode, { outcome: alreadySent(twin.company, twin.title) }, [], summary, log);
        continue;
      }
      await clearOpenQuestions(task.id);
      await applyTaskEvent(task.id, { type: "start", mode: plan.mode });
      summary.attempted += 1;

      const review: ReviewAnswer[] = [];
      const ctx = await resolveContextFor(env.applicant, { ...task.job, vendor }, log);
      let result: { outcome: TaskOutcome } | { error: string; browser: boolean };
      let outOfCredits = false;
      try {
        result = { outcome: await applier.apply(lease, { taskId: task.id, url: task.job.url, ctx, review }, env) };
      } catch (err) {
        const message = errorMessage(err);
        log(`  error: ${message}`);
        outOfCredits = isOutOfCredits(err);
        const clickBlocked = CLICK_TIMEOUT_RE.test(message);
        if (clickBlocked) await shootLastPage(lease, root, task.id, log);
        // `browser: true` hands the job back to the queue with its try returned, as for Chrome trouble.
        result = { error: message, browser: outOfCredits || clickBlocked || err instanceof BrowserError || !lease.isConnected() };
      }

      const update = await recordResult(root, finishedTask(task, vendor), plan.mode, result, review, summary, log);
      if (outOfCredits) {
        summary.skippedReason = OUT_OF_CREDITS_REASON;
        log(`Stopping: ${OUT_OF_CREDITS_REASON}`);
        break;
      }
      if ("outcome" in result && "code" in result.outcome && VENDOR_BLOCK_CODES.has(result.outcome.code)) {
        prepared.set(applier, result.outcome);
        log(`  ${vendor} blocked for the rest of this run; its other jobs stay queued`);
      }
      if (update.submitted) submitsLeft -= 1;

      lastLease = lease;
      if (!fillOnly) {
        await lease.closePages();
        if (index < tasks.length - 1) await delay(pauseAfter(update, result));
      }
    }

    if (fillOnly && lastLease?.openPages().length) log("The last filled form is open in Chrome. Nothing was submitted.");
  } finally {
    await leases.releaseAll(fillOnly);
    writeRunResult(root, summary.skippedReason);
    releaseLock();
  }

  return summary;
}
