import type { RawJob } from "../types";
import { getAtsSlugs } from "./ats-boards";
import { fetchJson, sleep, stripHtml, type SourceAdapter } from "./base";
import { ROLE_TITLE_PATTERN } from "./role-filter";
import { gateJobgether } from "../jobgether";

export interface LeverPosting {
  id: string;
  text: string;
  description?: string;
  descriptionPlain?: string;
  lists?: Array<{ text?: string; content?: string }>;
  additional?: string;
  additionalPlain?: string;
  categories?: {
    location?: string;
    team?: string;
    department?: string;
    commitment?: string;
  };
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
}

function plainOrStripped(plain?: string, html?: string): string {
  const trimmed = plain?.trim();
  if (trimmed) return trimmed;
  return stripHtml(html ?? "");
}

/** Lever splits requirements into `lists`; empty plain fields must not hide HTML */
export function buildDescription(job: LeverPosting): string {
  const parts = [plainOrStripped(job.descriptionPlain, job.description)];
  for (const list of job.lists ?? []) {
    const content = stripHtml(list.content ?? "");
    if (!content) continue;
    const heading = list.text?.trim();
    parts.push(heading ? `${heading}\n${content}` : content);
  }
  parts.push(plainOrStripped(job.additionalPlain, job.additional));
  return parts.filter(Boolean).join("\n\n");
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

export const leverAdapter: SourceAdapter = {
  name: "lever",

  async fetchJobs(report): Promise<RawJob[]> {
    const jobs: RawJob[] = [];
    const companies = getAtsSlugs("lever");
    let live = 0;
    let missing = 0;
    let errors = 0;
    let offCountry = 0;

    for (const company of companies) {
      try {
        const url = `https://api.lever.co/v0/postings/${company}?mode=json`;
        const data = await fetchJson<LeverPosting[]>(url);
        live += 1;

        for (const job of data ?? []) {
          if (!job.id || !job.text) continue;
          if (!ROLE_TITLE_PATTERN.test(job.text)) continue;

          const location = job.categories?.location ?? "";
          if (gateJobgether(company, location).kind === "drop") {
            offCountry += 1;
            continue;
          }
          const description = buildDescription(job);
          const tags = [
            job.categories?.team,
            job.categories?.department,
            job.categories?.commitment,
          ].filter((t): t is string => Boolean(t));

          jobs.push({
            externalId: job.id,
            source: "lever",
            title: job.text,
            company,
            description,
            url:
              job.hostedUrl ??
              job.applyUrl ??
              `https://jobs.lever.co/${company}/${job.id}`,
            location: location || undefined,
            isRemote:
              /remote/i.test(location) ||
              /remote/i.test(job.workplaceType ?? ""),
            tags,
            postedAt:
              typeof job.createdAt === "number"
                ? new Date(job.createdAt)
                : undefined,
          });
        }
      } catch (err) {
        if (isNotFound(err)) {
          missing += 1;
          report.deadBoard(company, "404");
        } else {
          errors += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[lever] error ${company}: ${message}`);
        }
      }

      await sleep(300);
    }

    console.log(
      `[lever] ${live}/${companies.length} live · ${missing} demoted · ${errors} errors · ${offCountry} jobgether off-country · ${jobs.length} roles`,
    );

    return jobs;
  },
};
