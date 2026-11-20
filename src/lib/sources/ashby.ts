import type { RawJob } from "../types";
import { getAtsSlugs } from "./ats-boards";
import { fetchJson, sleep, stripHtml, type SourceAdapter } from "./base";
import { ROLE_TITLE_PATTERN } from "./role-filter";

interface AshbyCompensationComponent {
  compensationType?: string;
  interval?: string;
  currencyCode?: string;
  minValue?: number;
  maxValue?: number;
}

interface AshbyCompensationTier {
  components?: AshbyCompensationComponent[];
}

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  department?: string;
  team?: string;
  isRemote?: boolean;
  workplaceType?: string;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTiers?: AshbyCompensationTier[];
    scrapeableCompensationSalarySummary?: string;
  };
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

function extractSalary(job: AshbyJob): {
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
} {
  const tiers = job.compensation?.compensationTiers ?? [];
  for (const tier of tiers) {
    for (const component of tier.components ?? []) {
      const type = (component.compensationType ?? "").toLowerCase();
      if (type && !type.includes("salary") && !type.includes("base")) continue;
      if (component.minValue == null && component.maxValue == null) continue;

      let min = component.minValue;
      let max = component.maxValue;
      const interval = (component.interval ?? "").toLowerCase();
      if (interval.includes("month")) {
        if (min != null) min *= 12;
        if (max != null) max *= 12;
      } else if (interval.includes("hour")) {
        if (min != null) min *= 2080;
        if (max != null) max *= 2080;
      }

      return {
        salaryMin: min,
        salaryMax: max,
        salaryCurrency: component.currencyCode,
      };
    }
  }

  return {};
}

export const ashbyAdapter: SourceAdapter = {
  name: "ashby",

  async fetchJobs(report): Promise<RawJob[]> {
    const jobs: RawJob[] = [];
    const companies = getAtsSlugs("ashby");
    let live = 0;
    let missing = 0;
    let errors = 0;

    for (const company of companies) {
      try {
        const url = `https://api.ashbyhq.com/posting-api/job-board/${company}?includeCompensation=true`;
        const data = await fetchJson<AshbyResponse>(url);
        live += 1;

        for (const job of data.jobs ?? []) {
          if (!job.id || !job.title) continue;
          if (!ROLE_TITLE_PATTERN.test(job.title)) continue;

          const locationParts = [
            job.location,
            ...(job.secondaryLocations ?? []).map((l) => l.location),
          ].filter((l): l is string => Boolean(l));
          const location = locationParts.join("; ") || undefined;
          const salary = extractSalary(job);
          const compensationNote =
            job.compensation?.scrapeableCompensationSalarySummary ?? "";
          const body = stripHtml(
            job.descriptionPlain ?? job.descriptionHtml ?? "",
          );
          const description = compensationNote
            ? `${body}\n\nCompensation: ${compensationNote}`
            : body;

          jobs.push({
            externalId: job.id,
            source: "ashby",
            title: job.title,
            company,
            description,
            url:
              job.jobUrl ??
              job.applyUrl ??
              `https://jobs.ashbyhq.com/${company}/${job.id}`,
            location,
            isRemote:
              Boolean(job.isRemote) ||
              /remote/i.test(location ?? "") ||
              /remote/i.test(job.workplaceType ?? ""),
            salaryMin: salary.salaryMin,
            salaryMax: salary.salaryMax,
            salaryCurrency: salary.salaryCurrency,
            tags: [job.department, job.team].filter((t): t is string =>
              Boolean(t),
            ),
            postedAt: job.publishedAt ? new Date(job.publishedAt) : undefined,
          });
        }
      } catch (err) {
        if (isNotFound(err)) {
          missing += 1;
          report.deadBoard(company, "404");
        } else {
          errors += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[ashby] error ${company}: ${message}`);
        }
      }

      await sleep(300);
    }

    console.log(
      `[ashby] ${live}/${companies.length} live · ${missing} demoted · ${errors} errors · ${jobs.length} roles`,
    );

    return jobs;
  },
};
