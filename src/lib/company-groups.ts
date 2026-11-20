import type { JobMatch } from "./types";

export interface CompanyJobGroup {
  /** Normalized key for expand state / React keys */
  key: string;
  /** Display name from the best-ranked job in the group */
  company: string;
  /** Sorted best-first (same order as global match ranking) */
  jobs: JobMatch[];
}

export function normalizeCompanyKey(company: string): string {
  const key = company.trim().toLowerCase().replace(/\s+/g, " ");
  return key || "unknown";
}

/**
 * Group jobs by company. Input must already be sorted best-first;
 * groups appear in order of their best job, and jobs within a group
 * keep that relative order.
 */
export function groupJobsByCompany(jobs: JobMatch[]): CompanyJobGroup[] {
  const order: string[] = [];
  const map = new Map<string, JobMatch[]>();
  const labels = new Map<string, string>();

  for (const job of jobs) {
    const key = normalizeCompanyKey(job.company);
    if (!map.has(key)) {
      map.set(key, []);
      labels.set(key, job.company.trim() || "Unknown");
      order.push(key);
    }
    map.get(key)!.push(job);
  }

  return order.map((key) => ({
    key,
    company: labels.get(key)!,
    jobs: map.get(key)!,
  }));
}
