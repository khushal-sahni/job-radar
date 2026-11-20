import { db } from "@/lib/db";
import { getLastIngestAt } from "@/lib/ingest";
import { getLatestResume } from "@/lib/resume-store";
import { getActiveRules } from "@/lib/rule-store";
import { scoreResumeFit } from "@/lib/match";
import {
  compileExcludeKeywords,
  getPreferences,
  matchExcludeKeyword,
} from "@/lib/preferences";
import {
  classifyRejection,
  createEmptyFunnel,
  evaluateJob,
  type MatchFunnel,
} from "@/lib/rules";
import {
  COUNTRY_FILTERS,
  DEFAULT_RULES,
  MANUAL_SOURCE,
  type CountryFilter,
  type DateRange,
  type JobMatch,
  type MatchResult,
  type QueueStatus,
  type RuleBranch,
} from "@/lib/types";
import type { Job } from "@/generated/prisma/client";
import { isQueueable } from "@/lib/queue-state";
import { toAppStatus, type StatusFilter } from "@/lib/application-status";
import { filterFeed, isManualJob, type FeedFilter } from "@/lib/feed-filter";
import {
  isEligibleByYears,
  parseRequiredYears,
} from "@/lib/yoe";
import { groupJobsByCompany } from "@/lib/company-groups";
import { isExclusiveAvoidedLanguageJob } from "@/lib/language-fit";
import { gateJobgether, type JobgetherGate } from "@/lib/jobgether";
import { isRelevantRole } from "@/lib/enrich";

function resolveRequiredYearsMin(
  stored: number | null | undefined,
  title: string,
  description: string,
): number | null {
  if (stored != null) return stored;
  const parsed = parseRequiredYears(`${title}\n${description}`);
  return parsed.min ?? null;
}

function getDateCutoff(dateRange: DateRange): Date | null {
  if (dateRange === "all") return null;
  const days = dateRange === "1d" ? 1 : dateRange === "7d" ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function indiaGeoRank(job: JobMatch): number {
  if (job.country === "IN" || job.remoteScope === "india") return 2;
  if (job.remoteScope === "worldwide") return 1;
  return 0;
}

function compareMatches(a: JobMatch, b: JobMatch): number {
  if (isManualJob(a) !== isManualJob(b)) return isManualJob(a) ? -1 : 1;
  if (b.fitScore !== a.fitScore) return b.fitScore - a.fitScore;
  const geoDiff = indiaGeoRank(b) - indiaGeoRank(a);
  if (geoDiff !== 0) return geoDiff;
  if (Number(b.salaryVerified) !== Number(a.salaryVerified)) {
    return Number(b.salaryVerified) - Number(a.salaryVerified);
  }
  if (Number(b.visaVerified) !== Number(a.visaVerified)) {
    return Number(b.visaVerified) - Number(a.visaVerified);
  }
  const aDate = a.postedAt ? new Date(a.postedAt).getTime() : 0;
  const bDate = b.postedAt ? new Date(b.postedAt).getTime() : 0;
  return bDate - aDate;
}

type StoredJob = Job & {
  application: { status: string; updatedAt: Date } | null;
  applyTask: { status: QueueStatus; code: string | null } | null;
};

function toJobMatch(
  job: StoredJob,
  ruleJob: Pick<Job, "country" | "remoteScope">,
  match: MatchResult,
  requiredMin: number | null,
  fit: { score: number; reasons: string[] },
): JobMatch {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    url: job.url,
    location: job.location,
    country: ruleJob.country,
    isRemote: job.isRemote,
    remoteScope: ruleJob.remoteScope,
    visaSponsorship: job.visaSponsorship,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    salaryINRMin: job.salaryINRMin,
    salaryINRMax: job.salaryINRMax,
    salaryEstimated: job.salaryEstimated,
    salaryVerified: match.salaryVerified ?? job.salaryVerified,
    visaVerified: match.visaVerified ?? job.visaVerified,
    isBaseSalary: job.isBaseSalary,
    tags: job.tags,
    source: job.source,
    postedAt: job.postedAt?.toISOString() ?? null,
    applicationStatus: toAppStatus(job.application?.status),
    statusUpdatedAt: job.application?.updatedAt.toISOString() ?? null,
    queueStatus: job.applyTask?.status ?? null,
    queueCode: job.applyTask?.code ?? null,
    requiredYearsMin: requiredMin,
    requiredYearsMax: job.requiredYearsMax,
    match,
    fitScore: fit.score,
    fitReasons: fit.reasons,
  };
}

