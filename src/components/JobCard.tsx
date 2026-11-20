"use client";

import { useEffect, useState } from "react";
import { formatPostedDate, formatSalaryRange } from "@/lib/fx";
import { formatRequiredYears } from "@/lib/yoe";
import {
  APPLICATION_STATUSES,
  STATUS_BADGE_CLASS,
  STATUS_CARD_CLASS,
  STATUS_LABELS,
  type ApplicationStatus,
} from "@/lib/application-status";
import { QUEUE_BADGE, isQueueable, queueButtonLabel } from "@/lib/queue-state";
import type { JobMatch } from "@/lib/types";

interface JobCardProps {
  job: JobMatch;
  onApplicationChange?: (
    jobId: string,
    status: ApplicationStatus | null,
    statusUpdatedAt: string | null,
  ) => void;
  onQueued?: (jobId: string) => void;
}

export function JobCard({ job, onApplicationChange, onQueued }: JobCardProps) {
  const [applicationStatus, setApplicationStatus] = useState<
    ApplicationStatus | null
  >(job.applicationStatus);
  const [statusUpdatedAt, setStatusUpdatedAt] = useState(job.statusUpdatedAt);
  const [saving, setSaving] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  // Keep local status in sync when the job identity or server status changes
  // (e.g. sibling becomes primary after another role leaves the group).
  useEffect(() => {
    setApplicationStatus(job.applicationStatus);
    setStatusUpdatedAt(job.statusUpdatedAt);
  }, [job.id, job.applicationStatus, job.statusUpdatedAt]);

  const salary = formatSalaryRange(
    job.salaryMin,
    job.salaryMax,
    job.salaryCurrency,
    job.salaryINRMin,
    job.salaryINRMax,
    job.salaryEstimated,
  );

  const yoeLabel = formatRequiredYears(
    job.requiredYearsMin,
    job.requiredYearsMax,
  );

  async function updateStatus(next: ApplicationStatus | "") {
    setSaving(true);
    try {
      if (next === "") {
        const res = await fetch(`/api/jobs/${job.id}/application`, {
          method: "DELETE",
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Failed to update");

        setApplicationStatus(null);
        setStatusUpdatedAt(null);
        onApplicationChange?.(job.id, null, null);
        return;
      }

      const res = await fetch(`/api/jobs/${job.id}/application`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = (await res.json()) as {
        error?: string;
        status?: ApplicationStatus;
        statusUpdatedAt?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to update");

      setApplicationStatus(next);
      const updatedAt = data.statusUpdatedAt ?? new Date().toISOString();
      setStatusUpdatedAt(updatedAt);
      onApplicationChange?.(job.id, next, updatedAt);
    } catch {
      // keep previous state on failure
    } finally {
      setSaving(false);
    }
  }

  async function queueJob() {
    setQueuing(true);
    setQueueError(null);
    try {
      const res = await fetch("/api/apply/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = (await res.json()) as { error?: string; queued?: number };
      if (!res.ok) throw new Error(data.error ?? "Could not queue");
      if (!data.queued) throw new Error("Already waiting or applied");
      onQueued?.(job.id);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : "Could not queue");
    } finally {
      setQueuing(false);
    }
  }

  const queueBadge = job.queueStatus ? QUEUE_BADGE[job.queueStatus] : undefined;
  const canQueue = isQueueable({ ...job, applicationStatus });

  const cardClass = applicationStatus
    ? STATUS_CARD_CLASS[applicationStatus]
    : "border-zinc-800 bg-zinc-900/60 hover:border-emerald-500/40 hover:bg-zinc-900";

  const dimmed =
    applicationStatus === "applied" ||
    applicationStatus === "not_interested" ||
    applicationStatus === "rejected";

  return (
    <article className={`group rounded-2xl border p-5 transition ${cardClass}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3
            className={`text-lg font-semibold ${
              dimmed
                ? "text-zinc-400 line-through decoration-zinc-600"
                : "text-zinc-50 group-hover:text-emerald-300"
            }`}
          >
            {job.title}
          </h3>
          <p className="mt-1 text-sm text-zinc-400">
            {job.company}
            {job.location ? ` · ${job.location}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {queueBadge && !applicationStatus && (
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${queueBadge.className}`}>
              {queueBadge.label}
            </span>
          )}
          {applicationStatus && (
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE_CLASS[applicationStatus]}`}
            >
              {STATUS_LABELS[applicationStatus]}
              {statusUpdatedAt
                ? ` · ${formatPostedDate(statusUpdatedAt)}`
                : ""}
            </span>
          )}
          {job.match.matched && job.match.branchLabel && (
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300">
              {job.match.branchLabel}
            </span>
          )}
          {job.isRemote && (
            <span className="rounded-full bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-300">
              Remote{job.remoteScope ? ` · ${job.remoteScope}` : ""}
            </span>
          )}
          {job.visaSponsorship && (
            <span className="rounded-full bg-violet-500/15 px-3 py-1 text-xs font-medium text-violet-300">
              Visa sponsor
            </span>
          )}
          {!job.salaryVerified && (
            <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-300">
              No salary info
            </span>
          )}
          {!job.visaVerified &&
            (job.country === "DE" || job.country === "JP") && (
              <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-300">
                Visa not confirmed
              </span>
            )}
          {yoeLabel && (
            <span className="rounded-full bg-orange-500/15 px-3 py-1 text-xs font-medium text-orange-300">
              Requires {yoeLabel}
            </span>
          )}
          {job.fitScore > 0 && (
            <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-300">
              {job.fitScore}% fit
            </span>
          )}
        </div>
      </div>

      <p className="mt-3 text-sm font-medium text-zinc-200">{salary}</p>

      {job.match.matched && job.match.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-zinc-400">
          {job.match.reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
              {reason}
            </li>
          ))}
        </ul>
      )}

      {job.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {job.tags.slice(0, 8).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          {job.source}
          {job.postedAt ? ` · ${formatPostedDate(job.postedAt)}` : ""}
        </span>
        <div className="flex flex-wrap gap-2">
          <select
            value={applicationStatus ?? ""}
            disabled={saving}
            onChange={(e) => void updateStatus(e.target.value as ApplicationStatus | "")}
            className="rounded-lg border border-zinc-600 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 disabled:opacity-50"
          >
            <option value="">To apply</option>
            {APPLICATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          {!applicationStatus && (
            <button
              type="button"
              onClick={() => void queueJob()}
              disabled={!canQueue || queuing}
              title={canQueue ? "Add this job to the auto-apply queue" : undefined}
              className="rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-200 transition hover:border-indigo-300/70 hover:bg-indigo-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-indigo-500/10"
            >
              {queuing ? "Queuing…" : queueButtonLabel(job)}
            </button>
          )}
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
          >
            View posting
          </a>
        </div>
      </div>
      {queueError && (
        <p role="status" className="mt-2 text-right text-xs text-amber-300">
          {queueError}
        </p>
      )}
    </article>
  );
}
