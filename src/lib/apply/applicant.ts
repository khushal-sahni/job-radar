import fs from "node:fs";
import path from "node:path";
import { getActiveRules } from "@/lib/rule-store";
import { getPreferences } from "@/lib/preferences";
import { getUserProfile } from "@/lib/profile";
import { listStoredFacts } from "./fact-store";
import { buildFactSheet } from "./facts";
import { buildProfileValues, salaryFloorsFromRules } from "./profile-map";
import type { ResolveContext } from "./context";
import { latestResumeText, voiceSamples } from "./recipe-store";
import type { ApplyVendor, ProfileValues } from "./types";
import { applyLocation } from "./work-auth";

/** Everything about the applicant one run needs, loaded once. */
export interface Applicant {
  profile: ProfileValues;
  salaryFloors: Partial<Record<string, number>>;
  voiceSamples: string[];
  resumeText: string;
  resumePath: string | null;
  /** Profile shape the extension's fill scripts read. */
  extensionProfile: Record<string, unknown>;
}

function writeResume(root: string, base64: string | null | undefined, filename: string | null): string | null {
  if (!base64) return null;
  const dir = path.join(root, ".cache/apply");
  fs.mkdirSync(dir, { recursive: true });
  const safe = (filename ?? "resume.pdf").replace(/[^\w.-]+/g, "_");
  const file = path.join(dir, safe.endsWith(".pdf") ? safe : `${safe}.pdf`);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

export async function loadApplicant(root: string): Promise<Applicant> {
  const [profile, prefs, rules] = await Promise.all([
    getUserProfile({ includeResumePdf: true }),
    getPreferences(),
    getActiveRules(),
  ]);
  if (!profile.email) throw new Error("Profile has no email; fill it in Settings first");
  return {
    profile: buildProfileValues(profile, prefs.yearsOfExperience),
    salaryFloors: salaryFloorsFromRules(rules),
    voiceSamples: await voiceSamples(profile.resumeSummary),
    resumeText: await latestResumeText(),
    resumePath: writeResume(root, profile.resumePdfBase64, profile.resumeFilename),
    extensionProfile: { ...profile } as Record<string, unknown>,
  };
}

export interface JobForContext {
  vendor: ApplyVendor;
  source: string;
  company: string;
  title: string;
  country: string | null;
  location: string | null;
  remoteScope: string | null;
  description: string | null;
}
/** Resolver context for one job. Facts are re-read per job so answers given during the run count. */
export async function resolveContextFor(
  applicant: Applicant,
  job: JobForContext,
  log: (message: string) => void,
): Promise<ResolveContext> {
  const facts = buildFactSheet({ profile: applicant.profile, stored: await listStoredFacts(), resumeText: applicant.resumeText });
  const usd = Number(facts.byKey.get("profile.expected_salary_usd")?.value);
  return {
    vendor: job.vendor,
    company: job.company,
    jobTitle: job.title,
    job: applyLocation(job),
    salaryFloors: usd > 0 ? { ...applicant.salaryFloors, US: usd } : applicant.salaryFloors,
    profile: applicant.profile,
    facts,
    voiceSamples: applicant.voiceSamples,
    resumeText: applicant.resumeText,
    jobDescription: job.description ?? undefined,
    log,
  };
}
