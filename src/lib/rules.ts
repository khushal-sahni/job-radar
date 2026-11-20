import type { MatchResult, RuleBranch } from "./types";
import { ruleBranchLabel } from "./rules-form";
import { toINRSync } from "./fx";
import { closedListTarget } from "./location";

export interface JobForRules {
  /** Ashby and Workable `location` lists every hiring place; see `closedLocationList`. */
  source?: string | null;
  country?: string | null;
  isRemote: boolean;
  remoteScope?: string | null;
  visaSponsorship?: boolean | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryINRMin?: number | null;
  salaryINRMax?: number | null;
  isBaseSalary?: boolean | null;
  location?: string | null;
}

export type RejectionCategory =
  | "matched"
  | "yoe"
  | "not_remote"
  | "not_eligible_from_india"
  | "salary_below_threshold"
  | "not_in_target_country"
  | "visa_rejected"
  | "base_not_confirmed"
  | "no_matching_rule";

function effectiveINR(job: JobForRules): number | undefined {
  if (job.salaryINRMax != null) return job.salaryINRMax;
  if (job.salaryINRMin != null) return job.salaryINRMin;
  return undefined;
}

function inrToCurrency(inr: number, currency: "EUR" | "JPY"): number {
  const rate = toINRSync(1, currency);
  return inr / rate;
}

function effectiveEUR(job: JobForRules): number | undefined {
  if (job.salaryCurrency?.toUpperCase() === "EUR") {
    return job.salaryMax ?? job.salaryMin ?? undefined;
  }
  const inr = effectiveINR(job);
  if (inr != null) return inrToCurrency(inr, "EUR");
  return undefined;
}

function effectiveJPY(job: JobForRules): number | undefined {
  if (job.salaryCurrency?.toUpperCase() === "JPY") {
    return job.salaryMax ?? job.salaryMin ?? undefined;
  }
  const inr = effectiveINR(job);
  if (inr != null) return inrToCurrency(inr, "JPY");
  return undefined;
}

/**
 * Outside the branch's country. A closed hiring list overrules the stored country and the
 * description: the job counts only for the one country `pickTargetPlace` would apply from.
 */
function outsideCountry(job: JobForRules, country: "IN" | "DE" | "JP", strict: boolean): boolean {
  const listed = closedListTarget(job);
  if (listed !== undefined) return listed !== country;
  return strict ? job.country !== country : Boolean(job.country && job.country !== country);
}

/** True when a remote role is open to candidates in India (or clearly worldwide). */
export function eligibleFromIndia(job: JobForRules): boolean {
  const listed = closedListTarget(job);
  if (listed !== undefined) return listed === "IN";
  if (!job.isRemote) return job.country === "IN";

  const scope = job.remoteScope ?? "unknown";
  if (scope === "worldwide" || scope === "india") return true;
  if (scope === "us" || scope === "europe" || scope === "region_locked") {
    return false;
  }

  // unknown — only if location text clearly allows India / worldwide
  const loc = `${job.location ?? ""}`.toLowerCase();
  return (
    /\b(india|indian|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurugram|gurgaon|chennai)\b/.test(
      loc,
    ) ||
    /\b(worldwide|anywhere|work from anywhere)\b/.test(loc)
  );
}

function reject(
  reasons: string[],
  partial?: Partial<MatchResult>,
): MatchResult {
  return { matched: false, reasons, salaryVerified: false, visaVerified: false, ...partial };
}

function match(
  branch: RuleBranch,
  reasons: string[],
  flags: { salaryVerified: boolean; visaVerified: boolean },
): MatchResult {
  return {
    matched: true,
    branchId: branch.id,
    branchLabel: ruleBranchLabel(branch),
    reasons,
    salaryVerified: flags.salaryVerified,
    visaVerified: flags.visaVerified,
  };
}

