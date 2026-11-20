import { completeJson, isOutOfCredits } from "@/lib/openrouter";
import { BACKGROUND_FACTS, EDUCATION } from "./applicant-data";
import { factLines, isExclusiveOption, namesUnusedSkill, type FactSheet } from "./facts";
import { normalizeLabel } from "./fingerprint";
import { identityProblem } from "./identity";
import type { FillSource } from "./resolve";
import type { FieldDescriptor, ProfileValues, RecipeAction } from "./types";

/** What we meant to put in one control, kept to check against what the page shows. */
export interface FillIntent {
  field: FieldDescriptor;
  action: RecipeAction;
  source: FillSource;
  /** Fact ids the answer rests on. */
  grounds: string[];
}

/** One control as the page shows it right before submit. */
export interface Readback {
  id: string;
  label: string;
  value: string;
  control: FieldDescriptor["control"];
  options: string[];
  freeText: boolean;
  checked: string[] | null;
}

const PARAGRAPH_CHARS = 160;

const CITY_ALIASES: string[][] = [
  ["gurgaon", "gurugram"],
  ["bangalore", "bengaluru"],
  ["bombay", "mumbai"],
];

function same(a: string, b: string): boolean {
  return normalizeLabel(a) === normalizeLabel(b);
}

/** The calendar days a date string can mean: ISO is exact, "10/18/2026" or "18.10.2026" may be either order. */
function calendarDays(s: string): string[] {
  const t = s.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return [`${iso[1]}-${+iso[2]}-${+iso[3]}`];
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (!local) return [];
  return [`${local[3]}-${+local[1]}-${+local[2]}`, `${local[3]}-${+local[2]}-${+local[1]}`];
}

function foldedCity(s: string): string {
  let t = normalizeLabel(s);
  for (const group of CITY_ALIASES) {
    const canon = group[1];
    for (const n of group) t = t.replace(new RegExp(`\\b${n}\\b`, "g"), canon);
  }
  return t;
}

/** "Gurgaon, Haryana, India" is the same place as "Gurugram, India". */
function samePlace(shown: string, wanted: string): boolean {
  const tokens = (s: string) => foldedCity(s).split(/[,\s/]+/).filter((w) => w.length > 1);
  const shownT = new Set(tokens(shown));
  const wantedT = tokens(wanted);
  return wantedT.length > 0 && wantedT.every((w) => shownT.has(w));
}

/** Typed text as the form keeps it: cut at its limit, a phone number reformatted, or a date in the form's format. */
export function sameText(shown: string, wanted: string): boolean {
  const a = normalizeLabel(shown);
  const b = normalizeLabel(wanted);
  if (a === b || (a.length >= 20 && b.startsWith(a))) return true;
  if (samePlace(shown, wanted) || samePlace(wanted, shown)) return true;
  const want = calendarDays(wanted);
  if (want.length === 1 && calendarDays(shown).includes(want[0])) return true;
  const digits = (s: string) => s.replace(/\D/g, "");
  return digits(wanted).length >= 7 && digits(shown).endsWith(digits(wanted).slice(-10));
}

