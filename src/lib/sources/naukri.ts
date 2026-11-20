import type { Page, Response } from "playwright";
import type { RawJob } from "../types";
import { sleep, stripHtml } from "./base";
import { ROLE_TITLE_PATTERN } from "./role-filter";

/**
 * Naukri has no public API, so this browses naukri.com the way a person would:
 * one tab in the Naukri Chrome, scroll the results, open a job, read, go back.
 * Structured data comes from the JSON the page itself loads (search + job detail).
 * Never used for LinkedIn. Stops on any challenge or login wall instead of
 * trying to get past it.
 */

const BASE_URL = "https://www.naukri.com";

export const NAUKRI_SEARCHES = [
  "software-engineer",
  "backend-developer",
  "full-stack-developer",
  "sde",
  "ai-engineer",
];

interface NaukriPlaceholder {
  type?: string;
  label?: string;
}

interface NaukriSalaryDetail {
  minimumSalary?: number;
  maximumSalary?: number;
  currency?: string;
  hideSalary?: boolean;
}

export interface NaukriSearchRow {
  jobId: string;
  title: string;
  companyName?: string;
  jdURL?: string;
  jobDescription?: string;
  tagsAndSkills?: string;
  placeholders?: NaukriPlaceholder[];
  salaryDetail?: NaukriSalaryDetail;
  minimumExperience?: string;
  maximumExperience?: string;
  createdDate?: number;
}

interface NaukriSearchResponse {
  noOfJobs?: number;
  jobDetails?: NaukriSearchRow[];
}

export interface NaukriJobDetail {
  jobId?: string;
  title?: string;
  description?: string;
  staticUrl?: string;
  wfhLabel?: string;
  companyDetail?: { name?: string };
  locations?: Array<{ label?: string }>;
  keySkills?: {
    preferred?: Array<{ label?: string }>;
    other?: Array<{ label?: string }>;
  };
  salaryDetail?: NaukriSalaryDetail;
  minimumExperience?: string;
  maximumExperience?: string;
  employmentType?: string;
  /** AmbitionBox “typically earns” widget, copied from the detail response. */
  ambitionBoxSalary?: NaukriSalaryInsight;
}

/** AmbitionBox CTC range for this role at this company, in lakhs per year. */
export interface NaukriSalaryInsight {
  MinCtc?: string;
  MaxCtc?: string;
  AverageCtc?: string;
}

export interface NaukriDetailResponse {
  jobDetails?: NaukriJobDetail;
  ambitionBoxDetails?: { salaries?: NaukriSalaryInsight };
}

export interface NaukriScrapeOptions {
  knownIds: Set<string>;
  maxYears: number;
  maxNewJobs?: number;
  maxMinutes?: number;
  maxPagesPerSearch?: number;
  log?: (message: string) => void;
}

export interface NaukriScrapeResult {
  jobs: RawJob[];
  /** Stored job ids that were still listed — used to keep them active. */
  seenKnownIds: string[];
  blocked: string | null;
  searches: number;
}

function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function pause(min: number, max: number): Promise<void> {
  return sleep(randomBetween(min, max));
}

/** Naukri CTC buckets (LPA) from the user's saved search; `501` is kept as Naukri sends it. */
export const NAUKRI_CTC_FILTERS = ["501", "25to50", "50to75", "75to100", "100to500"];

export function searchUrl(slug: string, page: number, maxYears: number): string {
  const suffix = page > 1 ? `-${page}` : "";
  const params = new URLSearchParams();
  for (const ctc of NAUKRI_CTC_FILTERS) params.append("ctcFilter", ctc);
  params.set("experience", String(maxYears));
  params.set("jobAge", "1");
  return `${BASE_URL}/${slug}-jobs-in-india${suffix}?${params.toString()}`;
}

function placeholder(row: NaukriSearchRow, type: string): string | undefined {
  return row.placeholders?.find((p) => p.type === type)?.label?.trim() || undefined;
}