function withJobgetherCountry<T extends Job>(job: T, gate: JobgetherGate): T {
  if (gate.kind !== "keep") return job;
  return {
    ...job,
    country: gate.country,
    remoteScope: gate.country === "IN" ? (job.isRemote ? "india" : job.remoteScope) : "region_locked",
  };
}

/** Whether a stored job still passes the preference rules, as the feed would judge it. */
export function stillMatchesRules(job: Job, rules: RuleBranch[]): boolean {
  if (job.source === MANUAL_SOURCE) return true;
  if (!isRelevantRole(job.title, job.description)) return false;
  const gate = gateJobgether(job.company, job.location);
  if (gate.kind === "drop") return false;
  return evaluateJob(withJobgetherCountry(job, gate), rules).matched;
}

/**
 * Every active job in the date range that passes the feed's filters and rules, best first.
 * Pasted-link jobs skip every check and come first.
 */
export async function listMatchedJobs(dateRange: DateRange): Promise<{
  matches: JobMatch[];
  funnel: MatchFunnel;
  hasResume: boolean;
  yearsOfExperience: number;
  lastIngestAt: Date | null;
}> {
  const cutoff = getDateCutoff(dateRange);

  const dateFilter =
    cutoff == null
      ? {}
      : {
          OR: [
            { postedAt: { gte: cutoff } },
            { postedAt: null, fetchedAt: { gte: cutoff } },
          ],
        };

  const [rules, resume, prefs, jobs, lastIngestAt] = await Promise.all([
    getActiveRules(),
    getLatestResume(),
    getPreferences(),
    db.job.findMany({
      where: { isActive: true, ...dateFilter },
      include: { application: true, applyTask: { select: { status: true, code: true } } },
      orderBy: [{ postedAt: "desc" }, { fetchedAt: "desc" }],
    }),
    getLastIngestAt(),
  ]);

  const resumeProfile = resume
    ? {
        skills: resume.skills,
        seniority: resume.seniority ?? undefined,
        roles: resume.roles,
        rawText: resume.rawText,
      }
    : null;

  const matches: JobMatch[] = [];
  const funnel = createEmptyFunnel(jobs.length);
  const userYears = prefs.yearsOfExperience;
  const excludeMatchers = compileExcludeKeywords(prefs.excludeTitleKeywords ?? []);
  const avoidLanguages = prefs.avoidIfExclusiveLanguages ?? [];
  const resumeSkills = resumeProfile?.skills ?? [];

  for (const job of jobs) {
    if (job.source === MANUAL_SOURCE) {
      matches.push(
        toJobMatch(job, job, { matched: true, reasons: ["Added from a pasted link"] }, job.requiredYearsMin, {
          score: 0,
          reasons: [],
        }),
      );
      continue;
    }

    if (!isRelevantRole(job.title, job.description)) {
      funnel.keywordExcluded += 1;
      continue;
    }

    const jobgether = gateJobgether(job.company, job.location);
    if (jobgether.kind === "drop") {
      funnel.jobgetherExcluded += 1;
      continue;
    }

    if (matchExcludeKeyword(job, excludeMatchers)) {
      funnel.keywordExcluded += 1;
      continue;
    }

    if (
      isExclusiveAvoidedLanguageJob({
        title: job.title,
        description: job.description,
        tags: job.tags,
        resumeSkills,
        avoidLanguages,
      })
    ) {
      funnel.languageExcluded += 1;
      continue;
    }

    const requiredMin = resolveRequiredYearsMin(
      job.requiredYearsMin,
      job.title,
      job.description,
    );

    if (!isEligibleByYears(requiredMin, userYears)) {
      funnel.yoeRejected += 1;
      continue;
    }

    const ruleJob = withJobgetherCountry(job, jobgether);
    const match = evaluateJob(ruleJob, rules);
    if (!match.matched) {
      const category = classifyRejection(match.reasons[0] ?? "");
      switch (category) {
        case "not_remote":
          funnel.notRemote += 1;
          break;
        case "not_eligible_from_india":
          funnel.notEligibleFromIndia += 1;
          break;
        case "salary_below_threshold":
          funnel.salaryBelowThreshold += 1;
          break;
        case "not_in_target_country":
          funnel.notInTargetCountry += 1;
          break;
        case "visa_rejected":
          funnel.visaRejected += 1;
          break;
        case "base_not_confirmed":
          funnel.baseNotConfirmed += 1;
          break;
        default:
          funnel.noMatchingRule += 1;
      }
      continue;
    }

    funnel.matched += 1;
    if (!match.salaryVerified) funnel.salaryUnverified += 1;
    if (!match.visaVerified) funnel.visaUnverified += 1;

    if (requiredMin != null) {
      match.reasons.push(
        `Experience fit (${requiredMin}+ yrs required, you have ${userYears})`,
      );
    }

    const fit = scoreResumeFit(resumeProfile, job.title, job.description, job.tags);
    matches.push(toJobMatch(job, ruleJob, match, requiredMin, fit));
  }

  matches.sort(compareMatches);

  return {
    matches,
    funnel,
    hasResume: Boolean(resume),
    yearsOfExperience: userYears,
    lastIngestAt,
  };
}