function setEquals(a: string[], b: string[]): boolean {
  const x = new Set(a.map(normalizeLabel));
  const y = new Set(b.map(normalizeLabel));
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function short(label: string): string {
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

/** The page shows something other than what was chosen for this control. */
function readbackProblem(intent: FillIntent, shown: Readback, profile: ProfileValues): string | null {
  const { action, field } = intent;
  const label = short(field.label);
  switch (action.type) {
    case "options":
      if (shown.checked && !setEquals(shown.checked, action.values)) {
        return `"${label}" shows ${shown.checked.join(", ") || "nothing"} instead of ${action.values.join(", ")}`;
      }
      return null;
    case "option":
      if (shown.checked) {
        return shown.checked.length === 1 && same(shown.checked[0], action.value) ? null : `"${label}" is not set to ${action.value}`;
      }
      if (!shown.value) return `"${label}" is empty after filling`;
      // Dropdowns may display a longer or shorter form of the pick ("India" vs "India (+91)").
      const shownN = normalizeLabel(shown.value);
      const wantN = normalizeLabel(action.value);
      return shownN.includes(wantN) || wantN.includes(shownN) || samePlace(shown.value, action.value) || samePlace(action.value, shown.value)
        ? null
        : `"${label}" shows "${shown.value.slice(0, 40)}" instead of "${action.value.slice(0, 40)}"`;
    case "literal":
    case "compose":
    case "profile": {
      if (!shown.value) return `"${label}" is empty after filling`;
      if (field.control === "combobox") return null;
      const wanted = action.type === "profile" ? profile[action.key] : action.type === "literal" ? action.value : action.text;
      return wanted && !sameText(shown.value, wanted) ? `"${label}" shows different text than was typed` : null;
    }
    case "skip":
      return null;
  }
}

/**
 * Deterministic checks on the page right before submit. Every problem is a reason to park:
 * a wrong answer sent is worse than an application not sent.
 */
export function auditPage(input: {
  intents: Map<string, FillIntent>;
  shown: Readback[];
  facts: FactSheet;
  profile: ProfileValues;
}): string[] {
  const problems: string[] = [];
  const byId = new Map(input.shown.map((s) => [s.id, s]));

  for (const [id, intent] of input.intents) {
    const shown = byId.get(id);
    if (!shown) continue;
    const p = readbackProblem(intent, shown, input.profile);
    if (p) problems.push(p);
    if ((intent.source === "cheap_model" || intent.source === "strong_model") && intent.action.type !== "compose") {
      problems.push(`"${short(intent.field.label)}" was answered by a model without a fact`);
    }
    if (intent.action.type === "compose" && intent.source !== "recipe" && intent.grounds.length === 0) {
      problems.push(`"${short(intent.field.label)}" has a written answer that cites no facts`);
    }
  }

  for (const s of input.shown) {
    const label = short(s.label || "(no label)");
    const identity = identityProblem(s, s.checked?.join(", ") || s.value, input.profile.country);
    if (identity) problems.push(identity);
    if (s.control === "checkbox" && s.checked && s.checked.length > 1) {
      if (s.checked.some(isExclusiveOption)) problems.push(`"${label}" has "None" ticked together with other choices`);
      const real = s.options.filter((o) => o.trim());
      if (real.length >= 3 && s.checked.length === real.length) {
        const intent = input.intents.get(s.id);
        const fact = intent?.grounds.map((g) => input.facts.byId.get(g)).find((f) => f?.type === "list" && f.complete);
        if (!fact) problems.push(`"${label}" has every choice ticked without a complete list behind it`);
      }
    }
    if (s.control === "text" && !s.freeText && s.value.length > PARAGRAPH_CHARS) {
      problems.push(`"${label}" is a short field holding a paragraph`);
    }
  }
  return problems;
}

const CONTRADICTION_PROMPT = `You review a job application right before it is sent, for a real applicant.
Given the applicant facts and every question with its answer, list answers that contradict each other or the facts
(for example "0 years of Python" next to "Yes, I use Python professionally", or a claimed tool the facts say was never used).
Missing facts are not contradictions. Wording and style are not your concern.
These are never contradictions:
- one city under two names (Gurgaon = Gurugram, Bangalore = Bengaluru, Bombay = Mumbai), or a city vs. its fuller address;
- one phone number written in different formats (with or without 0, +91, spaces);
- visa, sponsorship and right-to-work answers: they depend on the job's country (given as "job"), so needing sponsorship for a job abroad does not contradict not needing it at home or in another country;
- years in one skill or tool next to total years: skills are used at the same time, so several skills may each have as many years as the whole career. Only years in one skill above the total contradict;
- 0 years in one specialty next to total years: the applicant simply never did that specialty;
- a notice period of 0 days (immediate) next to a choice such as "15 days or less", "Immediate" or "can you join in 15 days? Yes": that choice covers it;
- declining a self-identification question (ethnicity, race, gender, veteran, disability) next to a fact on file, or pronouns next to gender;
- a yes to working from or relocating to another city, or to a contract, shift, travel, fast-paced or "whatever it takes" role: that is willingness, and the applicant is open to it;
- a figure stated without its currency or unit: missing detail is not a contradiction;
- any date on or before "today" (given in the input) is in the past, not the future; a start date a week or more after today is the applicant's availability;
- "N/A" or "None" as current company next to a past job (the latest job has an end date);
- salary figures in different currencies or for different countries: each is the expectation for that country;
- "Other" picked from a location list that does not name the applicant's city;
- a written answer that cites a project, company or result named in the facts, including background facts.
Reply with JSON only: {"problems":["<short description>", ...]} and an empty list when nothing contradicts.`;

const WORK_AUTH_RE = /\b(visa|sponsor\w*|work (permit|authori[sz]ation)|right to work|(legally )?authori[sz]ed to work|legally (able|allowed|authori[sz]ed))\b/i;
const START_DATE_RE = /\bstart(ing)? date\b|\bavailab(le|ility)\b/i;
const WEEK_OUT_RE = /\b(one|a|1) week\b|\b7 days\b/i;
const PHONE_RE = /\bphone\b/i;
const NOTICE_RE = /\bnotice\b/i;
const NOTICE_BUCKET_RE = /\b(or less|less than|within|immediate(ly)?|up ?to)\b/i;
const YEARS_RE = /\byears?\b/i;
const TOTAL_YEARS_RE = /\b(total|overall|whole career|professional (software )?experience)\b/i;
const SUMMED_YEARS_RE =
  /\b(each|simultaneous\w*|at the same time|concurrent\w*|mathematically|impossible|improbable|unlikely|add(s|ed)? up|sum|combined|cumulative|every (single )?one|entire(ty)?|whole|separate|all of (these|them)|since the (very )?(first day|beginning))\b/i;
const NOT_A_PROBLEM_RE =
  /\b(not a (direct )?contradiction|worth noting|technically possible|not necessarily|consistent with|do(es)? not contradict|no contradiction|not contradictory|valid (amount|answer|value)|(which|this|that) is (fine|acceptable|ok)|is not specified|not specified|unspecified|ambiguous)\b/i;
/** Declining a self-ID question, or pronouns next to gender, never conflicts with a fact on file. */
const DEMOGRAPHIC_RE = /\b(ethnicit\w*|race|racial|gender|pronouns?|veteran|disabilit\w*|sexual orientation|lgbt\w*)\b/i;
const DECLINE_RE = /\b(prefer not|decline[ds]?|not to (answer|say|disclose|self-identify)|do not wish|don'?t wish)\b/i;
const PRONOUN_RE = /\b(he\/him|she\/her|they\/them|pronouns?)\b/i;
/** Notice 0 (immediate) fits every "join in N days" question. */
const NOTICE_ZERO_RE = /\b(0|zero) days?\b|\bnotice (period )?(is |of )?(0|zero|none|immediate)\b|\bimmediate(ly)?\b/i;
/** A yes to working somewhere else or taking a role on its terms is willingness, not a conflict with the present. */
const WILLING_RE = /\b(comfortable|willing|open|ready|happy|ok(ay)?) (to|with|for|working|joining|relocating|moving)\b/i;
const ELSEWHERE_RE = /\b(work(ing)? (from|in|at)|relocat\w*|mov(e|ing) to|based in|office)\b/i;
const TERMS_RE = /\b(contract(ual)?|whatever it takes|fast[- ]paced|shifts?|weekends?|on-?call|hybrid|onsite|on-site|travel)\b/i;
const YEAR_FIGURE_RE = /\b(\d+(?:\.\d+)?)\+? (?:years?|yrs)\b|(?:experience|years):\s*(\d+(?:\.\d+)?)/gi;
const EXCEEDS_RE = /\b(exceed\w*|more than|greater than|longer than|above)\b/i;
/** "0 years in system operations" next to the career total: a specialty never worked in, not a conflict. */
const ZERO_YEARS_RE = /\b0 (years?|yrs)\b/i;
const CLAIMS_USE_RE = /\b(yes|professionally|uses?|used|using)\b/i;
const FUTURE_DATE_RE = /\bfuture\b/i;
const CURRENT_COMPANY_RE = /\bcurrent (company|employer)\b/i;
const NA_RE = /['"\s(]n\/?a['"\s),.]|\bnone\b/i;
const START_NOW_RE = /\b(available to start|start(ing)? immediately|immediate(ly)? (start|available)?)\b/i;
const OWN_JOB_RE = /\b(current job|current employer|started)\b/i;
const CURRENCY_RE = /\b(inr|eur|euros?|usd|jpy|yen|lpa)\b|[€₹¥$]/gi;
const LOCATION_OTHER_RE = /\blocation\b.*\bother\b|\bother\b.*\blocation\b/i;
const RELOCATE_RE = /\b(open to relocat\w*|willing to relocat\w*|relocat\w*)\b/i;
const HEARD_RE = /\b(heard?|hear) about\b/i;
const FACT_ID_RE = /\bf\d+\b/g;
/** "4 years of experience in Azure Ai Foundry … 0 years of experience in Azure Ai Foundry": two facts read as one. */
const SAME_SKILL_TWICE_RE = /\b\d+ years? of experience (?:in|with) ([\w .+#-]{2,40}?)\b.*\b\d+ years? of experience (?:in|with) \1\b/i;
/** Side projects named in the background facts ("Built Vivaahli …", "AniReco: …"). */
const PROJECTS = BACKGROUND_FACTS.map((f) => /^built (\w+)/i.exec(f)?.[1] ?? /^([\w ]{3,30}) \(personal project\b/i.exec(f)?.[1] ?? /^([\w ]{3,30}):/.exec(f)?.[1])
  .filter((n): n is string => Boolean(n) && !/^portfolio$/i.test(n!))
  .map((n) => n.toLowerCase());
const BACKGROUND_NUMBERS = new Set(BACKGROUND_FACTS.join(" ").match(/\d+(\.\d+)?/g) ?? []);
const OTHER_CITY_RE = /\b(berlin|munich|tokyo|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|delhi|noida|london|paris|warsaw|orai)\b/i;

/**
 * Problems the model still reports against the rules in the prompt. Visa answers come from the job's
 * country (`work-auth.ts`), and phone numbers from the profile, so neither can contradict the facts.
 */
export function isFalseContradiction(problem: string): boolean {
  const p = problem.toLowerCase();
  if (CITY_ALIASES.some((names) => names.filter((n) => p.includes(n)).length >= 2)) return true;
  // Skill years overlap: N years in each of several tools fits inside N years total.
  if (YEARS_RE.test(problem) && TOTAL_YEARS_RE.test(problem) && SUMMED_YEARS_RE.test(problem)) return true;
  // Notice 0 fits any "N days or less" / "Immediate" choice.
  if (NOTICE_RE.test(problem) && NOTICE_BUCKET_RE.test(problem)) return true;
  if (NOT_A_PROBLEM_RE.test(problem)) return true;
  if (DEMOGRAPHIC_RE.test(problem) && (DECLINE_RE.test(problem) || PRONOUN_RE.test(problem))) return true;
  if (NOTICE_RE.test(problem) && NOTICE_ZERO_RE.test(problem)) return true;
  if (WILLING_RE.test(problem) && (ELSEWHERE_RE.test(problem) || TERMS_RE.test(problem))) return true;
  // Only years above the total conflict; the same figure for a skill and the career fits.
  const yearFigures = [...problem.matchAll(YEAR_FIGURE_RE)].map((m) => Number(m[1] ?? m[2]));
  if (yearFigures.length >= 2 && new Set(yearFigures).size === 1) return true;
  const colonYears = [...problem.matchAll(/(?:experience|years):\s*(\d+(?:\.\d+)?)/gi)].map((m) => Number(m[1]));
  const writtenYears = [...problem.matchAll(/\b(\d+(?:\.\d+)?)\+? (?:years?|yrs)\b/gi)].map((m) => Number(m[1]));
  if (colonYears.length > 0 && new Set(colonYears).size === 1 && writtenYears.every((n) => n === colonYears[0])) return true;
  if (EXCEEDS_RE.test(problem) && TOTAL_YEARS_RE.test(problem) && new Set(yearFigures).size === 1) return true;
  if (ZERO_YEARS_RE.test(problem) && TOTAL_YEARS_RE.test(problem) && !CLAIMS_USE_RE.test(problem)) return true;
  // .NET is 0 years / No by rule next to any career total.
  if (namesUnusedSkill(problem) && (ZERO_YEARS_RE.test(problem) || /:\s*(0|no)\b/i.test(problem)) && !/:\s*yes\b/i.test(problem)) return true;
  // Résumé dates are past; the model's own sense of today is not.
  if (FUTURE_DATE_RE.test(problem)) return true;
  // The latest job has ended, so the current company is none.
  if (CURRENT_COMPANY_RE.test(problem) && NA_RE.test(problem)) return true;
  // Leftover job-search status from another form vs the ended latest job.
  if (/\bunemployed\b/i.test(problem) && /\b(job search|転職|considering changing jobs|いいところがあれば)\b/i.test(problem)) return true;
  // The GitHub URL box is not the answer to the AI-tools months question.
  if (/\b6 months of experience using AI-assisted\b/i.test(problem) && /\b(url|github profile)\b/i.test(problem)) return true;
  // A leftover Japanese/Chinese flag on an English form.
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(problem)) return true;
  if (START_NOW_RE.test(problem) && OWN_JOB_RE.test(problem)) return true;
  // Each country's salary is its own expectation.
  if (new Set((problem.match(CURRENCY_RE) ?? []).map((c) => c.toLowerCase().replace(/^(euros?|€)$/, "eur"))).size >= 2) return true;
  if (LOCATION_OTHER_RE.test(problem)) return true;
  if (RELOCATE_RE.test(problem) && /\b(based in|location|located|live|reside)\b/i.test(problem)) return true;
  if (HEARD_RE.test(problem)) return true;
  // The start date is a week out by rule; the model's date arithmetic is not.
  if (START_DATE_RE.test(problem) && WEEK_OUT_RE.test(problem)) return true;
  // Education block years are the degree's, not the career's.
  if (YEARS_RE.test(problem) && TOTAL_YEARS_RE.test(problem) && [EDUCATION.startYear, EDUCATION.endYear].some((y) => problem.includes(y))) {
    return true;
  }
  // One fact cited against itself: the model mixed up two facts (Azure vs Azure AI Foundry).
  const ids = problem.match(FACT_ID_RE) ?? [];
  if (ids.length >= 2 && new Set(ids).size === 1) return true;
  // The same rupee figure written twice is not a contradiction.
  const money = [...problem.matchAll(/\d[\d,]{5,}/g)].map((m) => m[0].replace(/,/g, ""));
  if (money.length >= 2 && money.every((n) => n === money[0])) return true;
  if (SAME_SKILL_TWICE_RE.test(problem)) return true;
  // An office answer is for this job's place; the office another job was applied to does not bind it.
  if (/\bwhich office\b/i.test(problem)) return true;
  // A written answer about a side project on file, every figure in it on file too.
  const figures = problem.replace(FACT_ID_RE, "").match(/\d+(\.\d+)?/g) ?? [];
  if (PROJECTS.some((name) => p.includes(name)) && figures.every((n) => BACKGROUND_NUMBERS.has(n))) {
    return true;
  }
  const home = (p.match(/\b(gurugram|gurgaon)\b/g) ?? []).length;
  if (home >= 2 && !OTHER_CITY_RE.test(problem)) return true;
  // The form's strongest English row vs a Native/bilingual fact is the same claim.
  if (/\benglish\b/i.test(problem) && /\b(proficien\w*|native|bilingual|fluent|toeic)\b/i.test(problem) && !/\b(none|no proficiency|cannot|beginner)\b/i.test(problem)) {
    return true;
  }
  return WORK_AUTH_RE.test(problem) || PHONE_RE.test(problem);
}

const UNASKED_STOP = new Set([
  "the",
  "applicant",
  "states",
  "claims",
  "years",
  "year",
  "experience",
  "professional",
  "software",
  "but",
  "also",
  "and",
  "that",
  "their",
  "they",
  "have",
  "has",
  "with",
  "from",
  "this",
  "for",
  "are",
  "was",
  "were",
  "not",
  "answer",
  "answers",
  "question",
  "fact",
  "facts",
  "applications",
  "application",
  "systems",
  "tools",
]);

/** True when the model cited a topic that never appeared on this form (leftover facts from another job). */
export function contradictionAboutUnaskedTopic(
  problem: string,
  answers: Array<{ label: string; value: string }>,
): boolean {
  const blob = answers.map((a) => `${a.label} ${a.value}`).join(" ").toLowerCase();
  if (!blob.trim()) return false;
  const claim = /(?:experience in|years of(?: professional)?(?: experience)?(?: in)?)\s+([^.;,]+)/i.exec(problem);
  if (!claim) return false;
  const words = normalizeLabel(claim[1]).split(" ").filter((w) => w.length >= 3 && !UNASKED_STOP.has(w));
  return words.length > 0 && words.every((w) => !blob.includes(w));
}

/** One cheap call over the whole form. Null when the check could not run. */
export async function findContradictions(
  answers: Array<{ label: string; value: string }>,
  facts: FactSheet,
  job?: { country?: string | null; location?: string | null },
): Promise<string[] | null> {
  const filled = answers.filter((a) => a.value.trim());
  const { getOpenRouterApiKey } = await import("@/lib/secrets");
  if (filled.length < 2 || !getOpenRouterApiKey()) return [];
  const prompt = JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    job: { country: job?.country ?? null, location: job?.location ?? null },
    // An office picked for one job ("Berlin") is not where the applicant is for the next one.
    facts: factLines(facts.facts.filter((f) => !f.key.startsWith("office."))),
    answers: filled.map((a) => ({ question: a.label.slice(0, 200), answer: a.value.slice(0, 300) })),
  });
  for (const tier of ["cheap", "strong"] as const) {
    try {
      const res = await completeJson<{ problems?: unknown }>({ tier, system: CONTRADICTION_PROMPT, prompt, maxTokens: 300 });
      if (Array.isArray(res.data?.problems)) {
        return res.data.problems
          .map((p) => String(p))
          .filter((p) => p && !isFalseContradiction(p) && !contradictionAboutUnaskedTopic(p, filled));
      }
    } catch (err) {
      // Out of credits must stop the run; letting the check fail open would submit forms unchecked.
      if (isOutOfCredits(err)) throw err;
    }
  }
  return null;
}
