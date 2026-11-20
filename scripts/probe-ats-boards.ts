/**
 * Probe verified ATS directories for boards with India / Japan / Germany / remote
 * backend roles. List-only HTTP (no descriptions, no LLM). Results land in
 * `.cache/ats-boards.json` and are picked up by the next daily ingest.
 *
 * Usage:
 *   npm run ats:probe
 *   npm run ats:probe -- --limit=200
 *   npm run ats:probe -- --vendor=ashby --limit=100
 *   npm run ats:probe -- --geo=india
 *   npm run ats:probe -- --geo=india --limit=300
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProbeResults,
  getAtsBoards,
  type AtsBoard,
  type AtsVendor,
  isAtsVendor,
} from "../src/lib/sources/ats-boards";
import { ROLE_TITLE_PATTERN } from "../src/lib/sources/role-filter";
import { sleep } from "../src/lib/sources/base";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const CACHE_DIR = path.join(PROJECT_ROOT, ".cache");
const DIRECTORY_CACHE = path.join(
  CACHE_DIR,
  "lastroundai-ats-company-directory-2026-08.csv",
);
const DIRECTORY_URL =
  "https://datahub.io/lastroundai-hiring-data/lastroundai-hiring-data/_r/-/ats-directory/lastroundai-ats-company-directory-2026-08.csv";

const INDIA_PATTERN =
  /\b(india|indian|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurugram|gurgaon|chennai|kolkata|ahmedabad)\b/i;

const JP_DE_PATTERN =
  /\b(japan|tokyo|osaka|yokohama|germany|berlin|munich|münchen|hamburg|frankfurt)\b/i;

const REMOTE_PATTERN =
  /\b(remote|worldwide|work from anywhere|distributed)\b/i;

type ProbeGeo = "all" | "india" | "jpde" | "remote";

interface DirectoryRow {
  vendor: AtsVendor;
  companyName: string;
  slug: string;
}

function locationPatternForGeo(geo: ProbeGeo): RegExp {
  switch (geo) {
    case "india":
      return INDIA_PATTERN;
    case "jpde":
      return JP_DE_PATTERN;
    case "remote":
      return REMOTE_PATTERN;
    default:
      return new RegExp(
        `(?:${INDIA_PATTERN.source}|${JP_DE_PATTERN.source}|${REMOTE_PATTERN.source})`,
        "i",
      );
  }
}

function log(message: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

function parseArgs(argv: string[]): {
  limit: number | null;
  vendor: AtsVendor | null;
  forceDownload: boolean;
  geo: ProbeGeo;
} {
  let limit: number | null = null;
  let vendor: AtsVendor | null = null;
  let forceDownload = false;
  let geo: ProbeGeo = "all";

  for (const arg of argv) {
    if (arg === "--force-download") forceDownload = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (arg.startsWith("--vendor=")) {
      const v = arg.slice("--vendor=".length).toLowerCase();
      if (isAtsVendor(v)) vendor = v;
    } else if (arg.startsWith("--geo=")) {
      const g = arg.slice("--geo=".length).toLowerCase();
      if (g === "india" || g === "jpde" || g === "remote" || g === "all") {
        geo = g;
      }
    }
  }

  return { limit, vendor, forceDownload, geo };
}

async function ensureDirectory(forceDownload: boolean): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!forceDownload && fs.existsSync(DIRECTORY_CACHE)) {
    return DIRECTORY_CACHE;
  }

  log(`Downloading ATS directory → ${DIRECTORY_CACHE}`);
  const res = await fetch(DIRECTORY_URL, {
    headers: { Accept: "text/csv", "User-Agent": "JobRadar/0.1 (+ats-probe)" },
  });
  if (!res.ok) {
    throw new Error(`Directory download failed: ${res.status}`);
  }
  const text = await res.text();
  fs.writeFileSync(DIRECTORY_CACHE, text);
  log(`Saved ${text.split("\n").length - 1} directory rows`);
  return DIRECTORY_CACHE;
}

function parseCsv(content: string): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  const lines = content.split(/\r?\n/);
  // ats_vendor,company_name,board_slug,last_crawled
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    // Simple CSV split that respects quoted company names
    const match = line.match(
      /^([^,]+),(?:"([^"]*)"|([^,]*)),([^,]+),(.*)$/,
    );
    if (!match) continue;
    const vendorRaw = match[1]!.trim().toLowerCase();
    const companyName = (match[2] ?? match[3] ?? "").trim();
    const slug = match[4]!.trim().toLowerCase();
    if (!isAtsVendor(vendorRaw) || !slug) continue;
    rows.push({ vendor: vendorRaw, companyName, slug });
  }
  return rows;
}

function boardUrl(vendor: AtsVendor, slug: string): string {
  switch (vendor) {
    case "greenhouse":
      // List-only — no content=true (faster, smaller)
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    case "workable":
      return `https://apply.workable.com/api/v1/widget/accounts/${slug}`;
  }
}

function extractPostings(
  vendor: AtsVendor,
  data: unknown,
): Array<{ title: string; location: string }> {
  if (vendor === "greenhouse") {
    const jobs = (data as { jobs?: Array<{ title?: string; location?: { name?: string } }> })
      .jobs ?? [];
    return jobs.map((j) => ({
      title: j.title ?? "",
      location: j.location?.name ?? "",
    }));
  }
  if (vendor === "lever") {
    const jobs = (data as Array<{ text?: string; categories?: { location?: string } }>) ?? [];
    return jobs.map((j) => ({
      title: j.text ?? "",
      location: j.categories?.location ?? "",
    }));
  }
  if (vendor === "workable") {
    const jobs =
      (data as { jobs?: Array<{ title?: string; city?: string; country?: string; telecommuting?: boolean }> })
        .jobs ?? [];
    return jobs.map((j) => ({
      title: j.title ?? "",
      location: [j.city, j.country, j.telecommuting ? "remote" : ""].filter(Boolean).join(" "),
    }));
  }
  const jobs =
    (data as { jobs?: Array<{ title?: string; location?: string; isRemote?: boolean; workplaceType?: string }> })
      .jobs ?? [];
  return jobs.map((j) => ({
    title: j.title ?? "",
    location: [j.location, j.isRemote ? "remote" : "", j.workplaceType ?? ""]
      .filter(Boolean)
      .join(" "),
  }));
}

function boardMatches(
  postings: Array<{ title: string; location: string }>,
  locationPattern: RegExp,
): boolean {
  return postings.some(
    (p) =>
      ROLE_TITLE_PATTERN.test(p.title) &&
      locationPattern.test(`${p.title} ${p.location}`),
  );
}

function looksIndianCompany(row: DirectoryRow): boolean {
  return (
    INDIA_PATTERN.test(row.companyName) ||
    INDIA_PATTERN.test(row.slug) ||
    /\b(razorpay|freshworks|browserstack|hasura|chargebee|cashfree|juspay|clevertap|druva|groww|swiggy|meesho|zerodha|phonepe|paytm|zoho|thoughtspot|mindtickle|whatfix|cred|dunzo|sharechat|lenskart|urbancompany|delhivery)\b/i.test(
      `${row.companyName} ${row.slug}`,
    )
  );
}

async function probeBoard(
  vendor: AtsVendor,
  slug: string,
  locationPattern: RegExp,
): Promise<"match" | "nomatch" | "missing" | "error"> {
  try {
    const res = await fetch(boardUrl(vendor, slug), {
      headers: {
        Accept: "application/json",
        "User-Agent": "JobRadar/0.1 (+ats-probe)",
      },
    });
    if (res.status === 404) return "missing";
    if (!res.ok) return "error";
    const data: unknown = await res.json();
    const postings = extractPostings(vendor, data);
    return boardMatches(postings, locationPattern) ? "match" : "nomatch";
  } catch {
    return "error";
  }
}

async function main(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  const { limit, vendor, forceDownload, geo } = parseArgs(process.argv.slice(2));
  const locationPattern = locationPatternForGeo(geo);

  const csvPath = await ensureDirectory(forceDownload);
  const allRows = parseCsv(fs.readFileSync(csvPath, "utf-8"));
  const already = new Set(
    getAtsBoards().map((b) => `${b.vendor}:${b.slug}`),
  );

  let candidates = allRows.filter((r) => {
    if (vendor && r.vendor !== vendor) return false;
    if (already.has(`${r.vendor}:${r.slug}`)) return false;
    return true;
  });

  // Prefer company names that hint at target geography
  const indiaPriority = candidates.filter((r) => looksIndianCompany(r));
  const otherGeoPriority = candidates.filter(
    (r) =>
      !looksIndianCompany(r) &&
      (JP_DE_PATTERN.test(r.companyName) ||
        JP_DE_PATTERN.test(r.slug) ||
        (geo !== "india" && REMOTE_PATTERN.test(r.companyName))),
  );
  const rest = candidates.filter(
    (r) => !indiaPriority.includes(r) && !otherGeoPriority.includes(r),
  );

  if (geo === "india") {
    // India-first: probe India-looking companies before the rest of the directory
    candidates = [...indiaPriority, ...rest];
  } else {
    candidates = [...indiaPriority, ...otherGeoPriority, ...rest];
  }

  if (limit != null) {
    candidates = candidates.slice(0, limit);
  }

  log(
    `Probing ${candidates.length} boards` +
      (vendor ? ` (vendor=${vendor})` : "") +
      (geo !== "all" ? ` (geo=${geo})` : "") +
      (limit ? ` (limit=${limit})` : ""),
  );

  const matches: AtsBoard[] = [];
  let missing = 0;
  let nomatch = 0;
  let errors = 0;

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]!;
    const result = await probeBoard(row.vendor, row.slug, locationPattern);
    if (result === "match") {
      matches.push({ vendor: row.vendor, slug: row.slug });
      log(`  ✓ ${row.vendor}/${row.slug} (${row.companyName})`);
    } else if (result === "missing") {
      missing += 1;
    } else if (result === "nomatch") {
      nomatch += 1;
    } else {
      errors += 1;
    }

    if ((i + 1) % 50 === 0) {
      log(`  … ${i + 1}/${candidates.length} probed (${matches.length} matches so far)`);
    }

    await sleep(300);
  }

  const applied = applyProbeResults(matches, "probe");
  log(
    `Done — matches ${matches.length}, promoted ${applied.promoted}, already-known ${applied.skipped}, no-geo/role ${nomatch}, 404 ${missing}, errors ${errors}`,
  );
  log(`Overlay: ${path.join(CACHE_DIR, "ats-boards.json")}`);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
