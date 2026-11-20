import { FeedClient } from "@/components/FeedClient";
import { fetchMatches } from "@/lib/matches";
import type { CountryFilter, JobMatch } from "@/lib/types";
import type { MatchFunnel } from "@/lib/rules";
import type { StatusFilter } from "@/lib/application-status";

export const dynamic = "force-dynamic";

export default async function FeedPage() {
  let jobs: JobMatch[] = [];
  let matched = 0;
  let totalForFilter = 0;
  let page = 1;
  let totalPages = 1;
  let statusCounts: Record<StatusFilter, number> | null = null;
  let countryCounts: Record<CountryFilter, number> | null = null;
  let queueableCount = 0;
  let hasResume = false;
  let yearsOfExperience = 4;
  let funnel: MatchFunnel | null = null;
  let lastIngestAt: string | null = null;
  let dbError: string | null = null;

  try {
    const result = await fetchMatches({
      page: 1,
      pageSize: 10,
      dateRange: "7d",
      statusFilter: "open",
    });
    jobs = result.jobs;
    matched = result.matched;
    totalForFilter = result.totalForFilter;
    page = result.page;
    totalPages = result.totalPages;
    statusCounts = result.statusCounts;
    countryCounts = result.countryCounts;
    queueableCount = result.queueableCount;
    hasResume = result.hasResume;
    yearsOfExperience = result.yearsOfExperience;
    funnel = result.funnel;
    lastIngestAt = result.lastIngestAt;
  } catch (error) {
    dbError = error instanceof Error ? error.message : "Database connection failed";
  }

  return (
    <FeedClient
      initialJobs={jobs}
      initialMatched={matched}
      initialTotalForFilter={totalForFilter}
      initialPage={page}
      initialTotalPages={totalPages}
      initialStatusCounts={statusCounts}
      initialCountryCounts={countryCounts}
      initialQueueableCount={queueableCount}
      initialHasResume={hasResume}
      initialYearsOfExperience={yearsOfExperience}
      initialFunnel={funnel}
      initialLastIngestAt={lastIngestAt}
      dbError={dbError}
    />
  );
}
