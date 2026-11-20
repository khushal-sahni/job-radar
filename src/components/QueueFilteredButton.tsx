"use client";

import type { CSSProperties } from "react";

const NIGHT_SKY: CSSProperties = {
  backgroundImage: [
    "radial-gradient(1px 1px at 14% 28%, rgba(255,255,255,0.95), transparent)",
    "radial-gradient(1px 1px at 38% 70%, rgba(255,255,255,0.7), transparent)",
    "radial-gradient(1.5px 1.5px at 63% 24%, rgba(255,255,255,0.85), transparent)",
    "radial-gradient(1px 1px at 82% 62%, rgba(255,255,255,0.6), transparent)",
    "radial-gradient(1px 1px at 92% 20%, rgba(255,255,255,0.75), transparent)",
    "radial-gradient(1px 1px at 26% 88%, rgba(255,255,255,0.5), transparent)",
    "radial-gradient(90% 130% at 0% 0%, rgba(56,189,248,0.35), transparent 60%)",
    "radial-gradient(90% 130% at 100% 100%, rgba(217,70,239,0.4), transparent 60%)",
    "linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%)",
  ].join(", "),
};

interface QueueFilteredButtonProps {
  count: number;
  /** The filter shows jobs, but every one is already waiting or done. */
  allQueued: boolean;
  queuing: boolean;
  onQueue: () => void;
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 shrink-0 text-indigo-100">
      <path
        fill="currentColor"
        d="M8 0.5l1.6 4.4L14 6.5l-4.4 1.6L8 12.5 6.4 8.1 2 6.5l4.4-1.6L8 0.5zM13 10.5l0.7 1.8 1.8 0.7-1.8 0.7-0.7 1.8-0.7-1.8-1.8-0.7 1.8-0.7 0.7-1.8z"
      />
    </svg>
  );
}

/** Puts every job the current feed filters show (all pages) in the auto-apply queue. */
export function QueueFilteredButton({ count, allQueued, queuing, onQueue }: QueueFilteredButtonProps) {
  const disabled = queuing || count === 0;
  const label = queuing ? "Queuing…" : count > 0 ? "Queue these" : allQueued ? "All queued" : "Nothing to queue";

  return (
    <button
      type="button"
      onClick={onQueue}
      disabled={disabled}
      style={NIGHT_SKY}
      title="Put every job these filters show, on every page, in the auto-apply queue"
      className="inline-flex min-h-11 w-full items-center justify-center gap-2.5 rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/50 ring-1 ring-inset ring-white/15 transition hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 md:w-auto"
    >
      <SparkleIcon />
      <span>{label}</span>
      {count > 0 && !queuing && (
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-medium tabular-nums text-indigo-50">
          {count}
        </span>
      )}
    </button>
  );
}
