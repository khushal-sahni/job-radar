import { EDUCATION, LATEST_JOB } from "./applicant-data";
import { normalizeLabel } from "./fingerprint";
import { matchOption } from "./profile-map";
import type { FieldDescriptor, RecipeAction } from "./types";

export type FormSection = "education" | "employment";

const SECTION_NAMES: Record<FormSection, string> = { education: "Education", employment: "Employment" };
const PREFIX_RE = /^(education|employment) — /i;

/**
 * "Start date month" inside a form's employment block becomes "Employment — Start date month",
 * so the modal says whose dates they are and an education date never answers an employment one.
 */
export function sectionLabel(label: string, section: string | null | undefined): string {
  const name = SECTION_NAMES[section as FormSection];
  if (!name || !label || PREFIX_RE.test(label)) return label;
  if (normalizeLabel(label).split(" ").includes(name.toLowerCase())) return label;
  return `${name} — ${label}`;
}

export function sectionOfLabel(label: string): FormSection | null {
  const m = PREFIX_RE.exec(label);
  return m ? (m[1].toLowerCase() as FormSection) : null;
}

export type BlockPart =
  | "school"
  | "degree"
  | "discipline"
  | "startYear"
  | "endYear"
  | "date"
  | "company"
  | "title"
  | "start"
  | "end"
  | "location"
  | "description";

const DATE_RE = /^(start|end)( date)? (month|year)$|^(start|end) date$/;
const GRADUATION_YEAR_RE =
  /\b(what|which) year did you graduate\b|\bwhen did you graduate\b|\byear of graduation\b|\bgraduation year\b|\byear (you )?graduated\b/;
const HIGHEST_ED_RE =
  /\bhighest (level of )?educat|\beducational level\b|\beducation you have completed\b|\blevel of education\b/;

/**
 * Which fact of an education or employment entry a prefixed label asks for.
 * Graduation year counts in any wording, block or not. Null for everything else (normal path).
 */
export function blockPart(label: string): BlockPart | null {
  const section = sectionOfLabel(label);
  const rest = normalizeLabel(label.replace(PREFIX_RE, ""));
  if (section !== "employment" && GRADUATION_YEAR_RE.test(rest)) return "endYear";
  if (section !== "employment" && HIGHEST_ED_RE.test(rest)) return "degree";
  if (!section) return null;
  if (section === "education") {
    if (/^(school|university|college|institut(e|ion))( name)?$/.test(rest)) return "school";
    if (/^((highest )?degree|degree type|qualification)$/.test(rest)) return "degree";
    if (/^(discipline|major|field of study|speciali[sz]ation|branch)$/.test(rest)) return "discipline";
    if (/^(from|start (date )?year)$/.test(rest)) return "startYear";
    if (/^(end (date )?year|to( actual or expected)?)$/.test(rest)) return "endYear";
  } else {
    if (/^(company|employer|organi[sz]ation)( name)?$/.test(rest)) return "company";
    if (/^(job )?(title|position|role)$/.test(rest)) return "title";
    if (/^(from|start)$/.test(rest)) return "start";
    if (/^(to|end)$/.test(rest)) return "end";
    if (/^(job |work )?location$/.test(rest)) return "location";
    if (/^((role|job) )?(description|responsibilities)$/.test(rest)) return "description";
  }
  return DATE_RE.test(rest) ? "date" : null;
}

/** The latest job's value for an employment line; "" for To while it is the current job. */
export function latestJobValue(label: string): string | null {
  switch (blockPart(label)) {
    case "title":
      return LATEST_JOB.title;
    case "company":
      return LATEST_JOB.company;
    case "start":
      return LATEST_JOB.start;
    case "end":
      return LATEST_JOB.end ?? "";
    case "location":
      return LATEST_JOB.location;
    case "description":
      return LATEST_JOB.description;
    default:
      return null;
  }
}

/** "I currently work here" is ticked only when the latest job has no end date. */
export function isCurrentJob(): boolean {
  return LATEST_JOB.end == null;
}

/** School and discipline lists are search results: an unfiltered read is the first page of a long list. */
export function isSearchCombo(field: Pick<FieldDescriptor, "label" | "control">): boolean {
  if (field.control !== "combobox") return false;
  const part = blockPart(field.label);
  return part === "school" || part === "discipline";
}

/**
 * The first IIT BHU row in a school search result. Two spellings of the same school
 * used to return null and fall through to Other, which Greenhouse then drops.
 * With `allowOther` (the "Other" search), a list without IIT BHU gives its "Other - Not Listed" row.
 */
export function pickSchool(options: string[], allowOther = false): string | null {
  const fits = options.filter((o) => {
    const text = normalizeLabel(o);
    const words = text.split(" ");
    const bhu = words.includes("bhu") || words.includes("banaras") || words.includes("varanasi");
    const iit = words.includes("iit") || /\binstitute of technology\b/.test(text);
    return bhu && iit;
  });
  if (fits.length >= 1) return fits[0];
  const closest = options.filter((o) => /\b(bhu|banaras|varanasi)\b/.test(normalizeLabel(o)));
  if (closest.length >= 1) return closest[0];
  if (!allowOther) return null;
  const other = (re: RegExp) => options.filter((o) => re.test(normalizeLabel(o)));
  const notListed = other(/^other( -)? not listed$/);
  if (notListed.length === 1) return notListed[0];
  const named = other(/^(other|not listed|school not (in the list|listed)|my school is not listed)\b|\bnot listed\b|\bother\b/);
  return named[0] ?? null;
}

