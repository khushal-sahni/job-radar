import { leaseBrowser } from "./browser/manager";
import { db } from "./db";
import {
  createEmptyIngestResult,
  deactivateStaleJobs,
  enrichAndUpsertJobs,
  getStaleDays,
  type IngestResult,
} from "./ingest";
import { getPreferences } from "./preferences";
import { scrapeNaukri } from "./sources/naukri";

export interface NaukriIngestResult extends IngestResult {
  blocked: string | null;
  refreshed: number;
}

/**
 * Paced Naukri browse in the Naukri Chrome → existing enrich + upsert path. CLI-only
 * (Playwright); never imported by Next routes.
 */
export async function ingestNaukri(options?: {
  maxNewJobs?: number;
  maxMinutes?: number;
  log?: (message: string) => void;
}): Promise<NaukriIngestResult> {
  const result: NaukriIngestResult = {
    ...createEmptyIngestResult(),
    blocked: null,
    refreshed: 0,
  };

  const [prefs, stored] = await Promise.all([
    getPreferences(),
    db.job.findMany({ where: { source: "naukri" }, select: { externalId: true } }),
  ]);

  const lease = await leaseBrowser("naukri", { log: options?.log });
  let scrape: Awaited<ReturnType<typeof scrapeNaukri>>;
  try {
    scrape = await scrapeNaukri(await lease.newPage(), {
      knownIds: new Set(stored.map((j) => j.externalId)),
      maxYears: prefs.yearsOfExperience,
      maxNewJobs: options?.maxNewJobs,
      maxMinutes: options?.maxMinutes,
      log: options?.log,
    });
  } finally {
    await lease.release();
  }

  result.blocked = scrape.blocked;
  result.fetched = scrape.jobs.length;
  result.bySource.naukri = scrape.jobs.length;

  if (scrape.seenKnownIds.length > 0) {
    const refreshed = await db.job.updateMany({
      where: { source: "naukri", externalId: { in: scrape.seenKnownIds } },
      data: { fetchedAt: new Date(), isActive: true },
    });
    result.refreshed = refreshed.count;
  }

  await enrichAndUpsertJobs(scrape.jobs, result);

  // A blocked run saw only part of Naukri — don't age out what it missed.
  if (!scrape.blocked && scrape.searches > 0) {
    await deactivateStaleJobs(["naukri"], getStaleDays(), result);
  }

  return result;
}
