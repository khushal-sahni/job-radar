import { normalizeLabel } from "./fingerprint";
import type { RuleBranch } from "@/lib/types";
import type { FieldDescriptor, ProfileKey, ProfileValues, RecipeAction } from "./types";

export interface ProfileSource {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedInUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  currentCompany: string;
  noticePeriod: string;
  expectedCtc: string;
  resumeSummary: string;
}

export function buildProfileValues(
  profile: ProfileSource,
  yearsOfExperience: number,
): ProfileValues {
  const parts = profile.location.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    city: parts[0] ?? "",
    country: parts.length > 1 ? parts[parts.length - 1] : "",
    linkedInUrl: profile.linkedInUrl,
    githubUrl: profile.githubUrl,
    portfolioUrl: profile.portfolioUrl,
    currentCompany: profile.currentCompany,
    noticePeriod: profile.noticePeriod,
    expectedCtc: profile.expectedCtc,
    resumeSummary: profile.resumeSummary,
    yearsOfExperience: yearsOfExperience > 0 ? String(yearsOfExperience) : "",
  };
}

/** Salary floors from the rule branches by country code: Germany in EUR, Japan in JPY. */
export function salaryFloorsFromRules(rules: RuleBranch[]): Partial<Record<string, number>> {
  const floors: Partial<Record<string, number>> = {};
  for (const r of rules) {
    if (r.country === "DE" && r.minSalaryEUR) floors.DE = r.minSalaryEUR;
    if (r.country === "JP" && r.minSalaryJPY) floors.JP = r.minSalaryJPY;
  }
  return floors;
}

const RULES: Array<[ProfileKey, RegExp]> = [
  ["email", /\be ?mail\b/],
  ["linkedInUrl", /\blinked ?in\b/],
  ["githubUrl", /\bgithub\b/],
  ["phone", /\b(phone|contact number|whatsapp|cell)\b|\bmobile (number|no)\b|^mobile$/],
  ["portfolioUrl", /\b(portfolio|personal (web)?site|website|blog)\b/],
  // Before first / last: "First and Last Name" is one box for both.
  // "Last Name/Surname" must not hit `\bname … surname\b` after "/" becomes a space.
  ["fullName", /^(your )?(full |legal )?name$|\bfull name\b|\blegal name\b|\bfirst (and )?last name\b|\bfirst name (and )?(last name|surname)\b|(?<!\blast )\bname (and )?surname\b/],
  ["firstName", /\b(first name|given name|forename)\b/],
  ["lastName", /\b(last name|family name|surname)\b/],
  [
    "noticePeriod",
    /\bnotice period\b|\bwhen can you (start|join)\b|\bearliest (start|joining)\b|\bhow soon can you (start|join)\b|\bavailability to (start|join)\b/,
  ],
  [
    "expectedCtc",
    /\bexpected( (annual|yearly|fixed|base|total|gross))* (ctc|salary|compensation|pay)\b|\bsalary expectations?\b|\bdesired (salary|compensation|pay)\b|\bcompensation expectations?\b/,
  ],
  ["currentCompany", /\bcurrent (company|employer|organi[sz]ation)\b|^company$|\bpresent employer\b/],
  ["city", /^city$|\bcurrent city\b|\bcity of residence\b|\bwhich city do you (currently )?live in\b/],
  [
    "country",
    /^(country|land)$|\bcountry of residence\b|\bcurrent country\b|\bcountry (in which|where) you (currently )?(reside|live|are based|are located)\b|\b(which|what) country (are|do) you (currently )?(based|live|reside|located|in|work)\b/,
  ],
  [
    "location",
    /^location$|\blocation preference\b|\bpreferred location\b|\bcurrent (working )?location\b|\blocation city\b|\bwhere are you (currently )?(based|located)\b|\bwhere do you (currently )?(live|reside)\b|\b(which|what) (country and city|city and country)\b|^address$|\bcurrent address\b/,
  ],
  ["resumeSummary", /\bcover letter\b|\badditional information\b/],
];

const LINK_KEYS: ReadonlySet<ProfileKey> = new Set(["linkedInUrl", "githubUrl", "portfolioUrl"]);
const ABOUT_WORK_RE =
  /\b(have|did|do|can) you (built|build|created|create|written|write|made|make|published|publish|contributed|contribute|open ?sourced?|worked)\b|\bopen ?sourced?\b|\bcontribut\w*\b|\bprojects? (that )?you\b|\bdescribe\b|\bagents?\b/;

