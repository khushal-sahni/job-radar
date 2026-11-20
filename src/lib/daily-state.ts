import fs from "node:fs";
import path from "node:path";

/**
 * The daily job's per-step record. launchd wakes the job hourly; each step runs when it has
 * not succeeded in the last MIN_HOURS and its retry backoff has passed, so one step failing
 * (Postgres down, Naukri logged out) never blocks or masks the others.
 */

export type DailyStep = "ingest" | "naukri" | "apply";
export const DAILY_STEPS: DailyStep[] = ["ingest", "naukri", "apply"];

export const MIN_HOURS_BETWEEN_RUNS = 20;
const HOUR_MS = 60 * 60 * 1000;
const MAX_BACKOFF_HOURS = 6;

export interface StepState {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  /** Consecutive failures; drives the retry backoff. */
  failures: number;
  /** One line for the panel: counts on success, the error on failure. */
  summary: string | null;
  ok: boolean | null;
}

export type DailyState = Record<DailyStep, StepState>;

function emptyStep(): StepState {
  return { lastSuccessAt: null, lastAttemptAt: null, failures: 0, summary: null, ok: null };
}

export function emptyDailyState(): DailyState {
  return { ingest: emptyStep(), naukri: emptyStep(), apply: emptyStep() };
}

/** Hours to wait after `failures` consecutive failures: 1, 2, 4, then 6. */
export function backoffHours(failures: number): number {
  return failures <= 0 ? 0 : Math.min(2 ** (failures - 1), MAX_BACKOFF_HOURS);
}

export function isStepDue(step: StepState, now: number): boolean {
  if (step.lastSuccessAt !== null && now - step.lastSuccessAt < MIN_HOURS_BETWEEN_RUNS * HOUR_MS) return false;
  if (step.failures > 0 && step.lastAttemptAt !== null) {
    return now - step.lastAttemptAt >= backoffHours(step.failures) * HOUR_MS;
  }
  return true;
}

export function recordStep(step: StepState, now: number, result: { ok: boolean; summary: string }): StepState {
  return result.ok
    ? { lastSuccessAt: now, lastAttemptAt: now, failures: 0, summary: result.summary, ok: true }
    : { ...step, lastAttemptAt: now, failures: step.failures + 1, summary: result.summary, ok: false };
}

function stateFile(root: string): string {
  return path.join(root, ".cache", "daily-state.json");
}

export function readDailyState(root: string): DailyState {
  const state = emptyDailyState();
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(root), "utf-8")) as Partial<DailyState>;
    for (const step of DAILY_STEPS) if (saved[step]) state[step] = { ...state[step], ...saved[step] };
    return state;
  } catch {
    // First run on this layout: carry over the old single-step file so ingest does not rerun at once.
    try {
      const legacy = JSON.parse(fs.readFileSync(path.join(root, ".cache", "daily-ingest-state.json"), "utf-8")) as {
        lastSuccessAt?: number;
      };
      if (legacy.lastSuccessAt) state.ingest = { ...state.ingest, lastSuccessAt: legacy.lastSuccessAt, ok: true };
    } catch {
      // nothing saved yet
    }
    return state;
  }
}

export function writeDailyState(root: string, state: DailyState): void {
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify(state, null, 2));
}
