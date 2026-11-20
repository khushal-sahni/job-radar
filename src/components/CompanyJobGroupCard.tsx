"use client";

import { useState } from "react";
import { JobCard } from "@/components/JobCard";
import type { ApplicationStatus } from "@/lib/application-status";
import type { CompanyJobGroup } from "@/lib/company-groups";

interface CompanyJobGroupCardProps {
  group: CompanyJobGroup;
  onApplicationChange?: (
    jobId: string,
    status: ApplicationStatus | null,
    statusUpdatedAt: string | null,
  ) => void;
  onCompanyNotInterested?: (jobIds: string[]) => void | Promise<void>;
  onQueued?: (jobId: string) => void;
}

export function CompanyJobGroupCard({
  group,
  onApplicationChange,
  onCompanyNotInterested,
  onQueued,
}: CompanyJobGroupCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [primary, ...rest] = group.jobs;
  const extraCount = rest.length;
  const roleCount = group.jobs.length;

  if (!primary) return null;

  async function handleCompanyNotInterested() {
    if (!onCompanyNotInterested || skipping) return;

    const confirmed = window.confirm(
      roleCount === 1
        ? `Mark the role at ${group.company} as not interested?`
        : `Mark all ${roleCount} roles at ${group.company} as not interested?`,
    );
    if (!confirmed) return;

    setSkipping(true);
    try {
      await onCompanyNotInterested(group.jobs.map((j) => j.id));
    } finally {
      setSkipping(false);
    }
  }

  return (
    <div className="space-y-2">
      <JobCard
        key={primary.id}
        job={primary}
        onApplicationChange={onApplicationChange}
        onQueued={onQueued}
      />

      {extraCount > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2.5 text-left text-sm text-zinc-400 transition hover:border-zinc-600 hover:bg-zinc-900/70 hover:text-zinc-200"
          >
            <span>
              {expanded
                ? `Hide ${extraCount} more at ${group.company}`
                : `${extraCount} more role${extraCount === 1 ? "" : "s"} at ${group.company}`}
            </span>
            <span className="shrink-0 text-xs text-zinc-500" aria-hidden>
              {expanded ? "▲" : "▼"}
            </span>
          </button>

          {expanded && (
            <div className="space-y-3 border-l-2 border-zinc-800 pl-3">
              {rest.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onApplicationChange={onApplicationChange}
                  onQueued={onQueued}
                />
              ))}
            </div>
          )}
        </>
      )}

      {onCompanyNotInterested && (
        <button
          type="button"
          disabled={skipping}
          onClick={() => void handleCompanyNotInterested()}
          className="flex min-h-11 w-full items-center justify-center rounded-lg border border-zinc-800 px-4 py-2.5 text-sm text-zinc-500 transition hover:border-red-900/50 hover:bg-red-950/20 hover:text-red-300 disabled:opacity-50"
        >
          {skipping
            ? "Updating…"
            : `Not interested in ${group.company}`}
        </button>
      )}
    </div>
  );
}