function parseYears(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function salaryFields(
  detail: NaukriSalaryDetail | undefined,
): Pick<RawJob, "salaryMin" | "salaryMax" | "salaryCurrency"> {
  if (!detail || detail.hideSalary) return {};
  const min = detail.minimumSalary ?? 0;
  const max = detail.maximumSalary ?? 0;
  if (min <= 0 && max <= 0) return {};
  return {
    salaryMin: min > 0 ? min : undefined,
    salaryMax: max > 0 ? max : undefined,
    salaryCurrency: (detail.currency ?? "INR").toUpperCase(),
  };
}

const LAKH = 100_000;

function lakhs(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * LAKH) : undefined;
}

/** AmbitionBox market range as an estimated INR salary; empty when the widget has no range. */
export function salaryFromInsight(
  insight: NaukriSalaryInsight | undefined,
): Pick<RawJob, "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryEstimated"> {
  const min = lakhs(insight?.MinCtc);
  const max = lakhs(insight?.MaxCtc);
  if (min == null && max == null) return {};
  return { salaryMin: min, salaryMax: max, salaryCurrency: "INR", salaryEstimated: true };
}

/** Job detail with the AmbitionBox widget attached, from a `/jobapi/v4/job/{id}` response. */
export function detailFromResponse(data: NaukriDetailResponse | null): NaukriJobDetail | null {
  if (!data?.jobDetails) return null;
  return { ...data.jobDetails, ambitionBoxSalary: data.ambitionBoxDetails?.salaries };
}

/** Posted salary wins; otherwise fall back to the AmbitionBox estimate. */
export function naukriSalary(
  row: NaukriSearchRow | null,
  detail: NaukriJobDetail | null,
): Pick<RawJob, "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryEstimated"> {
  const posted = salaryFields(detail?.salaryDetail ?? row?.salaryDetail);
  if (posted.salaryMin != null || posted.salaryMax != null) return posted;
  return salaryFromInsight(detail?.ambitionBoxSalary);
}

