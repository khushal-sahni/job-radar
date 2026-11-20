import { db } from "./db";
import { buildResumeProfile } from "./match";
import { extractPdfText } from "./pdf-text";
import { syncResumePdfToProfile } from "./profile";

export interface ResumeSummary {
  id: string;
  filename: string;
  skills: string[];
  seniority: string | null;
  roles: string[];
  createdAt: Date;
}

export async function getLatestResume() {
  return db.resume.findFirst({ orderBy: { createdAt: "desc" } });
}

function summarize(row: ResumeSummary): ResumeSummary {
  const { id, filename, skills, seniority, roles, createdAt } = row;
  return { id, filename, skills, seniority, roles, createdAt };
}

export async function latestResumeSummary(): Promise<ResumeSummary | null> {
  const row = await getLatestResume();
  return row ? summarize(row) : null;
}

export class ResumeInputError extends Error {}

/**
 * Stores an uploaded PDF resume: its text and skill profile for matching, and the file itself on
 * the profile for form uploads. Throws `ResumeInputError` for a file that is not a readable PDF.
 */
export async function importResumePdf(filename: string, buffer: Buffer): Promise<{ resume: ResumeSummary; rawText: string }> {
  if (!filename.toLowerCase().endsWith(".pdf")) throw new ResumeInputError("Only PDF resumes supported");
  const text = await extractPdfText(buffer);
  if (!text) throw new ResumeInputError("Could not extract text from PDF");

  await syncResumePdfToProfile(filename, buffer.toString("base64"));
  const profile = await buildResumeProfile(text);
  const row = await db.resume.create({
    data: { filename, rawText: profile.rawText, skills: profile.skills, seniority: profile.seniority, roles: profile.roles },
  });
  return { resume: summarize(row), rawText: profile.rawText };
}