/**
 * A question about work that names a link site ("Have you open-sourced any agents? Share the GitHub link"),
 * as opposed to a link box ("LinkedIn", "Portfolio/Website (Github preferred)"). A profile URL does not answer it.
 */
export function isLinkQuestion(label: string): boolean {
  return ABOUT_WORK_RE.test(normalizeLabel(label));
}

const TOTAL_YEARS_RE =
  /\b(total|overall)?\s*years of (professional |work |relevant |industry )?experience\b|\bhow many years\b.*\bexperience\b|\brelevant experience( for (the )?applied role)?\b/;
const SKILL_SPECIFIC_RE =
  /\b(experience|do you have) (with|in|using|of|on)\b(?! (total|software|the industry|industry|tech))/;

const UNASKED_EXTRA_RE = /\b(phone )?extension\b|^ext$|^address line [23]$|^address [23]$/;

/** Optional extras with nothing true to put in them: a phone extension, a second or third address line. */
export function isUnaskedExtra(label: string): boolean {
  return UNASKED_EXTRA_RE.test(normalizeLabel(label));
}

const MIDDLE_NAME_RE = /^((your|local|legal) )?middle (name|initials?)$/;

/** A box for a middle name alone. The applicant has none. */
export function isMiddleNameLabel(label: string): boolean {
  return MIDDLE_NAME_RE.test(normalizeLabel(label));
}

const NO_VALUE_OPTION_RE = /^(n ?a|none|not applicable)$/;

/**
 * The applicant has no middle name: an optional box stays blank, a required one gets "N/A"
 * ("-" when the box holds fewer than 3 characters), a list takes its N/A or None row.
 */
export function middleNameAction(field: Pick<FieldDescriptor, "control" | "options" | "required" | "maxLength">): RecipeAction | null {
  if (field.options.length > 0) {
    const none = field.options.find((o) => NO_VALUE_OPTION_RE.test(normalizeLabel(o)));
    return none ? { type: "option", value: none } : null;
  }
  if (!field.required || (field.control !== "text" && field.control !== "textarea")) return null;
  return { type: "literal", value: field.maxLength != null && field.maxLength < 3 ? "-" : "N/A" };
}

/** Profile key for a label, or null. Pure label match; option fit is checked by the validator. */
export function mapLabelToProfileKey(field: Pick<FieldDescriptor, "label" | "control">): ProfileKey | null {
  if (field.control === "file" || field.control === "checkbox") return null;
  const label = normalizeLabel(field.label);
  if (!label || /\brelocat/.test(label) || UNASKED_EXTRA_RE.test(label)) return null;
  // "Are you already on notice period?" is a yes or no, not the notice length.
  if (/\b(already|currently) (on|serving)\b.*\bnotice\b/.test(label)) return null;

  if (TOTAL_YEARS_RE.test(label) && !SKILL_SPECIFIC_RE.test(label)) {
    return "yearsOfExperience";
  }
  for (const [key, re] of RULES) {
    if (re.test(label)) return LINK_KEYS.has(key) && ABOUT_WORK_RE.test(label) ? null : key;
  }
  return null;
}

const LANGUAGE_PREF_RE = /\b(language do you prefer|preferred (communication )?language|communication language)\b/i;
const HEARD_ABOUT_RE =
  /\bhow did you (first )?(hear|find out|learn|come to know|come across|discover)( about)?\b|\bwhere did \w+ first catch your eye\b|\bprimary reason\b/i;
// "Careers Fair" is an event, not the site; Workday's source menu offers "Website" or "Northern Trust Web Site".
const CAREER_PAGE_RE =
  /^(careers?|web ?site|company web ?site)$|\bcareers? (page|site|web ?site|portal)\b|\bcompany (web ?site|site|page)\b|\bwebsite\/?blog\b|^(?!.*\b(job|board|social|media)\b).+ web ?site$/i;

const LINKEDIN_RE = /\blinked ?in\b/i;
const SOCIAL_RE = /^social (media|networks?|networking)( website)?$/i;
const JOB_BOARD_RE = /^job boards?$/i;

