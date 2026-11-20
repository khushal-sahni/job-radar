import { db } from "@/lib/db";

export const DEFAULT_YEARS_OF_EXPERIENCE = 4;
export const DEFAULT_EXCLUDE_TITLE_KEYWORDS = ["staff"];
export const DEFAULT_AVOID_IF_EXCLUSIVE_LANGUAGES = ["java"];
export const DEFAULT_SCHEDULE_HOUR = 8;
export const DEFAULT_DAILY_APPLY_CAP = 15;

function normalizeStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const kw = raw.trim().toLowerCase();
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
  }
  return out;
}

function assertKeywordList(values: unknown, field: string): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array of strings`);
  }
  if (values.length > 50) {
    throw new Error(`Too many ${field} entries (max 50)`);
  }
  for (const kw of values) {
    if (typeof kw !== "string" || kw.length > 40) {
      throw new Error(`Each ${field} entry must be a string up to 40 chars`);
    }
  }
  return normalizeStringList(values);
}

export async function getPreferences() {
  const prefs = await db.preferences.findUnique({ where: { id: "default" } });
  if (prefs) return prefs;

  return db.preferences.create({
    data: {
      id: "default",
      yearsOfExperience: DEFAULT_YEARS_OF_EXPERIENCE,
      excludeTitleKeywords: DEFAULT_EXCLUDE_TITLE_KEYWORDS,
      avoidIfExclusiveLanguages: DEFAULT_AVOID_IF_EXCLUSIVE_LANGUAGES,
    },
  });
}

export async function updateYearsOfExperience(years: number) {
  if (!Number.isInteger(years) || years < 0 || years > 40) {
    throw new Error("Years of experience must be between 0 and 40");
  }

  return db.preferences.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      yearsOfExperience: years,
      excludeTitleKeywords: DEFAULT_EXCLUDE_TITLE_KEYWORDS,
      avoidIfExclusiveLanguages: DEFAULT_AVOID_IF_EXCLUSIVE_LANGUAGES,
    },
    update: { yearsOfExperience: years },
  });
}

export interface PreferencesUpdate {
  yearsOfExperience?: number;
  excludeTitleKeywords?: string[];
  avoidIfExclusiveLanguages?: string[];
  findScheduleEnabled?: boolean;
  applyScheduleEnabled?: boolean;
  scheduleHour?: number;
  dailyApplyCap?: number;
  naukriEnabled?: boolean;
}

export async function updatePreferences(input: PreferencesUpdate) {
  const data: PreferencesUpdate = {};

  if (input.yearsOfExperience != null) {
    if (
      !Number.isInteger(input.yearsOfExperience) ||
      input.yearsOfExperience < 0 ||
      input.yearsOfExperience > 40
    ) {
      throw new Error("Years of experience must be between 0 and 40");
    }
    data.yearsOfExperience = input.yearsOfExperience;
  }

  if (input.excludeTitleKeywords != null) {
    data.excludeTitleKeywords = assertKeywordList(
      input.excludeTitleKeywords,
      "excludeTitleKeywords",
    );
  }

  if (input.avoidIfExclusiveLanguages != null) {
    data.avoidIfExclusiveLanguages = assertKeywordList(
      input.avoidIfExclusiveLanguages,
      "avoidIfExclusiveLanguages",
    );
  }

  if (input.findScheduleEnabled != null) {
    data.findScheduleEnabled = Boolean(input.findScheduleEnabled);
  }

  if (input.applyScheduleEnabled != null) {
    data.applyScheduleEnabled = Boolean(input.applyScheduleEnabled);
  }

  if (input.scheduleHour != null) {
    if (
      !Number.isInteger(input.scheduleHour) ||
      input.scheduleHour < 0 ||
      input.scheduleHour > 23
    ) {
      throw new Error("Schedule hour must be between 0 and 23");
    }
    data.scheduleHour = input.scheduleHour;
  }

  if (input.dailyApplyCap != null) {
    if (
      !Number.isInteger(input.dailyApplyCap) ||
      input.dailyApplyCap < 0 ||
      input.dailyApplyCap > 1000
    ) {
      throw new Error("Daily apply cap must be between 0 and 1000");
    }
    data.dailyApplyCap = input.dailyApplyCap;
  }

  if (input.naukriEnabled != null) {
    data.naukriEnabled = Boolean(input.naukriEnabled);
  }

  return db.preferences.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      yearsOfExperience: data.yearsOfExperience ?? DEFAULT_YEARS_OF_EXPERIENCE,
      excludeTitleKeywords:
        data.excludeTitleKeywords ?? DEFAULT_EXCLUDE_TITLE_KEYWORDS,
      avoidIfExclusiveLanguages:
        data.avoidIfExclusiveLanguages ?? DEFAULT_AVOID_IF_EXCLUSIVE_LANGUAGES,
      findScheduleEnabled: data.findScheduleEnabled ?? false,
      applyScheduleEnabled: data.applyScheduleEnabled ?? false,
      scheduleHour: data.scheduleHour ?? DEFAULT_SCHEDULE_HOUR,
      dailyApplyCap: data.dailyApplyCap ?? DEFAULT_DAILY_APPLY_CAP,
      naukriEnabled: data.naukriEnabled ?? false,
    },
    update: data,
  });
}

/**
 * Stack / tooling words that routinely appear in requirement lists of roles
 * the user still wants. These only exclude when they appear in the title.
 */
export const TITLE_ONLY_EXCLUDE_KEYWORDS = new Set([
  "java",
  "php",
  "kotlin",
  "devops",
  "kubernetes",
  "robotics",
]);

export interface ExcludeKeywordMatcher {
  keyword: string;
  pattern: RegExp;
  titleOnly: boolean;
}

export function compileExcludeKeywords(
  keywords: string[],
): ExcludeKeywordMatcher[] {
  const matchers: ExcludeKeywordMatcher[] = [];
  for (const kw of keywords) {
    const needle = kw.trim().toLowerCase();
    if (!needle) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    matchers.push({
      keyword: needle,
      pattern: new RegExp(`\\b${escaped}\\b`, "i"),
      titleOnly: TITLE_ONLY_EXCLUDE_KEYWORDS.has(needle),
    });
  }
  return matchers;
}

/**
 * Returns the matched keyword, else null. Stack keywords match the title only;
 * every other keyword matches title, description, or tags.
 */
export function matchExcludeKeyword(
  job: { title: string; description: string; tags: string[] },
  matchers: ExcludeKeywordMatcher[],
): string | null {
  if (matchers.length === 0) return null;
  const fullText = [job.title, job.description, ...job.tags].join("\n");
  for (const { keyword, pattern, titleOnly } of matchers) {
    if (pattern.test(titleOnly ? job.title : fullText)) return keyword;
  }
  return null;
}
