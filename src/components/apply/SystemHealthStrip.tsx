"use client";

import { focusRing, type DailyStep, type StepState, type SystemHealth } from "./types";

const STEP_LABELS: Record<DailyStep, string> = { ingest: "Job boards", naukri: "Naukri", apply: "Auto-apply" };

function ago(ms: number | null): string {
  if (ms === null) return "never";
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function StepBadge({ step, state }: { step: DailyStep; state: StepState }) {
  const failed = state.ok === false;
  const text = failed
    ? `failed ${ago(state.lastAttemptAt)}, retrying`
    : state.lastSuccessAt
      ? ago(state.lastSuccessAt)
      : "not run yet";
  return (
    <li className="whitespace-nowrap" title={state.summary ?? undefined}>
      <span className={failed ? "text-amber-300" : "text-zinc-300"}>{STEP_LABELS[step]}</span>{" "}
      <span className={failed ? "text-amber-300/80" : "text-zinc-500"}>{text}</span>
    </li>
  );
}

/** The unattended side at a glance: is Naukri logged in, and how did each daily step go. */
export function SystemHealthStrip({
  health,
  loggingIn,
  onLogin,
}: {
  health: SystemHealth;
  loggingIn: boolean;
  onLogin: () => void;
}) {
  const naukri = health.naukri?.state ?? null;
  const loginOpen = health.naukriLoginOpen;
  const needsLogin = naukri === "login_required" || naukri === null;

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-zinc-800 pt-4 text-xs sm:flex-row sm:items-center sm:justify-between">
      <ul className="flex min-w-0 flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4">
        <li className="text-zinc-500">Daily:</li>
        {(["ingest", "naukri", "apply"] as const).map((step) => (
          <StepBadge key={step} step={step} state={health.daily[step]} />
        ))}
      </ul>

      <div className="flex shrink-0 items-center gap-3">
        <p className="text-zinc-400" title={health.naukri ? `Checked ${new Date(health.naukri.checkedAt).toLocaleString()}` : undefined}>
          {loginOpen ? (
            <span className="text-emerald-400">Log in in the Naukri Chrome window</span>
          ) : naukri === "ok" ? (
            <>Naukri <span className="text-emerald-400">logged in</span></>
          ) : naukri === "challenge" ? (
            <span className="text-amber-300">Naukri is showing a bot check</span>
          ) : naukri === null ? (
            "Naukri login not checked yet"
          ) : (
            <span className="text-amber-300">Naukri login needed</span>
          )}
        </p>
        {(needsLogin || naukri === "challenge") && !loginOpen && (
          <button
            type="button"
            onClick={onLogin}
            disabled={loggingIn}
            className={`min-h-11 rounded-lg border border-amber-500/50 px-3 text-sm font-medium text-amber-200 hover:bg-amber-500/10 disabled:opacity-40 ${focusRing}`}
          >
            {loggingIn ? "Opening…" : "Log in to Naukri"}
          </button>
        )}
      </div>
    </div>
  );
}
