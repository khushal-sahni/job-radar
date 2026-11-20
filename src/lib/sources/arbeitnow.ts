import type { RawJob } from "../types";
import { fetchJson, stripHtml, type SourceAdapter } from "./base";
import { countryFromText } from "../location";

interface ArbeitnowJob {
  slug: string;
  title: string;
  company_name: string;
  description: string;
  remote: boolean;
  url: string;
  location: string;
  tags: string[];
  visa_sponsorship: boolean;
  created_at?: string;
}

interface ArbeitnowResponse {
  data: ArbeitnowJob[];
  meta?: { last_page?: number };
}

export const arbeitnowAdapter: SourceAdapter = {
  name: "arbeitnow",

  async fetchJobs(): Promise<RawJob[]> {
    const jobs: RawJob[] = [];
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage && page <= 5) {
      const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`;
      const data = await fetchJson<ArbeitnowResponse>(url);
      lastPage = data.meta?.last_page ?? 1;

      for (const job of data.data ?? []) {
        jobs.push({
          externalId: job.slug,
          source: "arbeitnow",
          title: job.title,
          company: job.company_name,
          description: stripHtml(job.description),
          url: job.url,
          location: job.location,
          country: countryFromText(job.location),
          isRemote: job.remote,
          visaSponsorship: job.visa_sponsorship,
          tags: job.tags ?? [],
          postedAt: job.created_at ? new Date(job.created_at) : undefined,
        });
      }

      page += 1;
    }

    return jobs;
  },
};
