/** Shapes the feed's apply panel reads from GET /api/apply. */

export interface OpenQuestion {
  fingerprint: string;
  prompt: string;
  control: string;
  options: string[];
  maxLength: number | null;
  /** Set when the answer is saved as a fact about you, reused by every form. */
  factType: string | null;
  known: string[];
  jobs: Array<{ title: string; company: string }>;
}

export interface NeedsYouItem {
  taskId: string;
  title: string;
  company: string;
  url: string;
  reason: string;
}

export interface ApplyState {
  questions: OpenQuestion[];
  needsYou: NeedsYouItem[];
  counts: { queued: number; needsAnswer: number; needsYou: number; captcha: number; submittedToday: number };
  dailyCap: number;
  running: boolean;
  lastRun: { skippedReason: string | null; finishedAt: string } | null;
  /** The last run stopped on HTTP 402; shown until a later run ends without that reason. */
  outOfCredits: boolean;
  health: SystemHealth;
}

export type DailyStep = "ingest" | "naukri" | "apply";

export interface StepState {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  failures: number;
  summary: string | null;
  ok: boolean | null;
}

export interface SystemHealth {
  naukri: { state: "ok" | "login_required" | "challenge"; checkedAt: string } | null;
  naukriLoginOpen: boolean;
  chrome: { naukri: boolean; apply: boolean };
  daily: Record<DailyStep, StepState>;
}

export const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";
