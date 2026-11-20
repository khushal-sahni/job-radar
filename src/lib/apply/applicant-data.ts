import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "@/lib/paths";

/** Facts about the applicant that the profile form does not hold. Edit `data/applicant.json`. */

export interface Education {
  school: string;
  /**
   * Typed into school search boxes in order; a pick needs the school's distinctive words in the
   * option. The last search can take a list's "Other - Not Listed" row.
   */
  schoolSearches: readonly string[];
  degree: string;
  degreeSearches: readonly string[];
  /** Branch of the B.Tech; a list without it gets its "Other" row. */
  discipline: string;
  disciplineSearches: readonly string[];
  startYear: string;
  /** MM */
  startMonth: string;
  endYear: string;
  /** MM */
  endMonth: string;
}

/** The most recent job on the resume. `end` is null while it is the current job. */
export interface LatestJob {
  title: string;
  company: string;
  /** MM/YYYY */
  start: string;
  end: string | null;
  location: string;
  description: string;
}

interface ApplicantFile {
  backgroundFacts?: string[];
  education?: Education;
  latestJob?: LatestJob;
  earlierJobs?: LatestJob[];
  voiceLines?: string[];
}

const EMPTY_EDUCATION: Education = {
  school: "",
  schoolSearches: ["Other", "not listed"],
  degree: "",
  degreeSearches: [],
  discipline: "",
  disciplineSearches: ["Other"],
  startYear: "",
  startMonth: "",
  endYear: "",
  endMonth: "",
};

const EMPTY_JOB: LatestJob = {
  title: "",
  company: "",
  start: "",
  end: null,
  location: "",
  description: "",
};

function loadApplicantFile(): ApplicantFile {
  const root = projectRoot();
  const personal = path.join(root, "data", "applicant.json");
  const example = path.join(root, "data", "applicant.example.json");
  for (const file of [personal, example]) {
    try {
      if (!fs.existsSync(file)) continue;
      return JSON.parse(fs.readFileSync(file, "utf-8")) as ApplicantFile;
    } catch {
      // try next
    }
  }
  return {};
}

const data = loadApplicantFile();

/**
 * Standing facts for written answers. The model picks one or two that fit the question; nothing
 * outside this list, the resume, or saved answers may be claimed.
 */
export const BACKGROUND_FACTS: readonly string[] = data.backgroundFacts ?? [];

/** The degree on the resume, for education blocks. */
export const EDUCATION: Education = data.education ?? EMPTY_EDUCATION;

/** Fills the first employment block of a form (Workday "My Experience"). */
export const LATEST_JOB: LatestJob = data.latestJob ?? EMPTY_JOB;

/** Every job on the resume, newest first. */
export const WORK_HISTORY: readonly LatestJob[] = [
  data.latestJob ?? EMPTY_JOB,
  ...(data.earlierJobs ?? []),
];

/** Lines the applicant wrote himself. Tone reference only. */
export const VOICE_LINES: readonly string[] = data.voiceLines ?? [];
