import type { FactSheet } from "./facts";
import type { ApplyVendor, ProfileValues } from "./types";
import type { JobLocation } from "./work-auth";

/** Everything the resolvers know while answering one job's form. */
export interface ResolveContext {
  vendor: ApplyVendor;
  company: string;
  jobTitle: string;
  job?: JobLocation;
  /** Expected salary by country code from the rules, in local currency (DE: EUR, JP: JPY). */
  salaryFloors?: Partial<Record<string, number>>;
  profile: ProfileValues;
  /** Everything known about the applicant; the only source of answers to fact questions. */
  facts?: FactSheet;
  voiceSamples: string[];
  /** Parsed resume text. */
  resumeText?: string;
  /** Stored job description, the only source for what the company does. */
  jobDescription?: string;
  log?: (message: string) => void;
}
