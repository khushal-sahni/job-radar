"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AutoApplyPanel } from "@/components/AutoApplyPanel";
import { CompanyJobGroupCard } from "@/components/CompanyJobGroupCard";
import { QueueFilteredButton } from "@/components/QueueFilteredButton";
import { ResumeUpload } from "@/components/ResumeUpload";
import {
  emptyMessageForFilter,
  STATUS_FILTERS,
  type ApplicationStatus,
  type StatusFilter,
} from "@/lib/application-status";
import { groupJobsByCompany } from "@/lib/company-groups";
import {
  applyGroupAction,
  jobsVisibleForFilter,
} from "@/lib/company-group-state";
import type { MatchFunnel } from "@/lib/rules";
import {
  COUNTRY_FILTERS,
  DATE_RANGES,
  DEFAULT_RULES,
  RULE_LABELS,
  type CountryFilter,
  type DateRange,
  type JobMatch,
} from "@/lib/types";

const EMPTY_STATUS_COUNTS: Record<StatusFilter, number> = {
  open: 0,
  all: 0,
  applied: 0,
  not_interested: 0,
  saved: 0,
  interviewing: 0,
  rejected: 0,
  offer: 0,
};

const EMPTY_COUNTRY_COUNTS: Record<CountryFilter, number> = {
  all: 0,
  IN: 0,
  DE: 0,
  JP: 0,
};

interface FeedClientProps {
  initialJobs: JobMatch[];
  initialMatched: number;
  initialTotalForFilter: number;
  initialPage: number;
  initialTotalPages: number;
  initialStatusCounts: Record<StatusFilter, number> | null;
  initialCountryCounts?: Record<CountryFilter, number> | null;
  initialQueueableCount?: number;
  initialHasResume: boolean;
  initialYearsOfExperience: number;
  initialFunnel?: MatchFunnel | null;
  initialLastIngestAt?: string | null;
  dbError?: string | null;
}

function formatLastIngest(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function FunnelBar({ funnel }: { funnel: MatchFunnel }) {
  const afterJobgether = funnel.total - funnel.jobgetherExcluded;
  const afterKeyword = afterJobgether - funnel.keywordExcluded;
  const afterLang = afterKeyword - funnel.languageExcluded;
  const afterYoe = afterLang - funnel.yoeRejected;
  const ruleRejected =
    funnel.notRemote +
    funnel.notEligibleFromIndia +
    funnel.notInTargetCountry +
    funnel.salaryBelowThreshold +
    funnel.visaRejected +
    funnel.baseNotConfirmed +
    funnel.noMatchingRule;

  const steps = [
    { label: "In range", count: funnel.total },
    { label: "Jobgether off-country", count: funnel.jobgetherExcluded },
    { label: "Keyword excluded", count: funnel.keywordExcluded },
    { label: "Language excluded", count: funnel.languageExcluded },
    { label: "YOE filtered", count: funnel.yoeRejected },
    { label: "After filters", count: afterYoe },
    { label: "Rule rejected", count: ruleRejected },
    { label: "Matched", count: funnel.matched, highlight: true },
  ];

  const ruleBreakdown = [
    { label: "Jobgether off-country", count: funnel.jobgetherExcluded },
    { label: "Keyword", count: funnel.keywordExcluded },
    { label: "Exclusive language", count: funnel.languageExcluded },
    { label: "No rule match", count: funnel.noMatchingRule },
    { label: "Wrong location", count: funnel.notInTargetCountry + funnel.notRemote + funnel.notEligibleFromIndia },
    { label: "Low salary", count: funnel.salaryBelowThreshold },
    { label: "CTC not base", count: funnel.baseNotConfirmed },
    { label: "No visa", count: funnel.visaRejected },
  ].filter((s) => s.count > 0);

  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Rejection funnel
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-400">
        {steps.map((step, index) => (
          <span key={step.label} className="flex items-center gap-2">
            {index > 0 && <span className="text-zinc-600">→</span>}
            <span className={step.highlight ? "font-medium text-emerald-400" : ""}>
              {step.count} {step.label.toLowerCase()}
            </span>
          </span>
        ))}
      </div>
      {ruleBreakdown.length > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          Rule rejections:{" "}
          {ruleBreakdown.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(" · ")}
        </p>
      )}
      {(funnel.salaryUnverified > 0 || funnel.visaUnverified > 0) && (
        <p className="mt-2 text-xs text-amber-400/90">
          Of matched: {funnel.salaryUnverified} without salary info
          {funnel.visaUnverified > 0
            ? ` · ${funnel.visaUnverified} without confirmed visa`
            : ""}
        </p>
      )}
    </div>
  );
}

