import { BACKGROUND_FACTS, EDUCATION } from "./applicant-data";
import { normalizeLabel } from "./fingerprint";
import { matchOption } from "./profile-map";
import type {
  Classification,
  FactType,
  FactValue,
  FieldDescriptor,
  ProfileKey,
  ProfileValues,
  RecipeAction,
} from "./types";

export type FactSource = "resume" | "user" | "settings" | "profile";

export interface Fact {
  /** Short id answers cite ("f12"). Stable within one run only. */
  id: string;
  key: string;
  question: string;
  type: FactType;
  value: FactValue;
  /** Lists only: nothing outside the list applies. An open list says nothing about missing items. */
  complete: boolean;
  source: FactSource;
  evidence: string | null;
}

export interface FactSheet {
  facts: Fact[];
  byKey: Map<string, Fact>;
  byId: Map<string, Fact>;
}

/** A row of the ApplicantFact table, as stored. */
export interface StoredFact {
  key: string;
  question: string;
  type: string;
  value: unknown;
  complete: boolean;
  source: string;
  evidence: string | null;
}

const FACT_TYPES: readonly FactType[] = ["boolean", "text", "number", "list"];

export function isFactType(value: unknown): value is FactType {
  return typeof value === "string" && (FACT_TYPES as readonly string[]).includes(value);
}

export function isFactKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^[a-z0-9_]+(\.[a-z0-9_]+){1,3}$/.test(value);
}

/** A stored value coerced to its type, or null when it does not fit. */
export function coerceFactValue(type: FactType, value: unknown): FactValue | null {
  switch (type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return yesNoText(value);
      return null;
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^\d.]/g, ""));
      return Number.isFinite(n) && String(value ?? "").trim() !== "" ? n : null;
    }
    case "list": {
      const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n|,/) : [];
      return [...new Set(items.map((v) => String(v).trim()).filter(Boolean))];
    }
    case "text": {
      const s = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
      return s ? s : null;
    }
  }
}

// ---------- Items (skills, providers, tools) ----------

const ITEM_ALIASES: Record<string, string> = {
  node: "nodejs",
  golang: "go",
  js: "javascript",
  ts: "typescript",
  postgres: "postgresql",
  amazonwebservices: "aws",
  amazonwebservicesaws: "aws",
  claude: "anthropic",
  gpt: "openai",
  chatgpt: "openai",
  metallama: "llama",
  k8s: "kubernetes",
  googlecloud: "gcp",
  googlecloudplatform: "gcp",
  elasticsearch: "elk",
};

