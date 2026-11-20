import type { ApplicationStatus, StatusFilter } from "@/lib/application-status";
import { jobsVisibleForFilter } from "@/lib/company-group-state";
import { isStillToApply } from "@/lib/queue-state";
import { BRANCH_COUNTRY, MANUAL_SOURCE, type CountryFilter, type JobMatch } from "@/lib/types";

export function isManualJob(job: Pick<JobMatch, "source">): boolean {
  return job.source === MANUAL_SOURCE;
}

function countryForMatch(job: JobMatch): CountryFilter | null {
  const branchId = job.match.branchId;
  return branchId ? (BRANCH_COUNTRY[branchId] ?? null) : null;
}

export interface FeedFilter {
  branchId: string | null;
  statusFilter: StatusFilter;
  country: CountryFilter;
}

/** The feed's branch → status → country narrowing. Pasted-link jobs pass every branch and country. */
export function filterFeed(
  matches: JobMatch[],
  { branchId, statusFilter, country }: FeedFilter,
): {
  byBranch: JobMatch[];
  filtered: JobMatch[];
  statusCounts: Record<StatusFilter, number>;
  countryCounts: Record<CountryFilter, number>;
} {
  const byBranch =
    branchId == null
      ? matches
      : matches.filter((job) => isManualJob(job) || job.match.branchId === branchId);

  const statusCounts: Record<StatusFilter, number> = {
    open: 0,
    all: byBranch.length,
    applied: 0,
    not_interested: 0,
    saved: 0,
    interviewing: 0,
    rejected: 0,
    offer: 0,
  };
  for (const job of byBranch) {
    if (job.applicationStatus) {
      statusCounts[job.applicationStatus as ApplicationStatus] += 1;
    } else if (isStillToApply(job)) {
      statusCounts.open += 1;
    }
  }

  const byStatus = jobsVisibleForFilter(byBranch, statusFilter);

  const countryCounts: Record<CountryFilter, number> = {
    all: byStatus.length,
    IN: 0,
    DE: 0,
    JP: 0,
  };
  for (const job of byStatus) {
    if (isManualJob(job)) {
      countryCounts.IN += 1;
      countryCounts.DE += 1;
      countryCounts.JP += 1;
      continue;
    }
    const jobCountry = countryForMatch(job);
    if (jobCountry && jobCountry !== "all") countryCounts[jobCountry] += 1;
  }

  const filtered =
    country === "all"
      ? byStatus
      : byStatus.filter((job) => isManualJob(job) || countryForMatch(job) === country);

  return { byBranch, filtered, statusCounts, countryCounts };
}
