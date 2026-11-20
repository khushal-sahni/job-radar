import type { RawJob } from "../types";
import { getAtsSlugs } from "./ats-boards";
import { fetchJson, sleep, stripHtml, type SourceAdapter } from "./base";
import { ROLE_TITLE_PATTERN } from "./role-filter";

interface WorkableLocation {
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
  hidden?: boolean;
}

interface WorkableJob {
  title: string;
  shortcode: string;
  employment_type?: string;
  telecommuting?: boolean;
  department?: string;
  url?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string;
  city?: string;
  state?: string;
  function?: string;
  locations?: WorkableLocation[];
  description?: string;
}

interface WorkableResponse {
  name?: string;
  jobs?: WorkableJob[];
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

function formatLocation(job: WorkableJob): string {
  const locations = (job.locations ?? []).filter((l) => !l.hidden);
  const parts =
    locations.length > 0
      ? locations.map((l) => [l.city, l.region, l.country].filter(Boolean).join(", "))
      : [[job.city, job.state, job.country].filter(Boolean).join(", ")];
  const joined = parts.filter(Boolean).join("; ");
  return job.telecommuting ? `Remote${joined ? ` - ${joined}` : ""}` : joined;
}

function countryCode(job: WorkableJob): string | undefined {
  const codes = new Set(
    (job.locations ?? []).map((l) => l.countryCode?.toUpperCase()).filter(Boolean),
  );
  return codes.size === 1 ? [...codes][0] : undefined;
}

export const workableAdapter: SourceAdapter = {
  name: "workable",

  async fetchJobs(report): Promise<RawJob[]> {
    const jobs: RawJob[] = [];
    const companies = getAtsSlugs("workable");
    let live = 0;
    let missing = 0;
    let errors = 0;

    for (const company of companies) {
      try {
        const url = `https://apply.workable.com/api/v1/widget/accounts/${company}?details=true`;
        const data = await fetchJson<WorkableResponse>(url);
        live += 1;
        const companyName = data.name?.trim() || company;

        for (const job of data.jobs ?? []) {
          if (!job.shortcode || !job.title) continue;
          if (!ROLE_TITLE_PATTERN.test(job.title)) continue;

          const location = formatLocation(job);
          const postedRaw = job.published_on ?? job.created_at;

          jobs.push({
            externalId: `${company}:${job.shortcode}`,
            source: "workable",
            title: job.title,
            company: companyName,
            description: stripHtml(job.description ?? ""),
            url: job.url ?? `https://apply.workable.com/j/${job.shortcode}`,
            location: location || undefined,
            country: countryCode(job),
            isRemote: job.telecommuting === true,
            tags: [job.department, job.function, job.employment_type].filter(
              (t): t is string => Boolean(t),
            ),
            postedAt: postedRaw ? new Date(postedRaw) : undefined,
          });
        }
      } catch (err) {
        if (isNotFound(err)) {
          missing += 1;
          report.deadBoard(company, "404");
        } else {
          errors += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[workable] error ${company}: ${message}`);
        }
      }

      await sleep(300);
    }

    console.log(
      `[workable] ${live}/${companies.length} live · ${missing} demoted · ${errors} errors · ${jobs.length} roles`,
    );

    return jobs;
  },
};
