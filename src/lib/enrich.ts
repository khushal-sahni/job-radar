import type { EnrichedJobFields, RawJob, RemoteScope } from "./types";
import { salaryRangeToINRSync, toINRSync } from "./fx";
import { enrichWithOpenRouter } from "./openrouter";
import { parseRequiredYears } from "./yoe";
import { countryFromText } from "./location";
import { APPLIED_AI_TITLE_PATTERN, ROLE_TITLE_PATTERN } from "./sources/role-filter";

const VISA_PATTERNS =
  /\b(visa\s+sponsor(ship)?|work\s+permit|relocation\s+support|sponsor\s+visa|immigration\s+support|will\s+sponsor)\b/i;

const REMOTE_INDIA_PATTERNS =
  /\b(india|indian\s+timezone|ist|work\s+from\s+india|hire\s+in\s+india|remote\s+.*\bindia\b)/i;

/** True worldwide / work-from-anywhere — not work-mode phrases like "fully remote". */
const WORLDWIDE_PATTERNS =
  /\b(worldwide|work\s+from\s+anywhere|anywhere\s+in\s+the\s+world)\b/i;

const REGION_LOCK_PATTERNS =
  /\b(must\s+be\s+(located|based|living)|only\s+(open\s+to|hiring\s+in|candidates\s+in)|within\s+\d+\s*(miles?|km|kilometers?)|us[\s-]?only|usa[\s-]?only|europe[\s-]?only)\b/i;

const EUROPE_SCOPE_PATTERNS =
  /\b(europe|eu\b|emea|berlin|germany|munich|amsterdam|london|uk\b|united\s+kingdom)\b/i;

const US_SCOPE_PATTERNS =
  /\b(us\b|usa\b|united\s+states|north\s+america|san\s+francisco|new\s+york|seattle|austin|remote\s+us)\b/i;

const BASE_SALARY_PATTERNS =
  /\b(base\s+salary|base\s+pay|fixed\s+salary|annual\s+base)\b/i;

const TOTAL_COMP_PATTERNS =
  /\b(total\s+comp|ctc|including\s+bonus|including\s+equity|ote)\b/i;

const BACKEND_KEYWORDS =
  /\b(backend|back-end|full[\s-]?stack|platform|api|distributed|microservices|golang|go\b|python|java|node\.?js|rust|kotlin)\b/i;