function evaluateBranch(job: JobForRules, branch: RuleBranch): MatchResult {
  const reasons: string[] = [];

  if (branch.remote === true) {
    if (!job.isRemote) {
      return reject(["Not remote"]);
    }
    reasons.push("Remote role");

    if (branch.eligibleFromIndia) {
      if (!eligibleFromIndia(job)) {
        return reject(["Remote but not eligible from India"]);
      }
      reasons.push("Eligible from India");
    }

    if (branch.minSalaryINR != null) {
      const inr = effectiveINR(job);
      if (inr == null) {
        reasons.push("Salary not listed");
        return match(branch, reasons, {
          salaryVerified: false,
          visaVerified: true,
        });
      }
      const floor = Math.round(branch.minSalaryINR / 100_000);
      if (inr < branch.minSalaryINR) {
        return reject([
          `Salary ${Math.round(inr / 100_000)} LPA below ${floor} LPA threshold`,
        ]);
      }
      reasons.push(`Salary ≥${floor} LPA (${Math.round(inr / 100_000)} LPA)`);
    }

    return match(branch, reasons, { salaryVerified: true, visaVerified: true });
  }

  if (branch.remote === false && branch.country === "IN") {
    if (job.isRemote) {
      return reject(["Remote role — India onsite rule requires non-remote"]);
    }
    if (outsideCountry(job, "IN", true)) {
      return reject(["Not in India"]);
    }
    reasons.push("India onsite");

    if (branch.minBaseINR != null) {
      const inr = effectiveINR(job);
      if (inr == null) {
        reasons.push("Salary not listed");
        return match(branch, reasons, {
          salaryVerified: false,
          visaVerified: true,
        });
      }
      if (job.isBaseSalary === false) {
        return reject(["Listed comp appears to be total/CTC, not base"]);
      }
      const floor = Math.round(branch.minBaseINR / 100_000);
      if (inr < branch.minBaseINR) {
        return reject([
          `Base ${Math.round(inr / 100_000)} LPA below ${floor} LPA threshold`,
        ]);
      }
      reasons.push(`Base ≥${floor} LPA (${Math.round(inr / 100_000)} LPA)`);
    }

    return match(branch, reasons, { salaryVerified: true, visaVerified: true });
  }

  // Germany is a hard gate: stated country, listed salary and confirmed sponsorship. Japan needs
  // only the stated country, so jobs with no country never fall through to it.
  if (branch.country === "DE") {
    if (outsideCountry(job, "DE", true)) {
      return reject(["Not in Germany"]);
    }
    reasons.push("Germany");

    if (branch.visaSponsorship) {
      if (job.visaSponsorship === false) {
        return reject(["Visa sponsorship explicitly not offered"]);
      }
      if (job.visaSponsorship !== true) {
        return reject(["Visa sponsorship not confirmed"]);
      }
      reasons.push("Visa sponsorship confirmed");
    }

    if (branch.minSalaryEUR != null) {
      const eur = effectiveEUR(job);
      if (eur == null) {
        return reject(["Salary not listed"]);
      }
      if (eur < branch.minSalaryEUR) {
        return reject([
          `Salary €${Math.round(eur / 1000)}k below €70k threshold`,
        ]);
      }
      reasons.push(`Salary ≥€70k (€${Math.round(eur / 1000)}k)`);
    }

    return match(branch, reasons, {
      salaryVerified: effectiveEUR(job) != null,
      visaVerified: true,
    });
  }

  if (branch.country === "JP") {
    if (outsideCountry(job, "JP", true)) {
      return reject(["Not in Japan"]);
    }
    reasons.push("Japan");

    let visaVerified = true;
    if (branch.visaSponsorship) {
      if (job.visaSponsorship === false) {
        return reject(["Visa sponsorship explicitly not offered"]);
      }
      if (job.visaSponsorship !== true) {
        visaVerified = false;
        reasons.push("Visa sponsorship not confirmed");
      } else {
        reasons.push("Visa sponsorship confirmed");
      }
    }

    if (branch.minSalaryJPY != null) {
      const jpy = effectiveJPY(job);
      if (jpy == null) {
        reasons.push("Salary not listed");
        return match(branch, reasons, {
          salaryVerified: false,
          visaVerified,
        });
      }
      if (jpy < branch.minSalaryJPY) {
        return reject([
          `Salary ¥${(jpy / 1_000_000).toFixed(1)}M below ¥8M threshold`,
        ]);
      }
      reasons.push(`Salary ≥¥8M (¥${(jpy / 1_000_000).toFixed(1)}M)`);
    }

    return match(branch, reasons, {
      salaryVerified: effectiveJPY(job) != null,
      visaVerified,
    });
  }

  return reject(["No matching rule branch"]);
}

export function evaluateJob(
  job: JobForRules,
  rules: RuleBranch[],
): MatchResult {
  let firstReject: MatchResult | null = null;
  for (const branch of rules) {
    const result = evaluateBranch(job, branch);
    if (result.matched) return result;
    if (!firstReject) firstReject = result;
  }

  return (
    firstReject ?? reject(["Does not match any preference rule"])
  );
}

export function classifyRejection(reason: string): RejectionCategory {
  if (reason.startsWith("Not remote")) return "not_remote";
  if (reason.includes("not eligible from India")) return "not_eligible_from_india";
  if (reason.includes("below") && reason.toLowerCase().includes("salary")) {
    return "salary_below_threshold";
  }
  if (
    reason.startsWith("Not in India") ||
    reason.startsWith("Not in Germany") ||
    reason.startsWith("Not in Japan")
  ) {
    return "not_in_target_country";
  }
  if (reason.startsWith("Visa sponsorship")) return "visa_rejected";
  if (reason.includes("total/CTC")) return "base_not_confirmed";
  return "no_matching_rule";
}

export function parseRules(json: unknown): RuleBranch[] {
  if (!Array.isArray(json)) return [];
  return json as RuleBranch[];
}

export function createEmptyFunnel(total = 0) {
  return {
    total,
    yoeRejected: 0,
    keywordExcluded: 0,
    languageExcluded: 0,
    jobgetherExcluded: 0,
    notRemote: 0,
    notEligibleFromIndia: 0,
    salaryBelowThreshold: 0,
    notInTargetCountry: 0,
    visaRejected: 0,
    baseNotConfirmed: 0,
    noMatchingRule: 0,
    matched: 0,
    salaryUnverified: 0,
    visaUnverified: 0,
  };
}

export type MatchFunnel = ReturnType<typeof createEmptyFunnel>;
