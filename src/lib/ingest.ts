import { db } from "./db";
import { enrichJob, isRelevantRole } from "./enrich";
import { EnrichmentError } from "./openrouter";
import {
  compileExcludeKeywords,
  getPreferences,
  matchExcludeKeyword,
} from "./preferences";
import { ALL_ADAPTERS } from "./sources";
import { demoteAtsBoard, harvestAtsBoardsFromUrls, isAtsVendor } from "./sources/ats-boards";
import type { RawJob } from "./types";

export interface IngestResult {
  fetched: number;
  upserted: number;
  enriched: number;
  skipped: number;
  /** New postings hidden by an exclude keyword — never sent to the LLM. */
  keywordSkipped: number;
  /** Stored postings with identical text — refreshed without an LLM call. */
  unchanged: number;
  deactivated: number;
  boardsHarvested: number;
  bySource: Record<string, number>;
  errors: string[];
}

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_STALE_DAYS = 14;
const DEFAULT_ENRICH_CONCURRENCY = 3;

function getMaxAgeDays(): number {
  const raw = Number(process.env.INGEST_MAX_AGE_DAYS ?? DEFAULT_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_DAYS;
}

export function getStaleDays(): number {
  const raw = Number(process.env.INGEST_STALE_DAYS ?? DEFAULT_STALE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_DAYS;
}

function getEnrichConcurrency(): number {
  const raw = Number(
    process.env.INGEST_ENRICH_CONCURRENCY ?? DEFAULT_ENRICH_CONCURRENCY,
  );
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 8) : DEFAULT_ENRICH_CONCURRENCY;
}

function isTooOld(postedAt: Date | undefined, maxAgeDays: number): boolean {
  if (!postedAt) return false;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return postedAt.getTime() < cutoff;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workers = Math.min(concurrency, items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function upsertEnrichedJob(
  raw: RawJob,
  enriched: Awaited<ReturnType<typeof enrichJob>>,
): Promise<void> {
  await db.job.upsert({
    where: {
      source_externalId: {
        source: raw.source,
        externalId: raw.externalId,
      },
    },
    create: {
      externalId: raw.externalId,
      source: raw.source,
      title: raw.title,
      company: raw.company,
      description: raw.description,
      url: raw.url,
      location: raw.location,
      country: enriched.country,
      isRemote: enriched.isRemote,
      remoteScope: enriched.remoteScope,
      visaSponsorship: enriched.visaSponsorship,
      salaryMin: enriched.salaryMin,
      salaryMax: enriched.salaryMax,
      salaryCurrency: enriched.salaryCurrency,
      salaryINRMin: enriched.salaryINRMin,
      salaryINRMax: enriched.salaryINRMax,
      isBaseSalary: enriched.isBaseSalary,
      salaryEstimated: enriched.salaryEstimated,
      salaryVerified: enriched.salaryVerified,
      visaVerified: enriched.visaVerified,
      enrichmentModel: enriched.enrichmentModel,
      tags: enriched.tags,
      requiredYearsMin: enriched.requiredYearsMin,
      requiredYearsMax: enriched.requiredYearsMax,
      postedAt: raw.postedAt,
      enrichedAt: new Date(),
      isActive: true,
    },
    update: {
      title: raw.title,
      company: raw.company,
      description: raw.description,
      url: raw.url,
      location: raw.location,
      country: enriched.country,
      isRemote: enriched.isRemote,
      remoteScope: enriched.remoteScope,
      visaSponsorship: enriched.visaSponsorship,
      salaryMin: enriched.salaryMin,
      salaryMax: enriched.salaryMax,
      salaryCurrency: enriched.salaryCurrency,
      salaryINRMin: enriched.salaryINRMin,
      salaryINRMax: enriched.salaryINRMax,
      isBaseSalary: enriched.isBaseSalary,
      salaryEstimated: enriched.salaryEstimated,
      salaryVerified: enriched.salaryVerified,
      visaVerified: enriched.visaVerified,
      enrichmentModel: enriched.enrichmentModel,
      tags: enriched.tags,
      requiredYearsMin: enriched.requiredYearsMin,
      requiredYearsMax: enriched.requiredYearsMax,
      postedAt: raw.postedAt,
      enrichedAt: new Date(),
      isActive: true,
      fetchedAt: new Date(),
    },
  });
}

export function createEmptyIngestResult(): IngestResult {
  return {
    fetched: 0,
    upserted: 0,
    enriched: 0,
    skipped: 0,
    keywordSkipped: 0,
    unchanged: 0,
    deactivated: 0,
    boardsHarvested: 0,
    bySource: {},
    errors: [],
  };
}

export async function ingestAllSources(): Promise<IngestResult> {
  const result = createEmptyIngestResult();

  const maxAgeDays = getMaxAgeDays();
  const staleDays = getStaleDays();
  const concurrency = getEnrichConcurrency();
  const allJobs: RawJob[] = [];
  const successfulSources: string[] = [];

  for (const adapter of ALL_ADAPTERS) {
    try {
      const dead: Array<{ slug: string; reason: string }> = [];
      const jobs = await adapter.fetchJobs({ deadBoard: (slug, reason) => dead.push({ slug, reason }) });
      if (isAtsVendor(adapter.name)) for (const d of dead) demoteAtsBoard(adapter.name, d.slug, d.reason);
      result.bySource[adapter.name] = jobs.length;
      result.fetched += jobs.length;
      allJobs.push(...jobs);
      successfulSources.push(adapter.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${adapter.name}: ${message}`);
    }
  }

  // Discover new ATS boards from apply URLs (Arbeitnow/RemoteOK often link to Greenhouse/Lever/Ashby/Workable)
  try {
    result.boardsHarvested = harvestAtsBoardsFromUrls(
      allJobs.map((j) => j.url).filter(Boolean),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`ats-harvest: ${message}`);
  }

  await enrichAndUpsertJobs(allJobs, result, { maxAgeDays, concurrency });
  await deactivateStaleJobs(successfulSources, staleDays, result);

  return result;
}

interface StoredJob {
  title: string;
  company: string;
  location: string | null;
  description: string;
  postedAt: Date | null;
  tags: string[];
  enrichmentModel: string | null;
}

const STORED_LOOKUP_CHUNK = 1000;

function storedJobKey(source: string, externalId: string): string {
  return `${source}\u0000${externalId}`;
}

function groupIdsBySource(jobs: RawJob[]): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  for (const job of jobs) {
    const ids = bySource.get(job.source) ?? [];
    ids.push(job.externalId);
    bySource.set(job.source, ids);
  }
  return bySource;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadStoredJobs(jobs: RawJob[]): Promise<Map<string, StoredJob>> {
  const stored = new Map<string, StoredJob>();
  for (const [source, ids] of groupIdsBySource(jobs)) {
    for (const batch of chunk(ids, STORED_LOOKUP_CHUNK)) {
      const rows = await db.job.findMany({
        where: { source, externalId: { in: batch } },
        select: {
          externalId: true,
          title: true,
          company: true,
          location: true,
          description: true,
          postedAt: true,
          tags: true,
          enrichmentModel: true,
        },
      });
      for (const { externalId, ...row } of rows) {
        stored.set(storedJobKey(source, externalId), row);
      }
    }
  }
  return stored;
}

function isUnchanged(raw: RawJob, existing: StoredJob): boolean {
  return (
    existing.enrichmentModel != null &&
    existing.title === raw.title &&
    existing.company === raw.company &&
    (existing.location ?? null) === (raw.location ?? null) &&
    existing.description === raw.description &&
    (existing.postedAt?.getTime() ?? null) === (raw.postedAt?.getTime() ?? null)
  );
}

/** Mark still-listed rows as seen so stale cleanup keeps them. */
async function touchStoredJobs(jobs: RawJob[]): Promise<void> {
  const now = new Date();
  for (const [source, ids] of groupIdsBySource(jobs)) {
    for (const batch of chunk(ids, STORED_LOOKUP_CHUNK)) {
      await db.job.updateMany({
        where: { source, externalId: { in: batch } },
        data: { fetchedAt: now, isActive: true },
      });
    }
  }
}

/**
 * Relevance + recency filter, then enrich and upsert. New postings hit by an
 * exclude keyword and stored postings with unchanged text skip the LLM.
 * Mutates `result` counters.
 */
export async function enrichAndUpsertJobs(
  allJobs: RawJob[],
  result: IngestResult,
  options: { maxAgeDays?: number; concurrency?: number } = {},
): Promise<void> {
  const maxAgeDays = options.maxAgeDays ?? getMaxAgeDays();
  const concurrency = options.concurrency ?? getEnrichConcurrency();
  const toEnrich: RawJob[] = [];

  for (const raw of allJobs) {
    if (!isRelevantRole(raw.title, raw.description)) {
      result.skipped += 1;
      continue;
    }

    if (isTooOld(raw.postedAt, maxAgeDays)) {
      result.skipped += 1;
      // Still on the board — bump fetchedAt so stale cleanup doesn't drop it.
      try {
        await db.job.updateMany({
          where: {
            source: raw.source,
            externalId: raw.externalId,
          },
          data: { fetchedAt: new Date() },
        });
      } catch {
        // Ignore — job may not exist yet; we intentionally skip inserting old ones.
      }
      continue;
    }

    toEnrich.push(raw);
  }

  const [prefs, stored] = await Promise.all([
    getPreferences(),
    loadStoredJobs(toEnrich),
  ]);
  const excludeMatchers = compileExcludeKeywords(prefs.excludeTitleKeywords ?? []);
  const toTouch: RawJob[] = [];
  const toCall: RawJob[] = [];

  for (const raw of toEnrich) {
    const existing = stored.get(storedJobKey(raw.source, raw.externalId));
    const tags = [...(raw.tags ?? []), ...(existing?.tags ?? [])];
    if (matchExcludeKeyword({ ...raw, tags }, excludeMatchers)) {
      if (existing) {
        toTouch.push(raw);
      } else {
        result.keywordSkipped += 1;
      }
      continue;
    }
    if (existing && isUnchanged(raw, existing)) {
      toTouch.push(raw);
      result.unchanged += 1;
      continue;
    }
    toCall.push(raw);
  }

  try {
    await touchStoredJobs(toTouch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`touch unchanged: ${message}`);
  }

  await mapPool(toCall, concurrency, async (raw) => {
    try {
      const enriched = await enrichJob(raw);
      await upsertEnrichedJob(raw, enriched);
      result.upserted += 1;
      result.enriched += 1;
    } catch (err) {
      const message =
        err instanceof EnrichmentError
          ? `EnrichmentError: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      result.errors.push(`upsert ${raw.source}/${raw.externalId}: ${message}`);
    }
  });
}

/** Mark jobs inactive when their source ran but did not list them for `staleDays`. */
export async function deactivateStaleJobs(
  sources: string[],
  staleDays: number,
  result: IngestResult,
): Promise<void> {
  const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  for (const source of sources) {
    try {
      const deactivated = await db.job.updateMany({
        where: {
          source,
          isActive: true,
          fetchedAt: { lt: staleCutoff },
        },
        data: { isActive: false },
      });
      result.deactivated += deactivated.count;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`deactivate ${source}: ${message}`);
    }
  }
}

export async function getLastIngestAt(): Promise<Date | null> {
  const latest = await db.job.findFirst({
    orderBy: { fetchedAt: "desc" },
    select: { fetchedAt: true },
  });
  return latest?.fetchedAt ?? null;
}

/**
 * Jobs pushed from outside (the browser extension's page reader), as JSON. Rows without an id,
 * title, or company are skipped; dates arrive as strings.
 */
export async function ingestPushedJobs(rows: RawJob[]): Promise<IngestResult> {
  const result = createEmptyIngestResult();
  result.fetched = rows.length;
  const jobs: RawJob[] = [];
  for (const raw of rows) {
    if (!raw.externalId || !raw.title || !raw.company) {
      result.skipped += 1;
      continue;
    }
    jobs.push({ ...raw, description: raw.description ?? "", postedAt: raw.postedAt ? new Date(raw.postedAt) : undefined });
  }
  await enrichAndUpsertJobs(jobs, result, { concurrency: 1 });
  return result;
}
