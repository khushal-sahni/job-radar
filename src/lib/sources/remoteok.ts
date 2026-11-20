import type { RawJob } from "../types";
import { fetchJson, type SourceAdapter } from "./base";

interface RemoteOkJob {
  id: string;
  slug: string;
  position: string;
  company: string;
  description: string;
  url: string;
  location: string;
  tags?: string[];
  date: string;
  salary_min?: number;
  salary_max?: number;
}

export const remoteokAdapter: SourceAdapter = {
  name: "remoteok",

  async fetchJobs(): Promise<RawJob[]> {
    const data = await fetchJson<RemoteOkJob[]>("https://remoteok.com/api");

    return (data ?? [])
      .filter((job) => job.id && job.position)
      .map((job) => ({
        externalId: String(job.id),
        source: "remoteok",
        title: job.position,
        company: job.company,
        description: job.description ?? "",
        url: job.url.startsWith("http") ? job.url : `https://remoteok.com${job.url}`,
        location: job.location,
        isRemote: true,
        salaryMin: job.salary_min,
        salaryMax: job.salary_max,
        salaryCurrency: "USD",
        tags: job.tags ?? [],
        postedAt: job.date ? new Date(job.date) : undefined,
      }));
  },
};
