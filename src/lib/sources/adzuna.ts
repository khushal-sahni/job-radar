import type { RawJob } from "../types";
import { fetchJson, type SourceAdapter } from "./base";

interface AdzunaJob {
  id: string;
  title: string;
  company: { display_name: string };
  description: string;
  redirect_url: string;
  location: { display_name: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string;
  created: string;
  category?: { label: string };
}

interface AdzunaResponse {
  results: AdzunaJob[];
}

export const adzunaAdapter: SourceAdapter = {
  name: "adzuna",

  async fetchJobs(): Promise<RawJob[]> {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    if (!appId || !appKey) {
      console.warn("[adzuna] Skipping — ADZUNA_APP_ID / ADZUNA_APP_KEY not set");
      return [];
    }

    const queries = [
      "backend engineer",
      "full stack engineer",
      "software engineer backend",
    ];

    const jobs: RawJob[] = [];

    for (const what of queries) {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        what,
        where: "India",
        results_per_page: "50",
        sort_by: "date",
      });

      const url = `https://api.adzuna.com/v1/api/jobs/in/search/1?${params}`;
      const data = await fetchJson<AdzunaResponse>(url);

      for (const job of data.results ?? []) {
        jobs.push({
          externalId: String(job.id),
          source: "adzuna",
          title: job.title,
          company: job.company.display_name,
          description: job.description,
          url: job.redirect_url,
          location: job.location.display_name,
          country: "IN",
          isRemote: /remote|work from home|wfh/i.test(
            `${job.title} ${job.description} ${job.location.display_name}`,
          ),
          salaryMin: job.salary_min,
          salaryMax: job.salary_max,
          salaryCurrency: "INR",
          salaryEstimated: job.salary_is_predicted === "1",
          tags: job.category?.label ? [job.category.label] : [],
          postedAt: new Date(job.created),
        });
      }
    }

    return dedupeByUrl(jobs);
  },
};

function dedupeByUrl(jobs: RawJob[]): RawJob[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.url)) return false;
    seen.add(job.url);
    return true;
  });
}
