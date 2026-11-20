import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { cdpEndpoint } from "@/lib/browser/manager";
import { EDUCATION, WORK_HISTORY } from "../applicant-data";
import type { ResolveContext } from "../context";
import { internationalNumber } from "../countries";
import { isGmailConfigured, submittedByEmail } from "../gmail";
import { SUBMITTED, park, ready } from "../outcome";
import { applyManuallyUrl, reachWorkdayForm, workdayPassword } from "../workday";
import { countryCode, expectedSalaryFor, workCountry } from "../work-auth";
import type { VendorApplier } from "./types";

/**
 * Workday (myworkdayjobs.com) jobs go to the vendored Workday copilot
 * (`vendor/workday-copilot`, installed by `scripts/setup-workday-filler.sh`), driven by
 * `scripts/workday_fill.py` against the apply Chrome. Its wizard handling replaces the generic
 * filler for Workday; sign-in and account creation still use `reachWorkdayForm`.
 */

const RUN_TIMEOUT_MS = 25 * 60_000;

function fact(ctx: ResolveContext, key: string): string {
  const value = ctx.facts?.byKey.get(key)?.value;
  return value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value);
}

function factList(ctx: ResolveContext, key: string): string[] {
  const value = ctx.facts?.byKey.get(key)?.value;
  return Array.isArray(value) ? value.map(String) : [];
}

function splitPhone(phone: string, country: string): { code: string; number: string } {
  const full = internationalNumber(phone, country) ?? phone.trim();
  const m = /^\+(\d{1,3})\s*(.*)$/.exec(full);
  return m ? { code: `+${m[1]}`, number: m[2].replace(/\D/g, "") } : { code: "", number: phone.replace(/\D/g, "") };
}

/** Whether this job needs a visa: none in the home country (or a remote role with no country), one anywhere else. */
export function needsSponsorship(ctx: ResolveContext): boolean {
  const home = countryCode(ctx.profile.country || "India") ?? "IN";
  const work = workCountry("", ctx.job);
  return Boolean(work) && work !== home;
}

function visaFor(ctx: ResolveContext): Record<string, unknown> {
  const country = ctx.profile.country || "India";
  const needs = needsSponsorship(ctx);
  return {
    type: `Citizen of ${country}`,
    expiry: "",
    authorized_to_work: !needs,
    requires_future_sponsorship: needs,
    note: needs
      ? `Citizen of ${country}; needs employer visa sponsorship to work in the job's country.`
      : `Citizen of ${country}; authorized to work in ${country} without sponsorship.`,
  };
}

/** Expected salary in the job's currency: the Germany / Japan rule floor abroad, the INR profile figure at home. */
export function workdaySalary(ctx: ResolveContext): string {
  return expectedSalaryFor(ctx.job, ctx.salaryFloors ?? {}, ctx.profile.expectedCtc).value ?? ctx.profile.expectedCtc ?? "";
}

/** The copilot's `e_applicant.json` shape, from the profile, facts and resume history. */
export function workdayApplicant(ctx: ResolveContext): Record<string, unknown> {
  const p = ctx.profile;
  const country = p.country || "India";
  const phone = splitPhone(p.phone, country);
  const [street = "", city = p.city, state = "", ...rest] = fact(ctx, "profile.address").split(",").map((s) => s.trim());
  const postcode = fact(ctx, "profile.zipcode") || rest.find((s) => /^\d{4,}$/.test(s)) || "";
  const gpa = fact(ctx, "education.gpa");
  return {
    first_name: p.firstName,
    last_name: p.lastName,
    email: p.email,
    phone: phone.number,
    phone_country_code: phone.code,
    address: { street, suburb: city, city, state, state_abbr: "", postcode, country },
    linkedin: p.linkedInUrl,
    website: p.portfolioUrl || p.githubUrl,
    visa: visaFor(ctx),
    referral_source: "Company Website",
    work_experience: WORK_HISTORY.map((j) => ({
      title: j.title,
      company: j.company,
      start: j.start,
      end: j.end ?? "Present",
      description: j.description,
    })),
    education: [
      {
        institution: EDUCATION.school,
        degree: EDUCATION.degree,
        field: EDUCATION.discipline,
        start: `07/${EDUCATION.startYear}`,
        end: `05/${EDUCATION.endYear}`,
        gpa: gpa ? `${gpa}/10` : null,
      },
    ],
    certifications: [],
    skills: factList(ctx, "skills.professional"),
  };
}

/** Workday's gender option, only when the saved pronouns say it; otherwise the form keeps its default. */
function genderFromPronouns(pronouns: string): string | null {
  if (/^\s*he\b/i.test(pronouns)) return "Male";
  if (/^\s*she\b/i.test(pronouns)) return "Female";
  return null;
}

interface FillResult {
  status: "submitted" | "ready" | "parked" | "unconfirmed";
  reason: string;
}

function runFiller(root: string, jobFile: string, log: (m: string) => void): Promise<FillResult> {
  const python = path.join(root, "vendor/workday-copilot/.venv/bin/python");
  return new Promise((resolve) => {
    const child = spawn(python, [path.join(root, "scripts/workday_fill.py"), jobFile], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let outcome: FillResult | null = null;
    const timer = setTimeout(() => {
      outcome ??= { status: "parked", reason: "Workday filler took longer than 25 minutes" };
      child.kill("SIGTERM");
    }, RUN_TIMEOUT_MS);
    const onLine = (line: string) => {
      if (line.startsWith("JR_RESULT ")) {
        try {
          outcome = JSON.parse(line.slice("JR_RESULT ".length)) as FillResult;
        } catch {
          /* malformed result line: handled as no result below */
        }
        return;
      }
      if (line.trim()) log(`  wd| ${line}`);
    };
    readline.createInterface({ input: child.stdout }).on("line", onLine);
    readline.createInterface({ input: child.stderr }).on("line", onLine);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(outcome ?? { status: "parked", reason: `Workday filler exited (${code}) without a result` });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "parked", reason: `Workday filler did not start: ${err.message}` });
    });
  });
}

