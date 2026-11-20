import { activeRunPid } from "./lock";
import { countQueued, remainingToday } from "./queue";
import type { RunMode } from "./task-state";
import { parkedTaskIds, requeueAnsweredTasks, requeueCaptchaTasks } from "./task-store";

/**
 * What one apply run does. Every entry point (08:00 schedule, Apply now, Fill the rest, Fill
 * these, the CLI) builds one of these; the run loop only reads it.
 */
export interface RunPlan {
  /** `submit` sends applications; `fill_only` fills parked jobs and leaves them open for you. */
  mode: RunMode;
  /** Someone is at the Mac: captchas wait for them instead of parking. */
  attended: boolean;
  /** Fill and check everything but never click the final submit. */
  dryRun: boolean;
  /** Only these tasks; null works the whole queue. */
  taskIds: string[] | null;
  /** Queue new matches before starting. */
  enqueue: boolean;
  maxJobs?: number;
}

export type RunScope = "scheduled" | "now" | "answered" | "fill";

export const SCHEDULED_PLAN: RunPlan = { mode: "submit", attended: false, dryRun: false, taskIds: null, enqueue: true };

export type PreparedRun = { plan: RunPlan; tasks: number; captcha?: number } | { skip: string };

/**
 * Turns a button press into a plan. Requeues what the scope covers (answered questions, captcha
 * jobs for a watched run) and says why nothing would run when that is the case.
 */
export async function prepareRun(root: string, scope: RunScope, options: { taskId?: string } = {}): Promise<PreparedRun> {
  if (activeRunPid(root)) return { skip: "An apply run is already in progress" };

  switch (scope) {
    case "scheduled":
      return { plan: SCHEDULED_PLAN, tasks: await countQueued() };
    case "fill": {
      const taskIds = await parkedTaskIds(options.taskId);
      if (taskIds.length === 0) return { skip: "Nothing needs a look" };
      return { plan: { mode: "fill_only", attended: true, dryRun: true, taskIds, enqueue: false }, tasks: taskIds.length };
    }
    case "now": {
      if ((await remainingToday()) <= 0) return { skip: "Today's cap is used up" };
      const captcha = await requeueCaptchaTasks();
      const queued = await countQueued();
      if (queued === 0) return { skip: "Nothing in the queue" };
      return { plan: { mode: "submit", attended: true, dryRun: false, taskIds: null, enqueue: false }, tasks: queued, captcha };
    }
    case "answered": {
      const taskIds = await requeueAnsweredTasks();
      if (taskIds.length === 0) return { skip: "Nothing ready to fill" };
      return { plan: { mode: "submit", attended: true, dryRun: false, taskIds, enqueue: false }, tasks: taskIds.length };
    }
  }
}

/** CLI flags for a plan, read back by `planFromArgs`. */
export function planArgs(plan: RunPlan): string[] {
  const args: string[] = [];
  if (plan.mode === "fill_only") args.push("--fill");
  if (plan.attended) args.push("--attended");
  if (plan.dryRun) args.push("--dry-run");
  if (!plan.enqueue) args.push("--no-enqueue");
  if (plan.taskIds) args.push(`--tasks=${plan.taskIds.join(",")}`);
  if (plan.maxJobs) args.push(`--max=${plan.maxJobs}`);
  return args;
}

export function planFromArgs(argv: string[]): RunPlan {
  const has = (...flags: string[]) => flags.some((f) => argv.includes(f));
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const fill = has("--fill", "--keep-open");
  const taskIds = value("tasks")?.split(",").filter(Boolean) ?? null;
  if (fill && !taskIds) throw new Error("--fill needs --tasks");
  const max = Number(value("max"));
  return {
    mode: fill ? "fill_only" : "submit",
    attended: fill || has("--attended", "--headed"),
    dryRun: fill || has("--dry-run"),
    taskIds,
    enqueue: !has("--no-enqueue") && !fill,
    maxJobs: Number.isFinite(max) && max > 0 ? max : undefined,
  };
}
