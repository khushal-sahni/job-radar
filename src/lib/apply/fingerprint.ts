import { createHash } from "node:crypto";
import type { ApplyVendor, FieldControl } from "./types";

const COMPANY_PROMPT_RE =
  /\bwhy\b[^?]*\b(us|join|company|here|this role|this position|our team|work at|work with)\b|\binterest(ed)? in (us|our|this company|working (at|for|with))\b/i;

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\*/g, " ")
    .replace(/\(required\)|\(optional\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOptions(options: string[]): string {
  return options
    .map((o) => normalizeLabel(o))
    .filter((o) => o && o !== "select" && o !== "select one" && o !== "please select")
    .sort()
    .join("|");
}

function companyKey(company: string): string {
  return normalizeLabel(company).replace(/\s+/g, "-");
}

/** True when the answer depends on which company is asking ("Why Acme?"). */
export function isCompanySpecific(label: string, company: string): boolean {
  if (COMPANY_PROMPT_RE.test(label)) return true;
  const name = normalizeLabel(company);
  return name.length >= 3 && normalizeLabel(label).includes(name);
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 20);
}

export interface FieldKeys {
  /** Vendor-scoped key; recipes are written under this. */
  fingerprint: string;
  /** Same question on any vendor; used as a fallback lookup. */
  genericKey: string;
}

export function fieldKeys(input: {
  vendor: ApplyVendor;
  control: FieldControl;
  label: string;
  options: string[];
  company: string;
}): FieldKeys {
  const scope = isCompanySpecific(input.label, input.company)
    ? companyKey(input.company)
    : "";
  const body = [
    input.control,
    normalizeLabel(input.label),
    normalizeOptions(input.options),
    scope,
  ].join("\u0001");
  return {
    fingerprint: hash(`${input.vendor}\u0001${body}`),
    genericKey: hash(body),
  };
}