/** Normalize a Naukri search row (+ job detail when we opened it) into a RawJob. */
export function naukriToRawJob(
  row: NaukriSearchRow,
  detail: NaukriJobDetail | null,
): RawJob {
  const minYears = detail?.minimumExperience ?? row.minimumExperience;
  const maxYears = detail?.maximumExperience ?? row.maximumExperience;
  const experienceLine =
    minYears != null && maxYears != null && minYears !== "" && maxYears !== ""
      ? `Experience: ${minYears}-${maxYears} years`
      : "";

  const skills = detail
    ? [...(detail.keySkills?.preferred ?? []), ...(detail.keySkills?.other ?? [])]
        .map((s) => s.label?.trim())
        .filter((s): s is string => Boolean(s))
    : (row.tagsAndSkills ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const body = stripHtml(detail?.description ?? row.jobDescription ?? "");
  const description = [
    experienceLine,
    body,
    skills.length > 0 ? `Key skills: ${skills.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const cityLabels = (detail?.locations ?? [])
    .map((l) => l.label?.trim())
    .filter((l): l is string => Boolean(l));
  const cardLocation = placeholder(row, "location");
  const workMode = detail?.wfhLabel?.trim() ?? "";
  const locationText =
    cityLabels.length > 0
      ? `${workMode && !/office/i.test(workMode) ? `${workMode} - ` : ""}${cityLabels.join(", ")}`
      : (cardLocation ?? "");
  const location = locationText ? `${locationText}, India` : "India";

  const isRemote =
    /\b(remote|work from home|wfh)\b/i.test(workMode) ||
    /\b(remote|work from home|wfh)\b/i.test(cardLocation ?? "");

  const url =
    detail?.staticUrl ??
    (row.jdURL ? `${BASE_URL}${row.jdURL}` : `${BASE_URL}/job-listings-${row.jobId}`);

  return {
    externalId: row.jobId,
    source: "naukri",
    title: (detail?.title ?? row.title).trim(),
    company: (detail?.companyDetail?.name ?? row.companyName ?? "Unknown").trim(),
    description,
    url,
    location,
    country: "IN",
    isRemote,
    workModeFromSource: Boolean(workMode) || Boolean(cardLocation),
    ...naukriSalary(row, detail),
    tags: skills.slice(0, 12),
    postedAt:
      typeof row.createdDate === "number" ? new Date(row.createdDate) : undefined,
  };
}

/** Title matches our roles and the posting's minimum experience fits the YOE cap. */
export function isWantedNaukriRow(row: NaukriSearchRow, maxYears: number): boolean {
  if (!row.jobId || !row.title) return false;
  if (!ROLE_TITLE_PATTERN.test(row.title)) return false;
  const min = parseYears(row.minimumExperience);
  return min == null || min <= maxYears;
}

async function detectBlock(page: Page): Promise<string | null> {
  const url = page.url();
  if (/\/nlogin|\/login/i.test(url)) return `login wall at ${url}`;
  const title = (await page.title().catch(() => "")).toLowerCase();
  if (/access denied|captcha|are you a robot|verify you are human|attention required/.test(title)) {
    return `challenge page: "${title}"`;
  }
  const hasCaptcha = await page
    .locator("iframe[src*='captcha'], iframe[src*='challenge'], #px-captcha")
    .count()
    .catch(() => 0);
  return hasCaptcha > 0 ? "captcha iframe on page" : null;
}

async function humanScroll(page: Page, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, randomBetween(350, 750));
    await pause(1_000, 3_000);
    if (Math.random() < 0.15) {
      await page.mouse.wheel(0, -randomBetween(120, 300));
      await pause(600, 1_500);
    }
  }
}

function isSearchResponse(res: Response): boolean {
  return res.url().includes("/jobapi/v3/search?") && res.request().method() === "GET";
}

async function loadSearchPage(
  page: Page,
  url: string,
): Promise<NaukriSearchResponse | null> {
  const responsePromise = page
    .waitForResponse(isSearchResponse, { timeout: 30_000 })
    .catch(() => null);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const res = await responsePromise;
  if (!res || !res.ok()) return null;
  return (await res.json().catch(() => null)) as NaukriSearchResponse | null;
}

async function openJobAndRead(
  page: Page,
  row: NaukriSearchRow,
): Promise<NaukriJobDetail | null> {
  const card = page.locator(`[data-job-id="${row.jobId}"]`).first();
  if (await card.count().catch(() => 0)) {
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    await pause(600, 1_600);
    await card.locator("a.title").first().hover().catch(() => undefined);
    await pause(400, 1_200);
  }

  const detailUrl = row.jdURL ? `${BASE_URL}${row.jdURL}` : null;
  if (!detailUrl) return null;

  const responsePromise = page
    .waitForResponse(
      (res) => res.url().includes(`/jobapi/v4/job/${row.jobId}`),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await page.goto(detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
    referer: page.url(),
  });
  const res = await responsePromise;

  await pause(2_500, 5_000);
  await humanScroll(page, randomBetween(1, 3));

  if (!res || !res.ok()) return null;
  const data = (await res.json().catch(() => null)) as NaukriDetailResponse | null;
  return detailFromResponse(data);
}

/**
 * Browses Naukri in the given tab. The caller owns the tab (a lease on the Naukri Chrome from
 * `@/lib/browser/manager`); this only reads pages and never starts or closes Chrome.
 */
export async function scrapeNaukri(
  page: Page,
  options: NaukriScrapeOptions,
): Promise<NaukriScrapeResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const maxNew = options.maxNewJobs ?? 40;
  const deadline = Date.now() + (options.maxMinutes ?? 15) * 60_000;
  const maxPages = options.maxPagesPerSearch ?? 2;

  const result: NaukriScrapeResult = {
    jobs: [],
    seenKnownIds: [],
    blocked: null,
    searches: 0,
  };
  const seenThisRun = new Set<string>();
  const outOfBudget = (): boolean =>
    result.jobs.length >= maxNew || Date.now() > deadline;

  for (const slug of NAUKRI_SEARCHES) {
    if (outOfBudget() || result.blocked) break;
    result.searches += 1;

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      if (outOfBudget() || result.blocked) break;

      const listUrl = searchUrl(slug, pageNo, options.maxYears);
      const search = await loadSearchPage(page, listUrl);
      const block = await detectBlock(page);
      if (block) {
        result.blocked = block;
        break;
      }
      if (!search) {
        log(`[naukri] ${slug} p${pageNo}: no search data — moving on`);
        break;
      }

      const rows = search.jobDetails ?? [];
      log(`[naukri] ${slug} p${pageNo}: ${rows.length} listed`);
      await pause(1_500, 3_500);
      await humanScroll(page, randomBetween(2, 4));

      for (const row of rows) {
        if (outOfBudget() || result.blocked) break;
        if (!row.jobId || seenThisRun.has(row.jobId)) continue;
        seenThisRun.add(row.jobId);

        if (options.knownIds.has(row.jobId)) {
          result.seenKnownIds.push(row.jobId);
          continue;
        }
        if (!isWantedNaukriRow(row, options.maxYears)) continue;

        const detail = await openJobAndRead(page, row);
        const detailBlock = await detectBlock(page);
        if (detailBlock) {
          result.blocked = detailBlock;
          break;
        }
        result.jobs.push(naukriToRawJob(row, detail));

        await page.goBack({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(
          () => page.goto(listUrl, { waitUntil: "domcontentloaded" }),
        );
        await pause(1_500, 4_000);
      }

      if (rows.length < 20) break;
      await pause(3_000, 7_000);
    }

    await pause(5_000, 12_000);
  }

  log(
    `[naukri] ${result.searches} searches · ${result.jobs.length} new · ${result.seenKnownIds.length} already stored${result.blocked ? ` · stopped: ${result.blocked}` : ""}`,
  );
  return result;
}

/**
 * Re-open stored Naukri job pages one at a time (same pacing as the browse)
 * and return each job's detail, keyed by job id. Stops on a challenge page.
 */
export async function fetchNaukriJobDetails(
  page: Page,
  jobs: Array<{ jobId: string; url: string }>,
  options: { log?: (message: string) => void } = {},
): Promise<{
  details: Map<string, NaukriJobDetail | null>;
  expiredIds: string[];
  blocked: string | null;
}> {
  const log = options.log ?? ((m: string) => console.log(m));
  const details = new Map<string, NaukriJobDetail | null>();
  const expiredIds: string[] = [];
  let blocked: string | null = null;

  for (const { jobId, url } of jobs) {
    const responsePromise = page
      .waitForResponse((res) => res.url().includes(`/jobapi/v4/job/${jobId}`), {
        timeout: 30_000,
      })
      .catch(() => null);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    const res = await responsePromise;
    const data =
      res && res.ok()
        ? ((await res.json().catch(() => null)) as NaukriDetailResponse | null)
        : null;
    const detail = detailFromResponse(data);

    // Some job pages embed a reCAPTCHA frame for apply forms; only a missing detail means a real wall.
    if (!detail && /[?&]expJD=true/.test(page.url())) {
      expiredIds.push(jobId);
      await pause(2_000, 4_000);
      continue;
    }
    if (!detail) {
      blocked = await detectBlock(page);
      if (blocked) {
        log(`[naukri] ${jobId}: ${blocked} (${page.url()}, status ${res?.status() ?? "no response"})`);
        break;
      }
    }
    details.set(jobId, detail);

    await pause(2_000, 4_500);
    await humanScroll(page, randomBetween(1, 2));
    await pause(1_500, 3_500);
  }

  return { details, expiredIds, blocked };
}
