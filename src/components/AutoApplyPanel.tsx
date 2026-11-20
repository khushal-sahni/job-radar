"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { SystemHealthStrip } from "./apply/SystemHealthStrip";
import { focusRing, type ApplyState } from "./apply/types";

const IDLE_POLL_MS = 60_000;
const BUSY_POLL_MS = 5_000;

async function fetchApplyState(): Promise<ApplyState> {
  const res = await fetch("/api/apply");
  const data = (await res.json()) as ApplyState & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load auto-apply");
  return data;
}

interface AutoApplyPanelProps {
  /** Changes when the feed queued jobs; the panel refetches its counts. */
  refreshKey?: number;
  /** A run started or ended, or a link was added: job cards may show a new queue state. */
  onQueueChanged?: () => void;
}

export function AutoApplyPanel({ refreshKey = 0, onQueueChanged }: AutoApplyPanelProps = {}) {
  const [state, setState] = useState<ApplyState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNoticeText] = useState<string | null>(null);
  const [noticeWarns, setNoticeWarns] = useState(false);
  const setNotice = useCallback((text: string | null) => {
    setNoticeText(text);
    setNoticeWarns(false);
  }, []);
  const [starting, setStarting] = useState(false);
  const [killing, setKilling] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [jobUrl, setJobUrl] = useState("");
  const [urlAction, setUrlAction] = useState<"apply" | "fill" | null>(null);

  const wasRunning = useRef(false);
  const lastQueued = useRef<number | null>(null);
  const queueChanged = useRef(onQueueChanged);
  useEffect(() => {
    queueChanged.current = onQueueChanged;
  }, [onQueueChanged]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchApplyState();
      if (wasRunning.current && !next.running) {
        const reason = next.lastRun?.skippedReason ?? null;
        setNoticeText(next.outOfCredits ? null : (reason ?? "Run finished"));
        setNoticeWarns(reason != null);
      }
      if (wasRunning.current !== next.running || lastQueued.current !== next.counts.queued) {
        queueChanged.current?.();
      }
      wasRunning.current = next.running;
      lastQueued.current = next.counts.queued;
      setState(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load auto-apply");
    }
  }, []);

  useEffect(() => {
    fetchApplyState()
      .then((next) => {
        wasRunning.current = next.running;
        lastQueued.current = next.counts.queued;
        setState(next);
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : "Could not load auto-apply"),
      );
  }, []);

  useEffect(() => {
    if (refreshKey === 0) return;
    fetchApplyState()
      .then((next) => {
        lastQueued.current = next.counts.queued;
        setState(next);
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : "Could not load auto-apply"),
      );
  }, [refreshKey]);

  const loaded = state !== null;
  const busy = Boolean(state?.running || state?.health.naukriLoginOpen);
  useEffect(() => {
    if (!loaded) return;
    const timer = setInterval(() => void load(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [loaded, busy, load]);

  async function naukriLogin() {
    setLoggingIn(true);
    setNotice(null);
    try {
      const res = await fetch("/api/naukri/login", { method: "POST" });
      const data = (await res.json()) as { error?: string; started?: boolean; reason?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not open the Naukri login");
      setNotice(
        data.started
          ? "Opened the Naukri login in its Chrome window (it may be behind this one). The login is saved once you finish."
          : (data.reason ?? "The Naukri login window is already open"),
      );
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not open the Naukri login");
    } finally {
      setLoggingIn(false);
    }
  }

  async function applyNow() {
    setStarting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/apply/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "now" }),
      });
      const data = (await res.json()) as { error?: string; started?: boolean; reason?: string; captcha?: number };
      if (!res.ok) throw new Error(data.error ?? "Could not start auto-apply");
      if (!data.started) setNotice(data.reason ?? "Nothing to apply to");
      else if (data.captcha) {
        setNotice(`Started in a Chrome window. ${data.captcha} need a captcha from you; it waits 3 minutes on each.`);
      } else setNotice("Started in a Chrome window");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not start auto-apply");
    } finally {
      setStarting(false);
    }
  }

  /** Apply submits like Apply now; fill fills the form, leaves it open and submits nothing. */
  async function sendUrl(action: "apply" | "fill") {
    if (!jobUrl.trim()) return;
    const fill = action === "fill";
    const failed = fill ? "Could not fill that link" : "Could not apply to that link";
    setUrlAction(action);
    setNotice(null);
    try {
      const res = await fetch("/api/apply/from-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: jobUrl, fill }),
      });
      const data = (await res.json()) as { error?: string; started?: boolean; queued?: boolean; reason?: string; company?: string };
      if (!res.ok) throw new Error(data.error ?? failed);
      if (data.started) {
        const company = data.company ?? "that job";
        setNotice(
          fill
            ? `Filling ${company} in a Chrome window. Nothing is submitted; the tab stays open for you.`
            : `Applying to ${company} in a Chrome window`,
        );
        setJobUrl("");
      } else {
        setNoticeText(data.reason ?? failed);
        setNoticeWarns(!data.queued);
        if (data.queued) setJobUrl("");
      }
      await load();
      queueChanged.current?.();
    } catch (err) {
      setNoticeText(err instanceof Error ? err.message : failed);
      setNoticeWarns(true);
    } finally {
      setUrlAction(null);
    }
  }

  function applyToUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendUrl("apply");
  }

  async function killRun() {
    setKilling(true);
    setNotice(null);
    try {
      const res = await fetch("/api/apply/stop", { method: "POST" });
      const data = (await res.json()) as { error?: string; stopped?: boolean; requeued?: number };
      if (!res.ok) throw new Error(data.error ?? "Could not stop the run");
      wasRunning.current = false;
      setNotice(
        data.stopped
          ? `Run stopped${data.requeued ? `; ${data.requeued} job${data.requeued === 1 ? "" : "s"} it was on went back in the queue` : ""}.`
          : "No run was going",
      );
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not stop the run");
    } finally {
      setKilling(false);
    }
  }

  if (loadError && !state) {
    return (
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Auto-apply</h2>
        <p className="mt-2 text-sm text-red-300">{loadError}</p>
      </section>
    );
  }
  if (!state) {
    return (
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Auto-apply</h2>
        <p className="mt-2 text-sm text-zinc-500">Loading…</p>
      </section>
    );
  }

  const { counts, dailyCap, running } = state;
  const parked = counts.needsYou + counts.needsAnswer;

  const leftToday = Math.max(0, dailyCap - counts.submittedToday);
  const applicable = counts.queued + counts.captcha;
  const applyDisabled = running || starting || leftToday === 0 || applicable === 0;
  const applyLabel = running
    ? "Applying…"
    : starting
      ? "Starting…"
      : leftToday === 0
        ? "Cap reached for today"
        : `Apply now · up to ${Math.min(leftToday, applicable)}`;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Auto-apply</h2>
          <p className="mt-1 text-sm text-zinc-400">
            {counts.submittedToday} of {dailyCap} sent today · {counts.queued} queued
            {counts.captcha > 0 && ` · ${counts.captcha} need a captcha`}
            {running && <span className="text-emerald-400"> · running now</span>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {running && (
            <button
              type="button"
              onClick={() => void killRun()}
              disabled={killing}
              title="Stops the run now. Jobs it was on go back in the queue."
              className={`min-h-11 flex-1 rounded-lg border border-zinc-700 px-4 text-sm text-zinc-200 hover:border-red-400/60 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none ${focusRing}`}
            >
              {killing ? "Killing…" : "Kill"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void applyNow()}
            disabled={applyDisabled}
            title="Opens Chrome and applies to queued jobs. Captchas wait for you."
            className={`min-h-11 flex-1 rounded-lg bg-emerald-500 px-4 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none ${focusRing}`}
          >
            {applyLabel}
          </button>
        </div>
      </div>

      <form onSubmit={applyToUrl} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="apply-job-url" className="sr-only">
          Job link to apply to
        </label>
        <input
          id="apply-job-url"
          type="url"
          inputMode="url"
          value={jobUrl}
          onChange={(e) => setJobUrl(e.target.value)}
          placeholder="Paste any job link to apply to it"
          autoComplete="off"
          className={`min-h-11 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 hover:border-zinc-500 ${focusRing}`}
        />
        <div className="flex shrink-0 gap-2">
          <button
            type="submit"
            disabled={urlAction !== null || !jobUrl.trim()}
            title="Opens the link in the apply Chrome and applies, like Apply now. LinkedIn links are refused."
            className={`min-h-11 flex-1 rounded-lg border border-emerald-500/50 px-4 text-sm font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none ${focusRing}`}
          >
            {urlAction === "apply" ? "Starting…" : "Apply"}
          </button>
          <button
            type="button"
            onClick={() => void sendUrl("fill")}
            disabled={urlAction !== null || !jobUrl.trim()}
            title="Fills the form in the apply Chrome and leaves the tab open. Nothing is submitted; you check and send it."
            className={`min-h-11 flex-1 rounded-lg border border-zinc-700 px-4 text-sm text-zinc-200 hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none ${focusRing}`}
          >
            {urlAction === "fill" ? "Starting…" : "Fill"}
          </button>
        </div>
      </form>

      <SystemHealthStrip health={state.health} loggingIn={loggingIn} onLogin={() => void naukriLogin()} />

      {state.outOfCredits && (
        <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm font-medium text-red-200">Auto-apply stopped: the AI provider is out of credits.</p>
          <p className="mt-1 text-sm text-red-200/80">
            Top up OpenRouter, then press Apply now. The job it stopped on is back in the queue.
          </p>
        </div>
      )}

      {parked > 0 ? (
        <p className="mt-4 text-sm text-zinc-300">
          {parked === 1 ? "1 application is parked" : `${parked} applications are parked`}. In chat, say: run the
          triage-apply-queue prompt.
        </p>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">Nothing is parked. The next run follows the 8am ingest.</p>
      )}

      {notice && (
        <p className={`mt-3 text-sm ${noticeWarns ? "text-amber-300" : "text-emerald-400"}`} aria-live="polite">
          {notice}
        </p>
      )}

    </section>
  );
}