export const workdayApplier: VendorApplier = {
  profile: "apply",
  async apply(lease, job, env) {
    const { root, log } = env;
    if (!fs.existsSync(path.join(root, "vendor/workday-copilot/.venv/bin/python"))) {
      return park("no_form", "Workday filler is not installed; run scripts/setup-workday-filler.sh");
    }
    const { getOpenRouterApiKey } = await import("@/lib/secrets");
    const openrouterKey = getOpenRouterApiKey();
    if (!openrouterKey) return park("no_form", "Workday filler needs an OpenRouter key in Setup or Settings");
    const cdpUrl = cdpEndpoint("apply", root);
    if (!cdpUrl) return park("browser", "Apply Chrome has no DevTools port");

    const email = job.ctx.profile.email;
    const page = await lease.newPage();
    let posting = { title: "", description: "" };
    try {
      await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator("[data-automation-id='jobPostingHeader']").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      posting = await page
        .evaluate(() => ({
          title: document.querySelector("[data-automation-id='jobPostingHeader']")?.textContent?.trim() ?? "",
          description: document.querySelector("[data-automation-id='jobPostingDescription']")?.textContent?.trim() ?? "",
        }))
        .catch(() => posting);
      const blocked = await reachWorkdayForm(page, job.url, { root, email, log });
      if (blocked) {
        await page.close().catch(() => undefined);
        return blocked;
      }
    } catch (err) {
      await page.close().catch(() => undefined);
      throw err;
    }

    const dir = path.join(root, ".cache/workday-fill");
    fs.mkdirSync(dir, { recursive: true });
    const applicantPath = path.join(dir, `${job.taskId}.applicant.json`);
    const jobFile = path.join(dir, `${job.taskId}.job.json`);
    fs.writeFileSync(applicantPath, JSON.stringify(workdayApplicant(job.ctx), null, 2));
    const country = job.ctx.profile.country || "India";
    const phone = splitPhone(job.ctx.profile.phone, country);
    const years = job.ctx.profile.yearsOfExperience || fact(job.ctx, "experience.total_years") || "4";
    fs.writeFileSync(
      jobFile,
      JSON.stringify({
        url: applyManuallyUrl(job.url),
        cdpUrl,
        applicantPath,
        resumePath: env.applicant.resumePath ?? "",
        company: job.ctx.company,
        jobTitle: posting.title || job.ctx.jobTitle,
        jobDescription: job.ctx.jobDescription || posting.description,
        email,
        password: workdayPassword(root, job.url, email),
        dryRun: env.plan.dryRun || env.plan.mode === "fill_only",
        openrouterKey,
        model: process.env.WORKDAY_FILLER_MODEL || process.env.OPENROUTER_MODEL_FALLBACK || "google/gemini-2.5-flash-lite",
        phoneCountry: { name: country, code: phone.code },
        gender: genderFromPronouns(fact(job.ctx, "profile.pronouns")),
        dateOfBirth: fact(job.ctx, "profile.date_of_birth"),
        config: {
          WORKDAY_EMAIL: email,
          SALUTATION: "Mr.",
          REFERRAL_SOURCE: "Web Site",
          YEARS_EXPERIENCE: years,
          SALARY_EXPECTATION: workdaySalary(job.ctx),
          SALARY_EXPECTATION_SINGLE: workdaySalary(job.ctx),
          LEAVING_REASON: "Looking for a role with more ownership of backend systems at scale.",
          INDIGENOUS_STATUS: "Neither",
          DEFAULT_LOCATION: job.ctx.profile.location,
          VISA_INFO: needsSponsorship(job.ctx)
            ? `Candidate is a citizen of ${country} and needs visa sponsorship to work in this job's country.`
            : `Candidate is a citizen of ${country} and needs no visa sponsorship to work there.`,
          WORK_RIGHTS_ANSWER: needsSponsorship(job.ctx) ? "No" : "Yes",
          LANG_PROFICIENCY: {
            English: { level: "Fluent", fallback: "Advanced", fluent: true },
            Hindi: { level: "Native", fallback: "Fluent", fluent: true },
          },
          SUPPLEMENTARY_FILES: [],
        },
      }),
      { mode: 0o600 },
    );

    log("  Workday: handing the form to the Workday filler");
    const mailSince = new Date(Date.now() - 30_000);
    try {
      const res = await runFiller(root, jobFile, log);
      if (res.status === "submitted") return SUBMITTED;
      if (res.status === "ready") return ready(res.reason);
      if (res.status === "unconfirmed") {
        if (
          await submittedByEmail({
            since: mailSince,
            company: job.ctx.company,
            jobTitle: posting.title || job.ctx.jobTitle,
            timeoutMs: 90_000,
            log,
          })
        ) {
          return SUBMITTED;
        }
        return park(
          "no_confirmation",
          isGmailConfigured() ? `${res.reason}; Gmail had no matching submission email` : res.reason,
        );
      }
      return park("cannot_answer", `Workday filler stopped: ${res.reason}`);
    } finally {
      await page.close().catch(() => undefined);
      fs.rmSync(jobFile, { force: true });
      fs.rmSync(applicantPath, { force: true });
    }
  },
};