/** Standing choices: English as the working language; LinkedIn (else social media, the career page, job board, Other) as the source. */
export function knownOption(field: Pick<FieldDescriptor, "label" | "options">): string | null {
  if (LANGUAGE_PREF_RE.test(field.label)) return field.options.find((o) => /^english\b/i.test(o.trim())) ?? null;
  if (HEARD_ABOUT_RE.test(field.label)) {
    return (
      field.options.find((o) => LINKEDIN_RE.test(o)) ??
      field.options.find((o) => SOCIAL_RE.test(o.trim())) ??
      field.options.find((o) => CAREER_PAGE_RE.test(o)) ??
      field.options.find((o) => JOB_BOARD_RE.test(o.trim())) ??
      field.options.find((o) => /^others?\b/i.test(o.trim())) ??
      null
    );
  }
  return null;
}

/** Typed where "How did you hear about us?" is a text box. */
export const HEARD_ABOUT_ANSWER = "LinkedIn";

export function isHeardAboutLabel(label: string): boolean {
  return HEARD_ABOUT_RE.test(label);
}

const CONSENT_RE =
  /\b(i agree|i consent|i acknowledge|i confirm|i accept|i certify|i have read|agree to|consent to|accept the|privacy (policy|notice)|terms|einverstanden|einwilligung)\b/i;