function parseSalaryFromText(text: string): {
  min?: number;
  max?: number;
  currency?: string;
} {
  const normalized = text.replace(/,/g, "");

  const patterns: Array<{
    regex: RegExp;
    currency: string;
    multiplier: number;
  }> = [
    {
      regex: /(?:₹|INR|Rs\.?)\s*(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(?:₹|INR|Rs\.?)?\s*(\d+(?:\.\d+)?)\s*(LPA|Lakhs?|Cr|Crore)?/i,
      currency: "INR",
      multiplier: 1,
    },
    {
      regex: /(?:₹|INR|Rs\.?)\s*(\d+(?:\.\d+)?)\s*(LPA|Lakhs?|Cr|Crore)?/i,
      currency: "INR",
      multiplier: 1,
    },
    {
      regex: /€\s*(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*€?\s*(\d+(?:\.\d+)?)\s*(k|K)?/i,
      currency: "EUR",
      multiplier: 1,
    },
    {
      regex: /\$\s*(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*\$?\s*(\d+(?:\.\d+)?)\s*(k|K)?/i,
      currency: "USD",
      multiplier: 1,
    },
    {
      regex: /¥\s*(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*¥?\s*(\d+(?:\.\d+)?)\s*(万|M|million)?/i,
      currency: "JPY",
      multiplier: 1,
    },
    {
      regex: /(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)\s*(LPA|Lakhs?)/i,
      currency: "INR",
      multiplier: 100_000,
    },
  ];

  for (const { regex, currency, multiplier } of patterns) {
    const match = normalized.match(regex);
    if (!match) continue;

    const scale = (unit?: string) => {
      if (!unit) return multiplier;
      const u = unit.toLowerCase();
      if (u.includes("cr") || u.includes("crore")) return 10_000_000;
      if (u.includes("lpa") || u.includes("lakh")) return 100_000;
      if (u === "k") return 1_000;
      if (u === "m" || u.includes("million")) return 1_000_000;
      if (u.includes("万")) return 10_000;
      return multiplier;
    };

    const unit = match[match.length - 1];
    const m = scale(unit);

    if (match[2] && !Number.isNaN(Number(match[2]))) {
      return {
        min: Number(match[1]) * m,
        max: Number(match[2]) * m,
        currency,
      };
    }

    return {
      min: Number(match[1]) * m,
      currency,
    };
  }

  return {};
}

function inferCountry(location?: string, description?: string, explicit?: string): string | undefined {
  if (explicit && explicit.length === 2) return explicit.toUpperCase();
  return countryFromText(`${location ?? ""} ${description ?? ""}`);
}

export function inferRemoteScope(
  isRemote: boolean,
  location?: string,
  description?: string,
): RemoteScope {
  if (!isRemote) return "unknown";

  const text = `${location ?? ""} ${description ?? ""}`.toLowerCase();

  // Geo locks before vague "fully remote" / worldwide phrasing
  if (REMOTE_INDIA_PATTERNS.test(text)) return "india";
  if (REGION_LOCK_PATTERNS.test(text)) {
    if (REMOTE_INDIA_PATTERNS.test(text)) return "india";
    if (EUROPE_SCOPE_PATTERNS.test(text)) return "europe";
    if (US_SCOPE_PATTERNS.test(text)) return "us";
    return "region_locked";
  }
  if (EUROPE_SCOPE_PATTERNS.test(text) && !WORLDWIDE_PATTERNS.test(text)) {
    return "europe";
  }
  if (US_SCOPE_PATTERNS.test(text) && !WORLDWIDE_PATTERNS.test(text)) {
    return "us";
  }
  if (WORLDWIDE_PATTERNS.test(text) || /\banywhere\b/i.test(text)) {
    return "worldwide";
  }

  return "unknown";
}

function extractTags(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const tech = [
    "backend",
    "full stack",
    "fullstack",
    "golang",
    "go",
    "python",
    "java",
    "node",
    "typescript",
    "rust",
    "kotlin",
    "aws",
    "kubernetes",
    "postgres",
    "distributed systems",
    "platform",
    "api",
    "llm",
    "openai",
    "langchain",
    "rag",
    "agents",
  ];

  return tech.filter((t) => text.includes(t.replace(/\s+/g, " ")));
}

export function heuristicEnrich(job: RawJob): EnrichedJobFields {
  const text = `${job.title}\n${job.description}\n${job.location ?? ""}`;
  const parsed = parseSalaryFromText(text);

  const salaryMin = job.salaryMin ?? parsed.min;
  const salaryMax = job.salaryMax ?? parsed.max;
  const salaryCurrency = job.salaryCurrency ?? parsed.currency;

  const inr = salaryRangeToINRSync(salaryMin, salaryMax, salaryCurrency);

  const isRemote =
    job.isRemote ??
    /\b(remote|work from home|wfh|distributed)\b/i.test(text);

  const country = inferCountry(job.location, job.description, job.country);
  const inferredScope = inferRemoteScope(
    isRemote,
    job.location,
    job.description,
  );
  // Prefer text inference over adapter pins of worldwide/unknown
  const adapterScope = job.remoteScope;
  const remoteScope =
    inferredScope !== "unknown"
      ? inferredScope
      : adapterScope && adapterScope !== "worldwide" && adapterScope !== "unknown"
        ? adapterScope
        : inferredScope;

  const visaSponsorship =
    job.visaSponsorship ??
    (VISA_PATTERNS.test(text) ? true : undefined);

  const isBaseSalary =
    job.isBaseSalary ??
    (BASE_SALARY_PATTERNS.test(text)
      ? true
      : TOTAL_COMP_PATTERNS.test(text)
        ? false
        : undefined);

  const salaryEstimated =
    job.salaryEstimated ??
    (job.salaryMin == null && parsed.min != null);

  const tags = [
    ...new Set([...(job.tags ?? []), ...extractTags(job.title, job.description)]),
  ];

  const yoe = parseRequiredYears(text);

  const salaryVerified = inr.min != null || inr.max != null;
  const visaVerified = visaSponsorship === true;

  return {
    country,
    isRemote,
    remoteScope,
    visaSponsorship,
    salaryMin,
    salaryMax,
    salaryCurrency,
    salaryINRMin: inr.min,
    salaryINRMax: inr.max,
    isBaseSalary,
    salaryEstimated,
    salaryVerified,
    visaVerified,
    tags,
    requiredYearsMin: yoe.min,
    requiredYearsMax: yoe.max,
  };
}

export interface EnrichJobResult extends EnrichedJobFields {
  enrichmentModel: string;
}

export async function enrichJob(job: RawJob): Promise<EnrichJobResult> {
  const heuristic = heuristicEnrich(job);
  const { data: llm, model } = await enrichWithOpenRouter(job);

  const salaryMin = llm.salaryMin ?? heuristic.salaryMin;
  const salaryMax = llm.salaryMax ?? heuristic.salaryMax;
  const salaryCurrency = llm.salaryCurrency ?? heuristic.salaryCurrency;
  const inr = salaryRangeToINRSync(salaryMin, salaryMax, salaryCurrency);
  const llmFoundSalary = llm.salaryMin != null || llm.salaryMax != null;
  // Source market estimate (e.g. AmbitionBox): not a posted figure, so no base/CTC verdict.
  const usesSourceEstimate = !llmFoundSalary && job.salaryEstimated === true;

  const visaSponsorship =
    llm.visaSponsorship !== undefined
      ? (llm.visaSponsorship ?? undefined)
      : heuristic.visaSponsorship;

  const merged: EnrichJobResult = {
    country: llm.country ?? heuristic.country,
    isRemote:
      job.workModeFromSource && job.isRemote != null
        ? job.isRemote
        : (llm.isRemote ?? heuristic.isRemote),
    remoteScope: (llm.remoteScope as RemoteScope | undefined) ?? heuristic.remoteScope,
    visaSponsorship,
    salaryMin,
    salaryMax,
    salaryCurrency,
    salaryINRMin: inr.min,
    salaryINRMax: inr.max,
    isBaseSalary: usesSourceEstimate
      ? undefined
      : llm.isBaseSalary !== undefined && llm.isBaseSalary !== null
        ? llm.isBaseSalary
        : heuristic.isBaseSalary,
    salaryEstimated: llmFoundSalary
      ? (llm.salaryEstimated ?? heuristic.salaryEstimated)
      : heuristic.salaryEstimated,
    salaryVerified: !usesSourceEstimate && (inr.min != null || inr.max != null),
    visaVerified: visaSponsorship === true,
    tags: [...new Set([...(llm.tags ?? []), ...heuristic.tags])],
    requiredYearsMin:
      llm.requiredYearsMin ?? heuristic.requiredYearsMin ?? undefined,
    requiredYearsMax:
      llm.requiredYearsMax ?? heuristic.requiredYearsMax ?? undefined,
    enrichmentModel: model,
  };

  return merged;
}

const EARLY_CAREER_TITLE_RE =
  /\b(interns?|internship|co-?op|campus|new[\s-]?grad(?:uate)?s?|early[\s-]?career|fresher|graduate([\s-]?program)?|university[\s-]?grad)\b/i;
const YEAR_LEAD_RE = /^\s*20(2[5-9])\b/;

/**
 * Backend / full-stack / applied-AI titles only. Body keywords like "platform" or "distributed"
 * never admit a support or marketing title. Intern, campus, new-grad and year-graduate titles
 * are out even when the body talks about backend work.
 */
export function isRelevantRole(title: string, description: string): boolean {
  if (!ROLE_TITLE_PATTERN.test(title)) return false;
  if (EARLY_CAREER_TITLE_RE.test(title) || YEAR_LEAD_RE.test(title)) return false;
  const text = `${title} ${description}`.toLowerCase();
  const appliedAiTitle = APPLIED_AI_TITLE_PATTERN.test(title);
  if (/\b(manager|director|vp|head of|recruiter)\b/.test(text)) {
    if (!BACKEND_KEYWORDS.test(text) && !appliedAiTitle) return false;
  }
  return true;
}

export function mergeEnrichment(
  existing: EnrichedJobFields,
  incoming: EnrichedJobFields,
): EnrichedJobFields {
  return {
    country: incoming.country ?? existing.country,
    isRemote: incoming.isRemote ?? existing.isRemote,
    remoteScope: incoming.remoteScope ?? existing.remoteScope,
    visaSponsorship: incoming.visaSponsorship ?? existing.visaSponsorship,
    salaryMin: incoming.salaryMin ?? existing.salaryMin,
    salaryMax: incoming.salaryMax ?? existing.salaryMax,
    salaryCurrency: incoming.salaryCurrency ?? existing.salaryCurrency,
    salaryINRMin: incoming.salaryINRMin ?? existing.salaryINRMin,
    salaryINRMax: incoming.salaryINRMax ?? existing.salaryINRMax,
    isBaseSalary: incoming.isBaseSalary ?? existing.isBaseSalary,
    salaryEstimated: incoming.salaryEstimated ?? existing.salaryEstimated,
    salaryVerified: incoming.salaryVerified ?? existing.salaryVerified,
    visaVerified: incoming.visaVerified ?? existing.visaVerified,
    tags: [...new Set([...existing.tags, ...incoming.tags])],
    requiredYearsMin: incoming.requiredYearsMin ?? existing.requiredYearsMin,
    requiredYearsMax: incoming.requiredYearsMax ?? existing.requiredYearsMax,
  };
}

export function toINRForRule(
  amount: number,
  currency: "INR" | "EUR" | "JPY",
): number {
  return toINRSync(amount, currency);
}
