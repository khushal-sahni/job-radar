import type { RawJob } from "../types";

/** What an adapter tells ingest about its boards besides the jobs; ingest decides what to store. */
export interface SourceReport {
  /** The board is gone (404), so later runs can skip it. */
  deadBoard(slug: string, reason: string): void;
}

/** Fetches and normalizes one source. No database or file writes. */
export interface SourceAdapter {
  name: string;
  fetchJobs(report: SourceReport): Promise<RawJob[]>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Large boards (Jobgether on Lever) take minutes; a stalled socket must not hang ingest forever. */
const FETCH_TIMEOUT_MS = 5 * 60_000;

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "JobRadar/0.1 (+personal job matcher)",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${url}: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