const AGREE_RE = /\b(agree|consent|accept|acknowledge|einverstanden|stimme zu|akzeptiere)\b/i;
const REFUSE_RE = /\b(do not|don't|dont|disagree|decline|refuse|not agree|not provided|not given|opt out|no|false|nein|nicht|ablehnen)\b/i;
const ACKNOWLEDGEMENT_RE =
  /\b(have (read|reviewed)|i acknowledge|acknowledge that|i certify|certify that|privacy (policy|notice|statement)|terms (and|&) conditions|terms of (use|service)|ich bin damit einverstanden|einwilligung|(interview |video )?recording consent)\b/i;
const AFFIRM_RE =
  /^(yes|true|ok|okay|i (agree|accept|acknowledge|consent|confirm|certify|understand|have read|have reviewed)|agree|accept|acknowledge|consent|confirm|ja|einverstanden|(ich )?stimme zu|(ich )?akzeptiere)\b/;

function realOptions(options: string[]): string[] {
  return options.filter((o) => !/^(select|select one|select an option|please select|choose|)$/.test(normalizeLabel(o)));
}

/** "I have read the terms of…", "I acknowledge Acme's privacy notice": agreed on every form, never asked. */
export function isAcknowledgementLabel(label: string): boolean {
  return ACKNOWLEDGEMENT_RE.test(label) || /^(interview |video )?recording consent$/.test(normalizeLabel(label));
}

/**
 * The affirmative choice on an acknowledgement control: a lone checkbox, the only option offered,
 * or the one affirmative option (Yes, True, I acknowledge) when every other option refuses.
 */
export function affirmativeOption(field: Pick<FieldDescriptor, "control" | "options">): string | null {
  const values = affirmativeOptions(field);
  return values[0] ?? null;
}

/** Every agreeing choice on a consent control. A lone checkbox with no option text is still a yes. */
export function affirmativeOptions(field: Pick<FieldDescriptor, "control" | "options">): string[] {
  if (field.control === "checkbox" && field.options.length <= 1) return [field.options[0] ?? ""];
  const options = realOptions(field.options);
  if (options.length === 0) return field.control === "checkbox" ? [""] : [];
  if (options.length === 1) return [options[0]];
  const agree = options.filter((o) => !REFUSE_RE.test(o) && (AFFIRM_RE.test(normalizeLabel(o)) || AGREE_RE.test(o)));
  const clean = (hits: string[]) => hits.length > 0 && options.every((o) => hits.includes(o) || REFUSE_RE.test(o));
  if (field.control === "checkbox") {
    if (agree.length > 0) return agree;
    return options.filter((o) => !REFUSE_RE.test(o));
  }
  if (clean(agree)) return agree;
  const affirm = options.filter((o) => AFFIRM_RE.test(normalizeLabel(o)) && !REFUSE_RE.test(o));
  return clean(affirm) ? affirm : [];
}

/**
 * The agreeing choice on a consent control: a lone consent checkbox, an agree / do-not-agree
 * pair, or the affirmative choice on an acknowledgement. Answered even when the legal text names sensitive data.
 */
export function consentOption(field: Pick<FieldDescriptor, "label" | "control" | "options">): string | null {
  if (isAcknowledgementLabel(field.label)) return affirmativeOption(field);
  const options = realOptions(field.options);
  if (field.control === "checkbox" && options.length === 1) {
    return CONSENT_RE.test(`${field.label} ${options[0]}`) ? options[0] : null;
  }
  if (options.length !== 2 || field.control === "checkbox") return null;
  const agree = options.filter((o) => AGREE_RE.test(o) && !REFUSE_RE.test(o));
  const refuse = options.filter((o) => REFUSE_RE.test(o));
  return agree.length === 1 && refuse.length === 1 ? agree[0] : null;
}

/** Old and new spellings, and German country names (German-language forms), mapped word by word. */
const PLACE_ALIASES: Record<string, string> = {
  gurgaon: "gurugram",
  bangalore: "bengaluru",
  bombay: "mumbai",
  calcutta: "kolkata",
  madras: "chennai",
  indien: "india",
  deutschland: "germany",
  vereinigte: "united",
  staaten: "states",
};

/** A residence "State" / "Province" box, not a sentence that merely mentions one. */
const RESIDENCE_STATE_RE =
  /^(state|province)( of residence)?$|^(state|province) (or )?(province|region|territory)$|^(which|what) (state|province) (are|do) you (currently )?(live|reside|located|based)( in)?$/;

/** Cities the profile names without a state, mapped to the state a form's list uses. */
const CITY_STATE: Record<string, string> = {
  gurugram: "Haryana",
  faridabad: "Haryana",
  bengaluru: "Karnataka",
  mumbai: "Maharashtra",
  pune: "Maharashtra",
  nagpur: "Maharashtra",
  hyderabad: "Telangana",
  chennai: "Tamil Nadu",
  kolkata: "West Bengal",
  delhi: "Delhi",
  noida: "Uttar Pradesh",
  ghaziabad: "Uttar Pradesh",
  lucknow: "Uttar Pradesh",
  orai: "Uttar Pradesh",
  jaipur: "Rajasthan",
  ahmedabad: "Gujarat",
  chandigarh: "Chandigarh",
  kochi: "Kerala",
  thiruvananthapuram: "Kerala",
  bhubaneswar: "Odisha",
  indore: "Madhya Pradesh",
  bhopal: "Madhya Pradesh",
  visakhapatnam: "Andhra Pradesh",
};

const INDIAN_STATES = [...new Set(Object.values(CITY_STATE))];

export function isResidenceStateLabel(label: string): boolean {
  return RESIDENCE_STATE_RE.test(normalizeLabel(label));
}

/** The state or province named by a profile location ("Gurugram, India" → "Haryana"), or null. */
export function residenceState(location: string): string | null {
  const words = optionWords(location);
  const named = INDIAN_STATES.find((state) => {
    const parts = optionWords(state);
    return parts.every((p) => words.includes(p));
  });
  if (named) return named;
  for (const word of words) {
    const state = CITY_STATE[word];
    if (state) return state;
  }
  return null;
}

/** Workday writes Indian states with macrons ("Haryāna", "Karnātaka"); profiles and facts do not. */
function optionWords(text: string): string[] {
  return normalizeLabel(text.normalize("NFD").replace(/\p{M}/gu, ""))
    .split(" ")
    .filter(Boolean)
    .map((w) => PLACE_ALIASES[w] ?? w);
}

/** Whole words only: "India" never matches "British Indian Ocean Territory", "Gurugram" never "Gurugramam". */
function optionScore(wanted: string[], option: string, country: string[]): number {
  const words = optionWords(option);
  if (words.length === 0) return 0;
  let score = 0;
  if (words.join(" ") === wanted.join(" ")) score = 100;
  else if (wanted.every((w) => words.includes(w))) score = 50 + (words[0] === wanted[0] ? 10 : 0);
  else if (words.every((w) => wanted.includes(w))) score = 30;
  if (score === 0) return 0;
  const last = optionWords(option.split(",").pop() ?? "");
  if (country.length > 0 && last.join(" ") === country.join(" ")) score += 20;
  return score;
}

/**
 * The one option that best fits a free value ("India" → "India (+91)"), or null.
 * Null on a tie too ("Gurugram" against two Gurugrams in India): a guess there is worse than asking.
 * `preferCountry` lifts options whose last comma part is that country.
 */
export function matchOption(value: string, options: string[], preferCountry?: string): string | null {
  const wanted = optionWords(value);
  if (wanted.length === 0) return null;
  const country = preferCountry ? optionWords(preferCountry) : [];
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const option of options) {
    const score = optionScore(wanted, option, country);
    if (score === 0 || score < bestScore) continue;
    if (score === bestScore && best !== null) {
      if (normalizeLabel(option) !== normalizeLabel(best)) tied = true;
      continue;
    }
    best = option;
    bestScore = score;
    tied = false;
  }
  return tied ? null : best;
}