export function FeedClient({
  initialJobs,
  initialMatched,
  initialTotalForFilter,
  initialPage,
  initialTotalPages,
  initialStatusCounts,
  initialCountryCounts,
  initialQueueableCount,
  initialHasResume,
  initialYearsOfExperience,
  initialFunnel,
  initialLastIngestAt,
  dbError,
}: FeedClientProps) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);
  const [matched, setMatched] = useState(initialMatched);
  const [totalForFilter, setTotalForFilter] = useState(initialTotalForFilter);
  const [page, setPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [statusCounts, setStatusCounts] = useState<Record<StatusFilter, number>>(
    initialStatusCounts ?? EMPTY_STATUS_COUNTS,
  );
  const [funnel, setFunnel] = useState<MatchFunnel | null>(initialFunnel ?? null);
  const [lastIngestAt, setLastIngestAt] = useState<string | null>(
    initialLastIngestAt ?? null,
  );
  const [hasResume] = useState(initialHasResume);
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [branchId, setBranchId] = useState<string | null>(null);
  const [country, setCountry] = useState<CountryFilter>("all");
  const [countryCounts, setCountryCounts] = useState<
    Record<CountryFilter, number>
  >(initialCountryCounts ?? EMPTY_COUNTRY_COUNTS);
  const [ingesting, setIngesting] = useState(false);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [error, setError] = useState<string | null>(dbError ?? null);
  const [ingestResult, setIngestResult] = useState<string | null>(null);
  const [ingestErrors, setIngestErrors] = useState<string[]>([]);
  const [queueableCount, setQueueableCount] = useState(initialQueueableCount ?? 0);
  const [queuing, setQueuing] = useState(false);
  const [queueResult, setQueueResult] = useState<string | null>(null);
  /** Bumped whenever the feed changes the queue, so the auto-apply panel refetches its counts. */
  const [queueVersion, setQueueVersion] = useState(0);

  const loadMatches = useCallback(
    async (
      nextRange: DateRange,
      nextFilter: StatusFilter,
      nextPage: number,
      nextBranchId: string | null = null,
      nextCountry: CountryFilter = "all",
    ) => {
      setLoadingMatches(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          dateRange: nextRange,
          statusFilter: nextFilter,
          page: String(nextPage),
          pageSize: "10",
        });
        if (nextBranchId) params.set("branchId", nextBranchId);
        if (nextCountry !== "all") params.set("country", nextCountry);
        const res = await fetch(`/api/matches?${params}`);
        const data = (await res.json()) as {
          error?: string;
          jobs?: JobMatch[];
          matched?: number;
          totalForFilter?: number;
          page?: number;
          totalPages?: number;
          statusCounts?: Record<StatusFilter, number>;
          countryCounts?: Record<CountryFilter, number>;
          queueableCount?: number;
          funnel?: MatchFunnel;
          lastIngestAt?: string | null;
        };

        if (!res.ok) throw new Error(data.error ?? "Failed to load matches");

        setJobs(data.jobs ?? []);
        setMatched(data.matched ?? 0);
        setTotalForFilter(data.totalForFilter ?? 0);
        setPage(data.page ?? 1);
        setTotalPages(data.totalPages ?? 1);
        if (data.statusCounts) setStatusCounts(data.statusCounts);
        if (data.countryCounts) setCountryCounts(data.countryCounts);
        setQueueableCount(data.queueableCount ?? 0);
        setFunnel(data.funnel ?? null);
        if (data.lastIngestAt !== undefined) {
          setLastIngestAt(data.lastIngestAt);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load matches");
      } finally {
        setLoadingMatches(false);
      }
    },
    [],
  );

  async function handleDateRangeChange(nextRange: DateRange) {
    setDateRange(nextRange);
    setQueueResult(null);
    await loadMatches(nextRange, statusFilter, 1, branchId, country);
  }

  async function handleStatusFilterChange(nextFilter: StatusFilter) {
    setStatusFilter(nextFilter);
    setQueueResult(null);
    await loadMatches(dateRange, nextFilter, 1, branchId, country);
  }

  async function handleBranchFilterChange(nextBranchId: string | null) {
    setBranchId(nextBranchId);
    setQueueResult(null);
    await loadMatches(dateRange, statusFilter, 1, nextBranchId, country);
  }

  async function handleCountryChange(nextCountry: CountryFilter) {
    setCountry(nextCountry);
    setQueueResult(null);
    await loadMatches(dateRange, statusFilter, 1, branchId, nextCountry);
  }

  async function handlePageChange(nextPage: number) {
    await loadMatches(dateRange, statusFilter, nextPage, branchId, country);
  }

  async function queueFiltered() {
    setQueuing(true);
    setQueueResult(null);
    try {
      const filter: Record<string, string> = { dateRange, statusFilter, country };
      if (branchId) filter.branchId = branchId;
      const res = await fetch("/api/apply/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter }),
      });
      const data = (await res.json()) as { error?: string; queued?: number; alreadyWaiting?: number };
      if (!res.ok) throw new Error(data.error ?? "Could not queue jobs");
      const queued = data.queued ?? 0;
      const waiting = data.alreadyWaiting ?? 0;
      setQueueResult(
        `Queued ${queued} job${queued === 1 ? "" : "s"}${waiting > 0 ? ` · ${waiting} already waiting` : ""}. Apply now sends them.`,
      );
      setQueueVersion((v) => v + 1);
      await loadMatches(dateRange, statusFilter, page, branchId, country);
    } catch (err) {
      setQueueResult(err instanceof Error ? err.message : "Could not queue jobs");
    } finally {
      setQueuing(false);
    }
  }

  function handleJobQueued(jobId: string) {
    setJobs((prev) => prev.map((job) => (job.id === jobId ? { ...job, queueStatus: "QUEUED", queueCode: null } : job)));
    setQueueableCount((n) => Math.max(0, n - 1));
    setQueueVersion((v) => v + 1);
  }

  const reloadMatches = useCallback(() => {
    void loadMatches(dateRange, statusFilter, page, branchId, country);
  }, [loadMatches, dateRange, statusFilter, page, branchId, country]);

  function handleApplicationChange(
    jobId: string,
    status: ApplicationStatus | null,
    statusUpdatedAt: string | null,
  ) {
    setJobs((prev) => {
      const updated = applyGroupAction(prev, {
        type: "set_job_status",
        jobId,
        status,
      }).map((job) =>
        job.id === jobId
          ? { ...job, statusUpdatedAt }
          : job,
      );
      return jobsVisibleForFilter(updated, statusFilter);
    });
    void loadMatches(dateRange, statusFilter, page, branchId, country);
  }

  async function handleCompanyNotInterested(jobIds: string[]) {
    const idSet = new Set(jobIds);

    setJobs((prev) => {
      const inGroup = prev.filter((j) => idSet.has(j.id));
      const rest = prev.filter((j) => !idSet.has(j.id));
      const updated = applyGroupAction(inGroup, {
        type: "company_not_interested",
      });
      return jobsVisibleForFilter([...rest, ...updated], statusFilter);
    });

    try {
      const res = await fetch("/api/applications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobIds,
          status: "not_interested",
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to update");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to mark company",
      );
    }

    await loadMatches(dateRange, statusFilter, page, branchId, country);
  }

  async function runIngest() {
    setIngesting(true);
    setIngestResult(null);
    setIngestErrors([]);
    setError(null);

    try {
      const res = await fetch("/api/ingest", { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        fetched?: number;
        upserted?: number;
        unchanged?: number;
        skipped?: number;
        deactivated?: number;
        boardsHarvested?: number;
        errors?: string[];
      };

      if (!res.ok) throw new Error(data.error ?? "Ingestion failed");

      const allErrors = data.errors ?? [];
      setIngestErrors(allErrors);

      const enrichmentErrors = allErrors.filter(
        (e) =>
          e.includes("OpenRouter") ||
          e.includes("OPENROUTER") ||
          e.includes("EnrichmentError"),
      );

      if (enrichmentErrors.length > 0) {
        setError(
          `Enrichment failed for ${enrichmentErrors.length} job(s). See details below.`,
        );
      } else if (allErrors.length > 0) {
        setError(`${allErrors.length} job(s) failed to save. See details below.`);
      }

      const harvested = data.boardsHarvested ?? 0;
      setIngestResult(
        `Fetched ${data.fetched ?? 0}, saved ${data.upserted ?? 0}, unchanged ${data.unchanged ?? 0}, skipped ${data.skipped ?? 0}, deactivated ${data.deactivated ?? 0}${
          harvested ? `, harvested ${harvested} boards` : ""
        }${allErrors.length ? ` (${allErrors.length} errors)` : ""}`,
      );

      await loadMatches(dateRange, statusFilter, 1, branchId, country);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingestion failed");
    } finally {
      setIngesting(false);
    }
  }

  const pageStart = totalForFilter === 0 ? 0 : (page - 1) * 10 + 1;
  const pageEnd = Math.min(page * 10, totalForFilter);
  const companyGroups = useMemo(() => groupJobsByCompany(jobs), [jobs]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-400">
              Job Radar
            </p>
            <h1 className="mt-1 text-2xl font-semibold">Your matched jobs</h1>
          </div>
          <div className="flex gap-2">
            <a
              href="/settings"
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500"
            >
              Preferences
            </a>
            <button
              type="button"
              onClick={() => void runIngest()}
              disabled={ingesting}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {ingesting ? "Fetching jobs…" : "Refresh jobs"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        {!dbError && <AutoApplyPanel refreshKey={queueVersion} onQueueChanged={reloadMatches} />}

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
            Rule branch
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleBranchFilterChange(null)}
              disabled={loadingMatches}
              className={`min-h-11 rounded-lg px-3 py-2 text-sm font-medium transition ${
                branchId === null
                  ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                  : "border border-zinc-700 text-zinc-300 hover:border-zinc-500"
              }`}
            >
              All
            </button>
            {DEFAULT_RULES.map((rule) => (
              <button
                key={rule.id}
                type="button"
                onClick={() => void handleBranchFilterChange(rule.id)}
                disabled={loadingMatches}
                className={`min-h-11 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  branchId === rule.id
                    ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                    : "border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                }`}
              >
                {RULE_LABELS[rule.id]}
              </button>
            ))}
          </div>
          <p className="mt-4 text-sm text-zinc-400">
            {matched} matching jobs · {statusCounts.open} to apply · you have{" "}
            {initialYearsOfExperience} yrs experience
            {hasResume ? " · resume loaded" : " · upload resume for fit %"}
            {loadingMatches ? " · updating…" : ""}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Last ingest: {formatLastIngest(lastIngestAt)}
            {" · "}
            sources: Arbeitnow, RemoteOK, Greenhouse, Lever, Ashby, Workable,
            Naukri
          </p>
          {funnel && <FunnelBar funnel={funnel} />}
          {ingestResult && (
            <p className="mt-2 text-sm text-emerald-400">{ingestResult}</p>
          )}
          {ingestErrors.length > 0 && (
            <details className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <summary className="cursor-pointer text-sm font-medium text-amber-300">
                {ingestErrors.length} ingest error{ingestErrors.length === 1 ? "" : "s"} — click to expand
              </summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-amber-200/90">
                {ingestErrors.map((entry) => (
                  <li key={entry} className="font-mono break-all">
                    {entry}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap gap-2">
              {DATE_RANGES.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => void handleDateRangeChange(id)}
                  disabled={loadingMatches}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                    dateRange === id
                      ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                      : "border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              {STATUS_FILTERS.map(({ id, label }) => {
                const count = statusCounts[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => void handleStatusFilterChange(id)}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                      statusFilter === id
                        ? "bg-zinc-100 text-zinc-950"
                        : "border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                  >
                    {label}
                    {count > 0 ? ` (${count})` : ""}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2" aria-label="Country">
              {COUNTRY_FILTERS.map(({ id, label }) => {
                const count = countryCounts[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => void handleCountryChange(id)}
                    disabled={loadingMatches}
                    aria-pressed={country === id}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                      country === id
                        ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                        : "border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                  >
                    {label}
                    {count > 0 ? ` (${count})` : ""}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-2 md:items-end">
            <QueueFilteredButton
              count={queueableCount}
              allQueued={statusFilter === "open" && totalForFilter > 0}
              queuing={queuing}
              onQueue={() => void queueFiltered()}
            />
            {queueResult && (
              <p className="text-xs text-zinc-400 md:max-w-56 md:text-right" aria-live="polite">
                {queueResult}
              </p>
            )}
          </div>
        </div>

        <ResumeUpload onUploaded={() => router.refresh()} />

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            {error}
            {error.toLowerCase().includes("database") && (
              <p className="mt-2 text-zinc-400">
                Set DATABASE_URL in .env and run{" "}
                <code className="text-zinc-200">npm run db:push</code>
              </p>
            )}
            {(error.includes("OpenRouter") || error.includes("OPENROUTER")) && (
              <p className="mt-2 text-zinc-400">
                Check OPENROUTER_API_KEY in .env and model availability.
              </p>
            )}
          </div>
        )}

        {jobs.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-10 text-center">
            <p className="text-lg text-zinc-300">
              {emptyMessageForFilter(statusFilter)}
            </p>
            {country !== "all" && (
              <p className="mt-2 text-sm text-zinc-500">
                Nothing in{" "}
                {COUNTRY_FILTERS.find((c) => c.id === country)?.label} for these
                filters. Try another country or widen the date range.
              </p>
            )}
            {statusFilter === "open" && (
              <p className="mt-2 text-sm text-zinc-500">
                Hit &quot;Refresh jobs&quot; to pull from Arbeitnow, RemoteOK,
                Greenhouse, Lever, Ashby, and Workable — or wait for the daily
                8am ingest, which also browses Naukri.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {companyGroups.map((group) => (
                <CompanyJobGroupCard
                  key={group.key}
                  group={group}
                  onApplicationChange={handleApplicationChange}
                  onCompanyNotInterested={handleCompanyNotInterested}
                  onQueued={handleJobQueued}
                />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                <p className="text-sm text-zinc-400">
                  Showing {pageStart}–{pageEnd} of {totalForFilter}{" "}
                  {totalForFilter === 1 ? "company" : "companies"}
                  {statusFilter !== "all"
                    ? ` (${statusFilter.replace("_", " ")})`
                    : ""}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={page <= 1 || loadingMatches}
                    onClick={() => void handlePageChange(page - 1)}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="flex items-center px-2 text-sm text-zinc-400">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= totalPages || loadingMatches}
                    onClick={() => void handlePageChange(page + 1)}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
