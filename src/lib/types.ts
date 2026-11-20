export type RemoteScope =
  | "worldwide"
  | "india"
  | "europe"
  | "us"
  | "region_locked"
  | "unknown";

export interface RuleBranch {
  id: string;
  remote?: boolean;
  eligibleFromIndia?: boolean;
  country?: string;
  minSalaryINR?: number;
  minBaseINR?: number;
  minSalaryEUR?: number;
  minSalaryJPY?: number;
  visaSponsorship?: boolean;
}

export interface MatchResult {
  matched: boolean;
  branchId?: string;
  branchLabel?: string;
  reasons: string[];
  salaryVerified?: boolean;
  visaVerified?: boolean;
}

export interface RawJob {
  externalId: string;
  source: string;
  title: string;
  company: string;
  description: string;
  url: string;
  location?: string;
  country?: string;
  isRemote?: boolean;
  /** Source states work mode explicitly (office / hybrid / remote); `isRemote` beats the LLM. */
  workModeFromSource?: boolean;
  remoteScope?: RemoteScope;
  visaSponsorship?: boolean;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  isBaseSalary?: boolean;
  salaryEstimated?: boolean;
  tags?: string[];
  postedAt?: Date;
}

export interface EnrichedJobFields {
  country?: string;
  isRemote: boolean;
  remoteScope: RemoteScope;
  visaSponsorship?: boolean;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryINRMin?: number;
  salaryINRMax?: number;
  isBaseSalary?: boolean;
  salaryEstimated: boolean;
  salaryVerified: boolean;
  visaVerified: boolean;
  tags: string[];
  requiredYearsMin?: number;
  requiredYearsMax?: number;
}

export interface ResumeProfile {
  skills: string[];
  seniority?: string;
  roles: string[];
  rawText: string;
}

import type { ApplicationStatus } from "./application-status";
export type { ApplicationStatus, StatusFilter } from "./application-status";
export {
  APPLICATION_STATUSES,
  STATUS_FILTERS,
  STATUS_LABELS,
} from "./application-status";

export type DateRange = "1d" | "7d" | "30d" | "all";

export const DATE_RANGES: Array<{ id: DateRange; label: string }> = [
  { id: "1d", label: "Last 24h" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "all", label: "All time" },
];

export type CountryFilter = "all" | "IN" | "DE" | "JP";

export const COUNTRY_FILTERS: Array<{ id: CountryFilter; label: string }> = [
  { id: "all", label: "All countries" },
  { id: "IN", label: "India" },
  { id: "DE", label: "Germany" },
  { id: "JP", label: "Japan" },
];

export const BRANCH_COUNTRY: Record<string, Exclude<CountryFilter, "all">> = {
  "remote-india": "IN",
  "india-onsite": "IN",
  germany: "DE",
  japan: "JP",
};

/** Jobs added from a pasted link. They skip the rules and enrichment and show under every chip. */
export const MANUAL_SOURCE = "manual";

/** Apply-task state shown on a card; matches `ApplyTaskStatus` in the schema. */
export type QueueStatus = "QUEUED" | "IN_PROGRESS" | "NEEDS_ANSWER" | "NEEDS_YOU" | "SUBMITTED" | "FAILED";

export interface JobMatch {
  id: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
  country: string | null;
  isRemote: boolean;
  remoteScope: string | null;
  visaSponsorship: boolean | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryINRMin: number | null;
  salaryINRMax: number | null;
  salaryEstimated: boolean;
  salaryVerified: boolean;
  visaVerified: boolean;
  isBaseSalary: boolean | null;
  tags: string[];
  source: string;
  postedAt: string | null;
  applicationStatus: ApplicationStatus | null;
  statusUpdatedAt: string | null;
  queueStatus: QueueStatus | null;
  /** The task's `ApplyIssue` code: why it is where it is. */
  queueCode: string | null;
  requiredYearsMin: number | null;
  requiredYearsMax: number | null;
  match: MatchResult;
  fitScore: number;
  fitReasons: string[];
}

export const DEFAULT_RULES: RuleBranch[] = [
  {
    id: "remote-india",
    remote: true,
    eligibleFromIndia: true,
    minSalaryINR: 3_500_000,
  },
  {
    id: "india-onsite",
    remote: false,
    country: "IN",
    minBaseINR: 4_000_000,
  },
  {
    id: "germany",
    country: "DE",
    minSalaryEUR: 70_000,
    visaSponsorship: true,
  },
  {
    id: "japan",
    country: "JP",
    minSalaryJPY: 8_000_000,
    visaSponsorship: true,
  },
];

/** Fallback chip labels; live labels come from `ruleBranchLabel` on saved rules. */
export const RULE_LABELS: Record<string, string> = {
  "remote-india": "Remote from India",
  "india-onsite": "India onsite",
  germany: "Germany",
  japan: "Japan",
};