/** B.Tech on a degree list: a B.Tech row, else Bachelor of Engineering, else the one bachelor's row. */
export function pickDegree(options: string[]): string | null {
  const tiers = [/\b(b ?tech|bachelor of technology)\b/, /\bbachelor of engineering\b/, /\bbachelor/];
  for (const re of tiers) {
    const hits = options.filter((o) => re.test(normalizeLabel(o)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  const four = options.filter((o) => /\b4 years?\b/.test(normalizeLabel(o)));
  return four.length === 1 ? four[0] : null;
}

/** The pharmaceutical row on a field-of-study list, else (with `allowOther`) its one "Other" row. */
export function pickDiscipline(options: string[], allowOther = true): string | null {
  const fits = options.filter((o) => /\bpharma/.test(normalizeLabel(o)));
  const exact = fits.filter((o) => /\bengineering\b/.test(normalizeLabel(o)));
  if (exact.length === 1) return exact[0];
  if (fits.length === 1) return fits[0];
  if (fits.length > 1 || !allowOther) return null;
  const other = options.filter((o) => /^other( not listed)?$/.test(normalizeLabel(o)));
  return other.length === 1 ? other[0] : null;
}

/** How to type and pick a school, degree or discipline from a search box; null for other fields. */
export function blockSearch(
  label: string,
): { searches: readonly string[]; choose: (query: string, options: string[]) => string | null } | null {
  const part = blockPart(label);
  if (part === "school") {
    return { searches: EDUCATION.schoolSearches, choose: (q, o) => pickSchool(o, q === "Other" || /\bnot listed\b/i.test(q)) };
  }
  if (part === "degree") return { searches: EDUCATION.degreeSearches, choose: (_q, o) => pickDegree(o) };
  if (part === "discipline") return { searches: EDUCATION.disciplineSearches, choose: (q, o) => pickDiscipline(o, q === "Other") };
  return null;
}

/**
 * Fill for a block fact on file (school, degree, years, the latest job's lines); null means ask.
 * Never a model's guess: one wrote "N/A" and a résumé paragraph there. A skip leaves a current job's To empty.
 */
export function blockAction(field: Pick<FieldDescriptor, "label" | "control" | "options">): RecipeAction | null {
  const part = blockPart(field.label);
  const pick = (value: string, chosen: string | null): RecipeAction | null =>
    field.options.length === 0 ? { type: "literal", value } : chosen ? { type: "option", value: chosen } : null;
  if (part === "school") return pick(EDUCATION.school, pickSchool(field.options));
  if (part === "degree") return pick(EDUCATION.degree, pickDegree(field.options));
  if (part === "discipline") return pick(EDUCATION.discipline, pickDiscipline(field.options));
  if (part === "startYear") return pick(EDUCATION.startYear, matchOption(EDUCATION.startYear, field.options));
  if (part === "endYear") return pick(EDUCATION.endYear, matchOption(EDUCATION.endYear, field.options));
  if (part === "date") return blockDate(field);
  const job = latestJobValue(field.label);
  if (job === "") return { type: "skip" };
  return job ? pick(job, matchOption(job, field.options)) : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A month and year ("07", "2018") put into one date control: "MM/YYYY" typed (Workday splits it),
 * or the list's row for the month or the year, matched by name, short name or number.
 */
export function monthYearAction(
  field: Pick<FieldDescriptor, "control" | "options">,
  month: string,
  year: string,
  want: "month" | "year" | "both",
): RecipeAction | null {
  const m = Number(month);
  if (!(m >= 1 && m <= 12) || !/^\d{4}$/.test(year)) return null;
  const name = MONTHS[m - 1];
  if (field.options.length === 0) {
    if (want === "month") return { type: "literal", value: field.control === "combobox" ? name : String(m).padStart(2, "0") };
    if (want === "year") return { type: "literal", value: year };
    return { type: "literal", value: `${String(m).padStart(2, "0")}/${year}` };
  }
  const tries =
    want === "year"
      ? [year]
      : want === "month"
        ? [name, name.slice(0, 3), String(m).padStart(2, "0"), String(m)]
        : [`${name} ${year}`, `${name.slice(0, 3)} ${year}`, `${String(m).padStart(2, "0")}/${year}`];
  for (const t of tries) {
    const hit = field.options.find((o) => normalizeLabel(o) === normalizeLabel(t));
    if (hit) return { type: "option", value: hit };
  }
  return null;
}

/** An education or employment block's start or end month and year: on file, or null. */
function blockDate(field: Pick<FieldDescriptor, "label" | "control" | "options">): RecipeAction | null {
  const rest = normalizeLabel(field.label.replace(PREFIX_RE, ""));
  const m = /^(start|end)( date)?( (month|year))?$/.exec(rest);
  if (!m) return null;
  const end = m[1] === "end";
  const want = (m[4] as "month" | "year" | undefined) ?? "both";
  if (sectionOfLabel(field.label) === "education") {
    return end
      ? monthYearAction(field, EDUCATION.endMonth, EDUCATION.endYear, want)
      : monthYearAction(field, EDUCATION.startMonth, EDUCATION.startYear, want);
  }
  const when = end ? LATEST_JOB.end : LATEST_JOB.start;
  if (when == null) return { type: "skip" };
  const [month, year] = when.split("/");
  return monthYearAction(field, month, year, want);
}

/** Why the job parks when the form's year list has no 2022; null when the year can be given. */
export function graduationYearMismatch(field: Pick<FieldDescriptor, "label" | "options">): string | null {
  if (blockPart(field.label) !== "endYear" || field.options.length === 0) return null;
  if (matchOption(EDUCATION.endYear, field.options)) return null;
  return `Graduated in ${EDUCATION.endYear}; this form only offers ${field.options.slice(0, 6).join(", ")}`;
}
