import { DEFAULT_RULES, type RuleBranch } from "@/lib/types";

export interface RuleBranchForm {
  id: string;
  enabled: boolean;
  title: string;
  description: string;
  /** Display units for the salary floor input. */
  salaryUnit: "LPA" | "EUR" | "JPY";
  /** Value shown in the input (LPA for INR branches). */
  salaryValue: number;
  visaRequired: boolean;
  showVisa: boolean;
}

const BRANCH_META: Record<
  string,
  { title: string; description: string; salaryUnit: "LPA" | "EUR" | "JPY"; showVisa: boolean }
> = {
  "remote-india": {
    title: "Remote from India",
    description: "Remote roles you can do from India.",
    salaryUnit: "LPA",
    showVisa: false,
  },
  "india-onsite": {
    title: "India onsite",
    description: "Non-remote India roles. Floor is base pay, not CTC.",
    salaryUnit: "LPA",
    showVisa: false,
  },
  germany: {
    title: "Germany",
    description: "Roles in Germany with listed pay.",
    salaryUnit: "EUR",
    showVisa: true,
  },
  japan: {
    title: "Japan",
    description: "Roles in Japan with listed pay.",
    salaryUnit: "JPY",
    showVisa: true,
  },
};

function salaryFromBranch(branch: RuleBranch): number {
  if (branch.minSalaryINR != null) return Math.round(branch.minSalaryINR / 100_000);
  if (branch.minBaseINR != null) return Math.round(branch.minBaseINR / 100_000);
  if (branch.minSalaryEUR != null) return branch.minSalaryEUR;
  if (branch.minSalaryJPY != null) return branch.minSalaryJPY;
  return 0;
}

function defaultBranch(id: string): RuleBranch {
  return DEFAULT_RULES.find((r) => r.id === id) ?? { id };
}

/** Build editable cards from saved rules (missing ids are off). */
export function rulesToForm(rules: RuleBranch[]): RuleBranchForm[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  return Object.keys(BRANCH_META).map((id) => {
    const meta = BRANCH_META[id];
    const saved = byId.get(id);
    const source = saved ?? defaultBranch(id);
    return {
      id,
      enabled: Boolean(saved),
      title: meta.title,
      description: meta.description,
      salaryUnit: meta.salaryUnit,
      salaryValue: salaryFromBranch(source),
      visaRequired: source.visaSponsorship === true,
      showVisa: meta.showVisa,
    };
  });
}

export function formToRules(form: RuleBranchForm[]): RuleBranch[] {
  const out: RuleBranch[] = [];
  for (const card of form) {
    if (!card.enabled) continue;
    const base = defaultBranch(card.id);
    const next: RuleBranch = { ...base, id: card.id };

    if (card.id === "remote-india") {
      next.minSalaryINR = Math.round(card.salaryValue * 100_000);
      delete next.minBaseINR;
      delete next.minSalaryEUR;
      delete next.minSalaryJPY;
    } else if (card.id === "india-onsite") {
      next.minBaseINR = Math.round(card.salaryValue * 100_000);
      delete next.minSalaryINR;
      delete next.minSalaryEUR;
      delete next.minSalaryJPY;
    } else if (card.id === "germany") {
      next.minSalaryEUR = Math.round(card.salaryValue);
      delete next.minSalaryINR;
      delete next.minBaseINR;
      delete next.minSalaryJPY;
      next.visaSponsorship = card.visaRequired;
    } else if (card.id === "japan") {
      next.minSalaryJPY = Math.round(card.salaryValue);
      delete next.minSalaryINR;
      delete next.minBaseINR;
      delete next.minSalaryEUR;
      next.visaSponsorship = card.visaRequired;
    }

    out.push(next);
  }
  return out;
}

export function ruleBranchLabel(branch: RuleBranch): string {
  const meta = BRANCH_META[branch.id];
  const title = meta?.title ?? branch.id;
  const salary = salaryFromBranch(branch);
  if (branch.minSalaryINR != null) return `${title} · ≥${salary} LPA`;
  if (branch.minBaseINR != null) return `${title} · ≥${salary} LPA base`;
  if (branch.minSalaryEUR != null) {
    const visa = branch.visaSponsorship ? " + visa" : "";
    return `${title} · ≥€${salary.toLocaleString("en-US")}${visa}`;
  }
  if (branch.minSalaryJPY != null) {
    const visa = branch.visaSponsorship ? " + visa" : "";
    return `${title} · ≥¥${salary.toLocaleString("en-US")}${visa}`;
  }
  return title;
}

export function updateRuleLabels(rules: RuleBranch[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const rule of rules) {
    labels[rule.id] = ruleBranchLabel(rule);
  }
  return labels;
}
