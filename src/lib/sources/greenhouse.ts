import type { RawJob } from "../types";
import { getAtsSlugs } from "./ats-boards";
import { fetchJson, sleep, stripHtml, type SourceAdapter } from "./base";
import { ROLE_TITLE_PATTERN } from "./role-filter";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string };
  first_published?: string;
  updated_at?: string;
  content?: string;
  departments?: Array<{ name: string }>;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

export const greenhouseAdapter: SourceAdapter = {
  name: "greenhouse",

  async fetchJobs(report): Promise<RawJob[]> {
    const jobs: RawJob[] = [];
    const companies = getAtsSlugs("greenhouse");
    let live = 0;
    let missing = 0;
    let errors = 0;

    for (const company of companies) {
      try {
        const url = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`;
        const data = await fetchJson<GreenhouseResponse>(url);
        live += 1;

        for (const job of data.jobs ?? []) {
          if (!ROLE_TITLE_PATTERN.test(job.title)) continue;

          const postedRaw = job.first_published ?? job.updated_at;
          const description = stripHtml(job.content ?? "");

          jobs.push({
            externalId: String(job.id),
            source: "greenhouse",
            title: job.title,
            company,
            description,
            url: job.absolute_url,
            location: job.location?.name,
            isRemote: /remote/i.test(job.location?.name ?? ""),
            tags: job.departments?.map((d) => d.name) ?? [],
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
          console.warn(`[greenhouse] error ${company}: ${message}`);
        }
      }

      await sleep(300);
    }

    console.log(
      `[greenhouse] ${live}/${companies.length} live · ${missing} demoted · ${errors} errors · ${jobs.length} roles`,
    );

    return jobs;
  },
};
