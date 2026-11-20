import type { ApplyTaskStatus, Prisma } from "@/generated/prisma/client";
import { setJobApplication } from "@/lib/applications";
import { db } from "@/lib/db";
import { transition, type TaskEvent, type TaskUpdate } from "./task-state";

/** Applies one state-machine event to a task. The only writer of task status. */
export async function applyTaskEvent(taskId: string, event: TaskEvent): Promise<TaskUpdate> {
  const task = await db.applyTask.findUnique({ where: { id: taskId }, select: { status: true, attempts: true, jobId: true } });
  if (!task) throw new Error("Task not found");
  const update = transition(task, event);
  await db.applyTask.update({
    where: { id: taskId },
    data: {
      status: update.status,
      attempts: update.attempts,
      code: update.code,
      lastError: update.lastError,
      ...(update.submitted ? { submittedAt: new Date() } : {}),
    },
  });
  if (update.submitted) await setJobApplication(task.jobId, "applied");
  return update;
}

export async function taskStatus(taskId: string): Promise<ApplyTaskStatus | null> {
  return (await db.applyTask.findUnique({ where: { id: taskId }, select: { status: true } }))?.status ?? null;
}

async function applyToMany(where: Prisma.ApplyTaskWhereInput, event: TaskEvent): Promise<string[]> {
  const rows = await db.applyTask.findMany({ where, select: { id: true } });
  for (const row of rows) await applyTaskEvent(row.id, event);
  return rows.map((r) => r.id);
}

/** NEEDS_ANSWER tasks whose questions are all answered go back to the queue. */
export async function requeueAnsweredTasks(): Promise<string[]> {
  return applyToMany({ status: "NEEDS_ANSWER", questions: { none: { answer: null } } }, { type: "requeue" });
}

/** Captcha-parked tasks go back in the queue for a run someone is watching. */
export async function requeueCaptchaTasks(): Promise<number> {
  return (await applyToMany({ status: "NEEDS_YOU", code: "captcha" }, { type: "requeue" })).length;
}

/** Every parked task goes back in the auto-apply queue, the same as Retry on each row. */
export async function requeueParkedTasks(): Promise<number> {
  return (await applyToMany({ status: "NEEDS_YOU" }, { type: "requeue" })).length;
}

/** Tasks a stopped or crashed run left mid-apply go back in the queue with their try given back. */
export async function requeueInterruptedTasks(reason: string): Promise<number> {
  return (await applyToMany({ status: "IN_PROGRESS" }, { type: "interrupted", reason })).length;
}

/**
 * Waiting tasks whose job was already marked applied or not interested in the feed. No run claims
 * them, so without this they would sit in the queue count forever.
 */
export async function closeDecidedTasks(): Promise<number> {
  const waiting: Prisma.ApplyTaskWhereInput = { status: { in: ["QUEUED", "NEEDS_ANSWER", "NEEDS_YOU"] } };
  const applied = await applyToMany({ ...waiting, job: { application: { status: "APPLIED" } } }, { type: "user_applied" });
  const skipped = await applyToMany({ ...waiting, job: { application: { status: "NOT_INTERESTED" } } }, { type: "user_dismissed" });
  return applied.length + skipped.length;
}

/** Parked tasks a fill-only run may open, newest first like the panel list. */
export async function parkedTaskIds(taskId?: string): Promise<string[]> {
  const rows = await db.applyTask.findMany({
    where: { status: "NEEDS_YOU", ...(taskId ? { id: taskId } : {}) },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return rows.map((r) => r.id);
}

/** Dismiss from "needs a look" also marks the job Rejected in the feed. */
export async function resolveNeedsYou(taskId: string, action: "applied" | "dismiss" | "retry"): Promise<void> {
  const event: TaskEvent =
    action === "applied" ? { type: "user_applied" } : action === "retry" ? { type: "requeue" } : { type: "user_dismissed" };
  await applyTaskEvent(taskId, event);
  if (action !== "dismiss") return;
  const task = await db.applyTask.findUnique({ where: { id: taskId }, select: { jobId: true } });
  if (task) await setJobApplication(task.jobId, "rejected");
}