export function itemKey(text: string): string {
  const k = text.toLowerCase().replace(/[^a-z0-9+#]/g, "");
  return ITEM_ALIASES[k] ?? k;
}

/** "Python" fits "Python 3" and "Amazon Web Services (AWS)" fits "AWS", but "Java" never fits "JavaScript". */
export function itemMatches(item: string, option: string): boolean {
  const a = itemKey(item);
  if (!a) return false;
  if (a === itemKey(option)) return true;
  const tokens = option.split(/[\s()/,]+/).filter(Boolean).map(itemKey);
  return tokens.length <= 4 && tokens.includes(a);
}

/**
 * Skills never used, the only ones answered with 0 years and "not used at work". Every other skill
 * gets the career's total years: anything even slightly used counts.
 */
const UNUSED_SKILL_RE = /^(dotnet|net|netcore|netframework|csharp|c#|aspnet\w*|vbnet|ruby|rubyonrails|rails|java)$/;
/** The same skills as they are written in a form's label. */
const UNUSED_SKILL_LABEL_RE =
  /(^|[^a-z0-9])(\.net|dot ?net|c#|c sharp|asp\.net|vb\.net|ruby on rails|\bruby\b|\brails\b|\bjava\b(?!script))(?![a-z0-9])/i;

/** `name` is a skill key part ("dotnet", "sap_applications") or a tool name (".NET"). */
export function isUnusedSkill(name: string): boolean {
  return UNUSED_SKILL_RE.test(itemKey(name.replace(/_/g, " ")));
}

export function namesUnusedSkill(label: string): boolean {
  return UNUSED_SKILL_LABEL_RE.test(label);
}

/** Years answered for any skill: 0 for an unused one, else the total years (4 when none is set). */
export function skillYears(name: string, totalYears: number): number {
  if (isUnusedSkill(name)) return 0;
  return totalYears > 0 ? totalYears : DEFAULT_SKILL_YEARS;
}

export const DEFAULT_SKILL_YEARS = 4;

const SKILL_FACT_RE = /^skill\.([a-z0-9_]+)\.(professional|years)$/;

/** Tool names the resume can state on its own. Case-sensitive where the word is also English ("Go"). */
const RESUME_TOOLS: Array<[string, RegExp]> = [
  ["TypeScript", /\btypescript\b/i],
  ["JavaScript", /\bjavascript\b/i],
  ["Python", /\bpython\b/i],
  // "Go" only as a list entry ("TypeScript, Go, SQL"); "Go live" is English.
  ["Go", /\bGolang\b|(?:^|[,(/|•·])\s*Go\s*(?=[,)/|•·]|$)/m],
  ["Java", /\bjava\b(?!script)/i],
  ["Rust", /\bRust\b/],
  ["Kotlin", /\bkotlin\b/i],
  ["C++", /C\+\+/],
  ["Node.js", /\bnode\.?js\b/i],
  ["React", /\breact(\.js)?\b/i],
  ["Next.js", /\bnext\.js\b/i],
  ["PostgreSQL", /\bpostgres(ql)?\b/i],
  ["MySQL", /\bmysql\b/i],
  ["SQL", /\bSQL\b/],
  ["MongoDB", /\bmongodb\b/i],
  ["Redis", /\bredis\b/i],
  ["Kafka", /\bkafka\b/i],
  ["AWS", /\bAWS\b|amazon web services/i],
  ["GCP", /\bGCP\b|google cloud/i],
  ["Azure", /\bazure\b/i],
  ["Kubernetes", /\bkubernetes\b|\bk8s\b/i],
  ["Docker", /\bdocker\b/i],
  ["GraphQL", /\bgraphql\b/i],
  ["Twilio", /\btwilio\b/i],
  ["ELK", /\bELK\b|elasticsearch/i],
  ["Grafana", /\bgrafana\b/i],
  ["FAISS", /\bFAISS\b/],
  ["OpenAI", /\bopenai\b/i],
  ["Anthropic", /\banthropic\b|\bclaude\b/i],
  ["LangChain", /\blangchain\b/i],
];

function snippet(text: string, index: number): string {
  return text.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, " ").trim();
}

/** Tools the resume names, each with the words around it as evidence. */
export function resumeTools(resumeText: string): Array<{ name: string; evidence: string }> {
  const out: Array<{ name: string; evidence: string }> = [];
  for (const [name, re] of RESUME_TOOLS) {
    const m = re.exec(resumeText);
    if (m) out.push({ name, evidence: `Resume: "${snippet(resumeText, m.index)}"` });
  }
  return out;
}

// ---------- The fact sheet ----------

const PROFILE_FACTS: Array<[ProfileKey, string]> = [
  ["fullName", "Full name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["location", "Where you live"],
  ["city", "City you live in"],
  ["country", "Country you live in"],
  ["linkedInUrl", "LinkedIn profile"],
  ["githubUrl", "GitHub profile"],
  ["portfolioUrl", "Portfolio or website"],
  ["currentCompany", "Current employer"],
  ["noticePeriod", "Notice period"],
  ["expectedCtc", "Expected salary in India"],
];

type Draft = Omit<Fact, "id">;

/**
 * Everything known about the applicant, each with a short id. Stored facts (your answers and
 * resume extraction) win over the same key derived here from the profile or resume text.
 */
export function buildFactSheet(input: { profile: ProfileValues; stored: StoredFact[]; resumeText: string }): FactSheet {
  const drafts = new Map<string, Draft>();
  const put = (d: Draft) => drafts.set(d.key, d);

  for (const [key, question] of PROFILE_FACTS) {
    const value = input.profile[key]?.trim();
    if (value) put({ key: `profile.${key.toLowerCase()}`, question, type: "text", value, complete: false, source: "profile", evidence: "Settings profile" });
  }
  const years = Number(input.profile.yearsOfExperience);
  if (years > 0) {
    put({ key: "experience.total_years", question: "Years of professional software experience", type: "number", value: years, complete: false, source: "settings", evidence: "Settings: years of experience" });
  }
  put({ key: "education.bachelor.degree", question: "Bachelor's degree", type: "text", value: EDUCATION.degree, complete: false, source: "profile", evidence: "Education on file" });
  put({ key: "education.bachelor.school", question: "University", type: "text", value: EDUCATION.school, complete: false, source: "profile", evidence: "Education on file" });
  put({ key: "education.bachelor.graduation_year", question: "Graduation year", type: "number", value: Number(EDUCATION.endYear), complete: false, source: "profile", evidence: "Education on file" });
  put({ key: "education.has_degree", question: "Do you have a university degree?", type: "boolean", value: true, complete: false, source: "profile", evidence: "Education on file" });
  BACKGROUND_FACTS.forEach((text, i) =>
    put({ key: `background.item_${i + 1}`, question: "Background", type: "text", value: text, complete: false, source: "profile", evidence: "Background on file" }),
  );

  const tools = resumeTools(input.resumeText);
  for (const tool of tools) {
    put({ key: `skill.${itemKey(tool.name).replace(/\W/g, "_")}.professional`, question: `Have you used ${tool.name} professionally?`, type: "boolean", value: true, complete: false, source: "resume", evidence: tool.evidence });
  }
  if (tools.length > 0) {
    put({ key: "skills.professional", question: "Tools and languages you have used professionally", type: "list", value: tools.map((t) => t.name), complete: false, source: "resume", evidence: "Named on the resume" });
  }

  for (const row of input.stored) {
    if (!isFactType(row.type)) continue;
    const value = coerceFactValue(row.type, row.value);
    if (value === null) continue;
    const source: FactSource = row.source === "user" || row.source === "settings" ? row.source : "resume";
    put({ key: row.key, question: row.question, type: row.type, value, complete: row.complete, source, evidence: row.evidence });
  }

  // Skill years follow one rule whatever was answered on an earlier form.
  for (const d of [...drafts.values()]) {
    const m = SKILL_FACT_RE.exec(d.key);
    if (!m) continue;
    if (m[2] === "years") put({ ...d, type: "number", value: skillYears(m[1], years) });
    else if (isUnusedSkill(m[1])) put({ ...d, type: "boolean", value: false });
  }
  put({ key: "skill.dotnet.years", question: "Years of experience with .NET / C#", type: "number", value: 0, complete: false, source: "settings", evidence: "Never used" });
  put({ key: "skill.dotnet.professional", question: "Have you used .NET / C# professionally?", type: "boolean", value: false, complete: false, source: "settings", evidence: "Never used" });

  // Skills you said yes (or years) to join the open tools list, so a "which of these" group ticks them too.
  const toolList = drafts.get("skills.professional");
  if (toolList && !toolList.complete && Array.isArray(toolList.value)) {
    const items = [...(toolList.value as string[])];
    for (const d of drafts.values()) {
      const m = /^skill\.([a-z0-9_]+)\.(professional|years)$/.exec(d.key);
      const used = d.type === "boolean" ? d.value === true : d.type === "number" ? Number(d.value) > 0 : false;
      const name = m?.[1].replace(/_/g, " ").trim();
      if (name && name.length >= 2 && used && !items.some((i) => itemMatches(i, name) || itemMatches(name, i))) items.push(name);
    }
    // A GitHub profile on file is Git use at work for a software engineer.
    if (input.profile.githubUrl && !items.some((i) => /^git$/i.test(i))) items.push("Git");
    put({ ...toolList, value: items });
  }

  const facts = [...drafts.values()].map((d, i) => ({ ...d, id: `f${i + 1}` }));
  return {
    facts,
    byKey: new Map(facts.map((f) => [f.key, f])),
    byId: new Map(facts.map((f) => [f.id, f])),
  };
}

export function emptyFactSheet(): FactSheet {
  return { facts: [], byKey: new Map(), byId: new Map() };
}

export function factValueText(fact: Pick<Fact, "type" | "value" | "complete">): string {
  if (fact.type === "boolean") return fact.value ? "Yes" : "No";
  if (fact.type === "list") {
    const items = fact.value as string[];
    const list = items.length > 0 ? items.join(", ") : "none";
    return fact.complete ? `${list} (complete list)` : `${list} (not necessarily complete)`;
  }
  return String(fact.value);
}

/** Facts as prompt lines: `f3 [skill.nodejs.professional] Have you used Node.js professionally?: Yes`. */
export function factLines(facts: Fact[]): string[] {
  return facts.map((f) => `${f.id} [${f.key}] ${f.question}: ${factValueText(f)}`);
}

// ---------- Projection: a fact onto one control ----------

export type Projection =
  | { kind: "answer"; action: RecipeAction; fact: Fact }
  /** A text fact with no option spelled the same way; the caller may pick one with chooseOption. */
  | { kind: "pick"; value: string; fact: Fact }
  | { kind: "unknown"; why: string };

const PLACEHOLDER_RE = /^(select|select one|select an option|please select|choose|choose one|)$/;
const NO_RE = /^(no|nein|non|n|false|i do not|i don t|i dont|i have not|i haven t|i am not|i m not|i can not|i cannot|i will not|i won t|not)\b/;
const YES_RE = /^(yes|ja|oui|si|y|true|i do|i have|i am|i m|i can|i will|i agree)\b/;
const EXCLUSIVE_RE = /^(none|n a|na|none of (the )?(above|these|them)|no experience|not applicable|neither|i have not|i haven t)\b/;
const OTHER_RE = /^(other|others|something else)\b/;
const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function real(options: string[]): string[] {
  return options.filter((o) => !PLACEHOLDER_RE.test(normalizeLabel(o)));
}

export function yesNoText(text: string): boolean | null {
  const t = normalizeLabel(text);
  if (NO_RE.test(t)) return false;
  if (YES_RE.test(t)) return true;
  return null;
}

/** The yes and no choices of a two-way question, or null when the choices are something else. */
export function yesNoOptions(options: string[]): { yes: string; no: string } | null {
  const list = real(options);
  if (list.length < 2 || list.length > 3) return null;
  const no = list.find((o) => yesNoText(o) === false);
  const yes = list.find((o) => yesNoText(o) === true);
  return yes && no ? { yes, no } : null;
}

/** "None", "N/A", "None of the above": a choice that rules out every other one. */
export function isExclusiveOption(option: string): boolean {
  return EXCLUSIVE_RE.test(normalizeLabel(option));
}

export function isOtherOption(option: string): boolean {
  return OTHER_RE.test(normalizeLabel(option));
}

/** "(Choose up to three)" → 3. */
export function choiceLimit(label: string): number | null {
  const m = /\b(?:up to|at most|maximum(?: of)?|max|choose|select|pick)\s+(\d+|one|two|three|four|five|six)\b/i.exec(label);
  if (!m) return null;
  const n = Number(m[1]) || WORD_NUMBERS[m[1].toLowerCase()];
  return n > 0 ? n : null;
}

interface Range {
  min: number;
  max: number;
}

/** A duration choice in years: "3-5 years", "5+", "< 1 year", "Fresher", "6 months". */
export function parseRange(option: string): Range | null {
  const t = normalizeLabel(option).replace(/(\d)\s+(\d)/g, "$1-$2");
  const raw = option.toLowerCase();
  const months = /\bmonths?\b/.test(t) ? 1 / 12 : 1;
  if (/\b(fresher|no experience|none)\b/.test(t)) return { min: 0, max: 0 };
  const nums = (raw.match(/\d+(\.\d+)?/g) ?? []).map((n) => Number(n) * months);
  if (nums.length === 0) return null;
  if (/[<]|less than|under|below/.test(raw)) return { min: 0, max: nums[0] - 0.001 };
  if (/\+|or more|more than|above|over|at least/.test(raw)) return { min: nums[0] + (/more than|above|over/.test(raw) ? 0.001 : 0), max: Infinity };
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  return { min: nums[0], max: nums[0] };
}

/** The duration / number choice that holds `value` ("3 - 5 years" for 4), or null. */
export function bucket(value: number, options: string[]): string | null {
  const hits = real(options)
    .map((o) => ({ o, r: parseRange(o) }))
    .filter((x): x is { o: string; r: Range } => x.r !== null && value >= x.r.min && value <= x.r.max);
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.r.min - a.r.min);
  return hits[0].o;
}

/** Yes, no, or unknown for a yes/no question answered by this fact. */
export function factTruth(fact: Fact, c: Pick<Classification, "item" | "atLeast">): boolean | null {
  switch (fact.type) {
    case "boolean":
      return fact.value as boolean;
    case "list": {
      const items = fact.value as string[];
      if (c.item) {
        if (items.some((i) => itemMatches(c.item!, i) || itemMatches(i, c.item!))) return true;
        return fact.complete ? false : null;
      }
      if (items.length > 0) return true;
      return fact.complete ? false : null;
    }
    case "number":
      return c.atLeast != null ? (fact.value as number) >= c.atLeast : null;
    case "text":
      return yesNoText(fact.value as string);
  }
}

/**
 * Exactly the checkbox choices a complete list allows. An open list ticks the choices it names
 * and nothing else (no None, no Other); unknown when it names none of them.
 */
function projectList(fact: Fact, field: FieldDescriptor): Projection {
  const items = fact.value as string[];
  const options = real(field.options);
  if (!fact.complete) {
    const known = options.filter(
      (o) => !isExclusiveOption(o) && !isOtherOption(o) && items.some((i) => itemMatches(i, o) || itemMatches(o, i)),
    );
    if (known.length === 0) return { kind: "unknown", why: `only part of ${fact.key} is known` };
    const limit = choiceLimit(field.label);
    return { kind: "answer", action: { type: "options", values: limit ? known.slice(0, limit) : known }, fact };
  }
  const exclusive = options.find(isExclusiveOption);
  const other = options.find(isOtherOption);
  const picks: string[] = [];
  const extras: string[] = [];
  for (const item of items) {
    const hit = options.find((o) => !isExclusiveOption(o) && !isOtherOption(o) && (itemMatches(item, o) || itemMatches(o, item)));
    if (hit) {
      if (!picks.includes(hit)) picks.push(hit);
    } else extras.push(item);
  }
  if (extras.length > 0) {
    if (!other) return { kind: "unknown", why: `${extras.join(", ")} is not a choice and there is no Other` };
    picks.push(other);
  }
  if (picks.length === 0) {
    if (items.length === 0 && exclusive) return { kind: "answer", action: { type: "options", values: [exclusive] }, fact };
    return { kind: "unknown", why: `nothing in ${fact.key} fits the choices` };
  }
  const limit = choiceLimit(field.label);
  return { kind: "answer", action: { type: "options", values: limit ? picks.slice(0, limit) : picks }, fact };
}

/**
 * The only path from a fact to a control. Never falls back to a first option or a default Yes:
 * anything the fact does not settle comes back unknown, and unknown means ask.
 */
export function projectFact(fact: Fact | undefined, field: FieldDescriptor, c: Classification): Projection {
  if (!fact) return { kind: "unknown", why: `no fact for ${c.factKey ?? "this question"}` };
  const options = real(field.options);
  const value = fact.value;

  if (field.control === "checkbox" && (field.multi || options.length > 1)) {
    if (fact.type !== "list") return { kind: "unknown", why: `${fact.key} is not a list` };
    return projectList(fact, field);
  }

  const pair = yesNoOptions(options);
  if (pair) {
    const truth = factTruth(fact, c);
    if (truth === null) return { kind: "unknown", why: `${fact.key} does not settle yes or no` };
    return { kind: "answer", action: { type: "option", value: truth ? pair.yes : pair.no }, fact };
  }

  if (field.control === "checkbox" && options.length === 1) {
    const truth = fact.type === "list" ? factTruth(fact, { item: c.item ?? options[0] }) : factTruth(fact, c);
    if (truth === true) return { kind: "answer", action: { type: "options", values: [options[0]] }, fact };
    return { kind: "unknown", why: `${fact.key} does not say to tick "${options[0].slice(0, 40)}"` };
  }

  if (options.length > 0) {
    switch (fact.type) {
      case "number": {
        const hit = bucket(value as number, options) ?? matchOption(String(value), options);
        return hit ? { kind: "answer", action: { type: "option", value: hit }, fact } : { kind: "unknown", why: `no choice fits ${value}` };
      }
      case "text": {
        const hit = matchOption(value as string, options);
        return hit ? { kind: "answer", action: { type: "option", value: hit }, fact } : { kind: "pick", value: value as string, fact };
      }
      case "list": {
        const hits = options.filter((o) => (value as string[]).some((i) => itemMatches(i, o) || itemMatches(o, i)));
        return hits.length === 1
          ? { kind: "answer", action: { type: "option", value: hits[0] }, fact }
          : { kind: "unknown", why: `${fact.key} fits ${hits.length} choices` };
      }
      case "boolean":
        return { kind: "unknown", why: `${fact.key} is yes/no but the choices are not` };
    }
  }

  const text =
    fact.type === "boolean"
      ? value
        ? "Yes"
        : "No"
      : fact.type === "list"
        ? (value as string[]).join(", ")
        : String(value);
  if (!text) return { kind: "unknown", why: `${fact.key} is empty` };
  return { kind: "answer", action: { type: "literal", value: text }, fact };
}