/** Every job the feed shows for these filters, across all pages. */
export async function listFeedJobs(dateRange: DateRange, filter: FeedFilter): Promise<JobMatch[]> {
  const { matches } = await listMatchedJobs(dateRange);
  return filterFeed(matches, filter).filtered;
}

export async function fetchMatches(options?: {
  page?: number;
  pageSize?: number;
  dateRange?: DateRange;
  statusFilter?: StatusFilter;
  branchId?: string | null;
  country?: CountryFilter;
}): Promise<{
  jobs: JobMatch[];
  matched: number;
  totalForFilter: number;
  page: number;
  pageSize: number;
  totalPages: number;
  statusCounts: Record<StatusFilter, number>;
  countryCounts: Record<CountryFilter, number>;
  /** Jobs across every page of this filter that the queue button would add. */
  queueableCount: number;
  hasResume: boolean;
  yearsOfExperience: number;
  funnel: MatchFunnel;
  dateRange: DateRange;
  branchId: string | null;
  country: CountryFilter;
  lastIngestAt: string | null;
}> {
  const page = Math.max(1, options?.page ?? 1);
  const pageSize = Math.min(Math.max(1, options?.pageSize ?? 10), 50);
  const dateRange = options?.dateRange ?? "7d";
  const statusFilter = options?.statusFilter ?? "open";
  const branchId = options?.branchId ?? null;
  const country = options?.country ?? "all";

  const { matches, funnel, hasResume, yearsOfExperience, lastIngestAt } =
    await listMatchedJobs(dateRange);
  const { byBranch, filtered, statusCounts, countryCounts } = filterFeed(matches, {
    branchId,
    statusFilter,
    country,
  });

  // Paginate by company so sibling roles stay on the same page
  const companyGroups = groupJobsByCompany(filtered);
  const totalPages = Math.max(1, Math.ceil(companyGroups.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageGroups = companyGroups.slice(start, start + pageSize);

  return {
    jobs: pageGroups.flatMap((g) => g.jobs),
    matched: byBranch.length,
    totalForFilter: companyGroups.length,
    page: safePage,
    pageSize,
    totalPages,
    statusCounts,
    countryCounts,
    queueableCount: filtered.filter(isQueueable).length,
    hasResume,
    yearsOfExperience,
    funnel,
    dateRange,
    branchId,
    country,
    lastIngestAt: lastIngestAt?.toISOString() ?? null,
  };
}

// ---------- Query parsing ----------

const BRANCH_IDS = new Set(DEFAULT_RULES.map((r) => r.id));

function parseDateRange(value: string | null): DateRange {
  if (value === "1d" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }
  return "7d";
}

function parseStatusFilter(value: string | null): StatusFilter {
  const allowed: StatusFilter[] = [
    "open",
    "all",
    "applied",
    "not_interested",
    "saved",
    "interviewing",
    "rejected",
    "offer",
  ];
  if (value && allowed.includes(value as StatusFilter)) {
    return value as StatusFilter;
  }
  return "open";
}

function parseBranchId(value: string | null): string | null {
  if (!value || value === "all") return null;
  return BRANCH_IDS.has(value) ? value : null;
}

function parseCountry(value: string | null): CountryFilter {
  const match = COUNTRY_FILTERS.find((c) => c.id === value);
  return match?.id ?? "all";
}

export type MatchQuery = NonNullable<Parameters<typeof fetchMatches>[0]>;

/** Feed filters from a URL query; anything unknown falls back to the default view. */
export function parseMatchQuery(params: URLSearchParams): MatchQuery {
  return {
    page: Number(params.get("page") ?? 1),
    pageSize: Number(params.get("pageSize") ?? 10),
    dateRange: parseDateRange(params.get("dateRange")),
    statusFilter: parseStatusFilter(params.get("statusFilter")),
    branchId: parseBranchId(params.get("branchId")),
    country: parseCountry(params.get("country")),
  };
}
