import { WORK_HISTORY } from "./applicant-data";
import { monthYearAction } from "./form-sections";
import type { ResolveContext } from "./context";
import { bucket, isExclusiveOption, namesUnusedSkill, parseRange, yesNoOptions, yesNoText, type FactSheet } from "./facts";
import { normalizeLabel } from "./fingerprint";
import { affirmativeOption, affirmativeOptions, isResidenceStateLabel, mapLabelToProfileKey, matchOption, residenceState } from "./profile-map";
import type { FieldDescriptor, RecipeAction } from "./types";
import { answerWorkAuth, countriesIn, countryCode, isWorkAuthLabel, workCountry, type JobLocation } from "./work-auth";

/**
 * Standing answers to the screening questions every board asks in its own words: legal
 * acknowledgements, join window, residence, relocation, sponsorship, hours, contracts, skill
 * levels, self-identification and ties to the employer. Each comes from the profile, the fact
 * sheet or the resume record, so these questions are never put to you.
 */
export type Standing =
  | { kind: "fill"; action: RecipeAction }
  | { kind: "park"; reason: string }
  | { kind: "ineligible"; reason: string }
  | { kind: "skip" };

const PLACEHOLDER_RE = /^(select|select one|select an option|please select|choose|choose one|make a selection|)$/;

function real(options: string[]): string[] {
  return options.filter((o) => !PLACEHOLDER_RE.test(normalizeLabel(o)));
}

function pick(field: FieldDescriptor, option: string): RecipeAction {
  return field.control === "checkbox" ? { type: "options", values: [option] } : { type: "option", value: option };
}

/** Yes or No on whatever control the question uses; null when its choices are something else. */
export function yesNoAction(field: FieldDescriptor, yes: boolean): RecipeAction | null {
  const options = real(field.options);
  if (options.length === 0) {
    if (field.control === "text" || field.control === "textarea") return { type: "literal", value: yes ? "Yes" : "No" };
    return { type: "option", value: yes ? "Yes" : "No" };
  }
  const pair = yesNoOptions(options);
  if (pair) return pick(field, yes ? pair.yes : pair.no);
  if (field.control === "checkbox" && options.length === 1 && yesNoText(options[0]) === true) {
    return yes ? pick(field, options[0]) : { type: "skip" };
  }
  const noish = options.find((o) => yesNoText(o) === false);
  const yesish = options.find((o) => yesNoText(o) === true && !/\b(opposed|never|not)\b/.test(normalizeLabel(o)));
  if (yes && yesish) return pick(field, yesish);
  if (!yes && noish) return pick(field, noish);
  return null;
}

function fill(action: RecipeAction | null): Standing | null {
  return action ? { kind: "fill", action } : null;
}

function factValue(facts: FactSheet | undefined, key: string): unknown {
  return facts?.byKey.get(key)?.value;
}

function hasWord(text: string, word: string): boolean {
  const w = normalizeLabel(word);
  return w.length > 0 && new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(text);
}

// ---------- Legal acknowledgements ----------

const CONSENT_LABEL_RE =
  /\b(polic(y|ies)|privacy|terms|consent|gdpr|acknowledg\w*|certif(y|ication)|declar\w*|accurate|truthful|true and (correct|complete)|background (check|verification)|data (processing|protection)|for more information)\b/;
const OPT_IN_RE = /\b(marketing|newsletters?|sms|text messages?|promotional|whatsapp)\b/;
const SINGLE_AGREE_RE = /^(acknowledged?|i acknowledge|agreed?|i agree|accepted?|i accept|i understand|understood|confirm(ed)?|i confirm|i have read)\b/;
const SINGLE_YES_RE = /^(yes|ok|okay|read)\b/;

const PDF_RESUME_RE = /\bpdf version of your (resume|cv)\b|\bonly submit a pdf\b|\bsubmit(ting)? .{0,20}pdf\b/;

/** Greenhouse "please only submit a PDF" is a required confirmation, not a question. */
function pdfResumeConfirm(field: FieldDescriptor, label: string): Standing | null {
  if (!PDF_RESUME_RE.test(label)) return null;
  if (field.control === "checkbox") return fill({ type: "options", values: [real(field.options)[0] ?? ""] });
  return fill(yesNoAction(field, true) ?? { type: "literal", value: "PDF" });
}

function consent(field: FieldDescriptor, label: string): Standing | null {
  if (OPT_IN_RE.test(label)) return null;
  const options = real(field.options);
  if (options.length === 1) {
    const only = normalizeLabel(options[0]);
    if (SINGLE_AGREE_RE.test(only) || (SINGLE_YES_RE.test(only) && CONSENT_LABEL_RE.test(label))) return fill(pick(field, options[0]));
  }
  if (!CONSENT_LABEL_RE.test(label)) return null;
  const values = affirmativeOptions(field);
  if (values.length > 0) return fill(field.control === "checkbox" ? { type: "options", values } : pick(field, values[0]));
  if (options.length === 0) return fill(yesNoAction(field, true));
  if (/\brecording consent\b/.test(label)) {
    const yes = options.find((o) => /\b(consent|agree|yes|acknowledge)\b/i.test(o) && !/\b(not |do not|don't|decline)\b/i.test(o));
    if (yes) return fill(pick(field, yes));
    if (field.control === "checkbox") return fill({ type: "options", values: options.filter((o) => !/\b(do not|don't|decline|disagree)\b/i.test(o)) });
  }
  return null;
}

// ---------- Ties to the employer, public office ----------

const GOVERNMENT_RE =
  /\b(government (official|employee|servant|work)|public (servant|official|institution|sector employee)|civil servant|politically exposed|military service)\b/;
const RELATIVE_RE = /\b(relatives?|family members?|friends?|spouse|related to|personal relationships?|close relationships?)\b/;
const APPLIED_BEFORE_RE = /\b(applied|interviewed)\b.*\b(before|previously|past|prior|last \d+ months)\b|\bpreviously (applied|interviewed)\b/;
const WORKED_HERE_RE =
  /\bhave you (ever )?(worked (at|for|with)|been employed by)\b|\b(currently or have you ever|are you currently or have you ever) (been )?(employed|worked|contracted)\b|\b(previously|ever|before|formerly|former|prior|in the past)\b.*\b(work(ed)?|employed|held a position|contract(ed|or)|intern(ed)?)\b|\b(been|were) (employed|contracted)\b.*\b(in the past|before|previously)\b|\b(former|ex) employee\b|\bworked (here|for us|with us)\b|\bworked (at|for|with)\b.*\b(before|previously|in the past)\b/;
const KNOW_STAFF_RE = /\bknow (anyone|someone|any (current )?(employees?|one))\b.*\b(work\w*|employ\w*)\b/;
const OUTSIDE_WORK_RE = /\boutside (business|employment|work|activit\w*)\b|\bconflicts? of interest\b|\b(board|advisory) (roles?|seats?|positions?|memberships?)\b/;
const THIS_EMPLOYER_RE = /\b(for us|with us|at us|here|this company|our company|the company|company name|our organi[sz]ation)\b/;

const COMPANY_SUFFIXES = ["india", "career", "careers", "labs", "group", "holdings", "inc", "hq"];

function aboutEmployer(label: string, company: string): boolean {
  if (THIS_EMPLOYER_RE.test(label) || hasWord(label, company)) return true;
  const compact = normalizeLabel(company).replace(/[\s_-]+/g, "");
  for (const suffix of COMPANY_SUFFIXES) {
    if (compact.endsWith(suffix) && compact.length > suffix.length + 3) {
      const stem = compact.slice(0, -suffix.length);
      if (hasWord(label, stem) || normalizeLabel(label).includes(stem)) return true;
    }
  }
  return false;
}

function workedAt(company: string): boolean {
  const name = normalizeLabel(company);
  return WORK_HISTORY.some((j) => {
    const past = normalizeLabel(j.company);
    return past.length >= 3 && (past.includes(name) || name.includes(past));
  });
}

/** "Employed by a client, partner or competitor of Addepar": no past employer is one. */
const BUSINESS_TIE_RE = /\b(clients?|customers?|partners?|competitors?|vendors?|suppliers?)\b/;
/** Applications go in from the job boards; no one referred the applicant. */
const REFERRED_RE = /\b(were|was|have) you (been )?referred\b|\breferred by (an? )?(employee|someone|anyone)\b/;
const RECRUITING_EVENT_RE = /\b(attended|been to|participated in)\b.*\b(recruiting|recruitment|career|hiring) (events?|fairs?|sessions?)\b/;

const CURRENT_USER_RE = /\b(are|is) you (a |an )?(current|existing|active) .{0,40}?\b(user|customer|client)\b/;

const IF_YES_RE = /^if yes\b/;
const PRIOR_JOB_RE =
  /\b(employment|employed|name used|dates? of|when you (were )?employed|previous (role|job|position)|approximate dates)\b/;

/** "If yes, name used during employment" stays blank when the parent worked-here answer is No. */
function employerFollowUp(field: FieldDescriptor, label: string, company: string): Standing | null {
  if (!IF_YES_RE.test(label) || !PRIOR_JOB_RE.test(label)) return null;
  return workedAt(company) ? null : { kind: "skip" };
}

function employerTies(field: FieldDescriptor, label: string, company: string): Standing | null {
  if (GOVERNMENT_RE.test(label)) return fill(yesNoAction(field, false));
  if (BUSINESS_TIE_RE.test(label) && /\b(employed|work(ing)? (for|at))\b/.test(label)) return fill(yesNoAction(field, false));
  if (RECRUITING_EVENT_RE.test(label)) return fill(yesNoAction(field, false));
  if (REFERRED_RE.test(label)) return fill(yesNoAction(field, false));
  if (APPLIED_BEFORE_RE.test(label) && /\bthis (role|position|job)\b/.test(label)) return fill(yesNoAction(field, false));
  if (RELATIVE_RE.test(label) && /\b(work\w*|employ\w*|relationships?)\b/.test(label)) return fill(yesNoAction(field, false));
  if (OUTSIDE_WORK_RE.test(label) && /\b(do|have|are|hold)\b/.test(label)) return fill(yesNoAction(field, false));
  if (CURRENT_USER_RE.test(label)) return fill(yesNoAction(field, workedAt(company)));
  if (/\b(did|do) you (already )?know (about|of)\b/.test(label)) return fill(yesNoAction(field, false));
  if (WORKED_HERE_RE.test(label)) return fill(yesNoAction(field, workedAt(company)));
  if (!aboutEmployer(label, company)) return null;
  if (KNOW_STAFF_RE.test(label)) return fill(yesNoAction(field, false));
  if (APPLIED_BEFORE_RE.test(label)) return fill(yesNoAction(field, false));
  return null;
}

// ---------- Join window and notice period ----------

const DAYS_PER: Record<string, number> = { day: 1, week: 7, month: 30 };

/** "0", "Immediate", "30 days", "2 months" → days; null when the profile does not say. */
export function noticeDays(notice: string): number | null {
  const t = normalizeLabel(notice);
  if (!t) return null;
  if (/\b(immediate|immediately|none|no notice)\b/.test(t)) return 0;
  const m = /(\d+)\s*(day|week|month)?/.exec(t);
  if (!m) return null;
  return Number(m[1]) * DAYS_PER[m[2] ?? "day"];
}

function windowDays(text: string): number | null {
  const m = /(\d+)\s*(day|week|month)s?\b/.exec(text);
  return m ? Number(m[1]) * DAYS_PER[m[2]] : null;
}

const JOIN_RE = /\b(join|joining|start|onboard)\b/;
const IMMEDIATE_RE = /\bimmediate(ly)? (joiner|join|start|joining)\b|\b(join|start) immediately\b/;
const NOTICE_RE = /\bnotice period\b|\bhow soon can you (join|start)\b|\bearliest (start|joining)\b|\bwhen can you (join|start)\b/;

/** The notice choice with the smallest upper bound that still covers the notice. */
export function noticeOption(options: string[], days: number): string | null {
  let best: string | null = null;
  let bestMax = Infinity;
  for (const option of real(options)) {
    const n = normalizeLabel(option);
    if (/\bserving\b/.test(n) || /\b(more than|above|over)\b|\+/.test(option)) continue;
    let max: number | null = null;
    if (/\b(immediate|immediately|no notice)\b|^0( days?)?$/.test(n)) max = 0;
    else {
      const all = [...n.matchAll(/(\d+)\s*(day|week|month)?/g)];
      const last = all[all.length - 1];
      if (last) {
        const unit = last[2] ?? /\b(day|week|month)/.exec(n)?.[1] ?? "day";
        max = Number(last[1]) * DAYS_PER[unit];
      }
    }
    if (max !== null && max >= days && max < bestMax) {
      best = option;
      bestMax = max;
    }
  }
  return best;
}

const ON_NOTICE_RE = /\b(already|currently) (on|serving)( (a|the|your))? notice\b|\bserving (your |a |the )?notice\b/;
/** "How long do you need before you can start?": the standing start lead, in words or as a choice. */
const LEAD_TIME_RE = /\bhow (long|much time|soon)\b.*\b(before|until|to)\b.*\b(start|join)\b/;

function joinWindow(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  const days = noticeDays(ctx.profile.noticePeriod);
  if (days === null) return null;
  if (ON_NOTICE_RE.test(label) && days === 0) return fill(yesNoAction(field, false));
  if (LEAD_TIME_RE.test(label)) {
    const options = real(field.options);
    if (options.length === 0) return field.control === "text" || field.control === "textarea" ? fill({ type: "literal", value: "1 week" }) : null;
    const option = noticeOption(options, START_LEAD_DAYS);
    return option ? fill(pick(field, option)) : null;
  }
  if (IMMEDIATE_RE.test(label)) return fill(yesNoAction(field, days === 0));
  if (JOIN_RE.test(label)) {
    const window = windowDays(label);
    if (window !== null && yesNoOptions(real(field.options))) return fill(yesNoAction(field, days <= window));
  }
  if (NOTICE_RE.test(label)) {
    const options = real(field.options);
    if (options.length > 0 && !yesNoOptions(options)) {
      const option = noticeOption(options, days) ?? (days === 0 ? options.find((o) => /\b(immediate|immediately|no notice|^0)\b/.test(normalizeLabel(o))) : null);
      return option ? fill(pick(field, option)) : null;
    }
    if (options.length === 0) {
      if (field.control === "select" || field.control === "combobox" || field.control === "radio") {
        return fill({ type: "option", value: days === 0 ? "Immediate" : String(days) });
      }
      if (field.control === "text" || field.control === "textarea") {
        return fill({ type: "literal", value: String(days) });
      }
    }
  }
  return null;
}

// ---------- Where you live, where you would work ----------

const HOME_ALIASES: Record<string, string[]> = {
  gurugram: ["gurugram", "gurgaon", "delhi ncr", "ncr"],
  gurgaon: ["gurugram", "gurgaon", "delhi ncr", "ncr"],
};

const CITY_RE =
  /\b(bengaluru|bangalore|mumbai|bombay|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|kochi|noida|delhi|new delhi|gurugram|gurgaon|chandigarh|indore|coimbatore|berlin|munich|hamburg|frankfurt|cologne|tokyo|osaka|warsaw|krakow|london|dublin|amsterdam|paris|madrid|lisbon|singapore|dubai|new york|san francisco|seattle|toronto)\b/;

/** Regions that never include India. APAC and Asia do, so they are left out. */
const FOREIGN_REGION_RE = /\b(europe|european union|emea|americas|north america|latam|latin america)\b/;

const RESIDE_RE = /\b(are|do) you\b.*\b(currently )?(reside|residing|resident|based|located|live|living)\b/;
const ROLE_PLACE_RE = /\b(specified|this (role|position|job)|the (role|job) s? location|this location|job location|office location|the location)\b/;

function homeWords(city: string): string[] {
  const c = normalizeLabel(city);
  return HOME_ALIASES[c] ?? (c ? [c] : []);
}

function residence(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  const options = real(field.options);
  if (!RESIDE_RE.test(label) || (options.length > 0 && !yesNoOptions(options))) return null;
  const text = normalizeLabel(`${label} ${ROLE_PLACE_RE.test(label) ? ctx.job?.location ?? "" : ""}`);
  if (homeWords(ctx.profile.city).some((w) => hasWord(text, w))) return fill(yesNoAction(field, true));
  if (CITY_RE.test(text) || FOREIGN_REGION_RE.test(text)) return fill(yesNoAction(field, false));
  const named = countriesIn(text);
  if (named.length === 0) return null;
  const home = countryCode(ctx.profile.country) ?? "IN";
  return fill(yesNoAction(field, named.includes(home)));
}

const HOME_STATE_RE =
  /\b(which|what) (state|province)\b.*\b(live|living|reside|residing|located|based|work|working|in)\b|\bstate (of|you) (residence|reside|live)\b/;
const HOME_COUNTRY_RE = /\bcountry\b.*\b(reside|residing|live|living|based|located)\b|^国$/;
const HOME_PLACE_RE =
  /\bwhere (are|do) you (currently )?(based|located|live|living|reside|residing)\b|\b(which|what) (city|region|location|area) (are|do) you (currently )?(based|located|live|reside|in)\b|\blocation preference\b|\bpreferred (location|city|office|work location)\b/;
/** Choices that cover living in India when the list does not name it. */
const HOME_REGION_RE = /\b(india|asia|apac|asia pacific|rest of (the )?world|outside|other|elsewhere|none of the above)\b/;

/** Where you live, asked in words: the state, the country or the city on the profile. */
function homePlace(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  const options = real(field.options);
  if (yesNoOptions(options)) return null;
  let value: string | null;
  if (HOME_STATE_RE.test(label) || isResidenceStateLabel(field.label)) value = residenceState(ctx.profile.location);
  else if (HOME_COUNTRY_RE.test(label)) value = ctx.profile.country || null;
  else if (HOME_PLACE_RE.test(label)) value = ctx.profile.location || null;
  else return null;
  if (!value) return null;
  if (options.length === 0) {
    if (field.control === "text" || field.control === "textarea") return fill({ type: "literal", value });
    if (field.control === "combobox") {
      const key = mapLabelToProfileKey({ label: field.label, control: field.control });
      if (key === "location" || key === "city") return fill({ type: "profile", key });
      return fill({ type: "option", value });
    }
    return null;
  }
  const hit =
    matchOption(value, options, ctx.profile.country) ??
    matchOption(ctx.profile.city, options, ctx.profile.country) ??
    matchOption(ctx.profile.country, options) ??
    options.find((o) => HOME_REGION_RE.test(normalizeLabel(o)));
  if (hit) return fill(pick(field, hit));
  if (HOME_PLACE_RE.test(label) && factValue(ctx.facts, "relocation.willingness") === true) {
    const office = options.find((o) => CITY_RE.test(normalizeLabel(o)));
    if (office) return fill(pick(field, office));
  }
  if (HOME_STATE_RE.test(label) || isResidenceStateLabel(field.label)) {
    return { kind: "ineligible", reason: `State list has no Indian state: ${field.options.slice(0, 6).join(", ")}` };
  }
  return null;
}

// ---------- Age and how you work ----------

const ADULT_RE = /\b(18|eighteen|legal (working )?age)\b.*\b(older|over|above|age)\b|\bat least 18\b|\bover (the age of )?18\b/;
/** Culture checks ("fast-paced, whatever it takes — would you…"): the applicant is in. */
const DRIVE_RE =
  /\b(whatever it takes|fast[- ]paced|extra mile|high[- ](intensity|ownership|pressure)|long hours|intense|hustle|ambiguity|startup (pace|environment|culture)|in (the )?trenches)\b/;

/** "By typing my name below, I confirm…": the box takes the full name as the signature. */
const SIGNATURE_RE = /\btyp(e|ing) (in )?(your|my) (full |legal )?name\b|\b(electronic|digital|e) ?signature\b|^signature$|\bsign (here|below)\b/;

function signature(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!SIGNATURE_RE.test(label) || real(field.options).length > 0 || !ctx.profile.fullName) return null;
  return field.control === "text" || field.control === "textarea" ? fill({ type: "profile", key: "fullName" }) : null;
}

function ageAndDrive(field: FieldDescriptor, label: string): Standing | null {
  if (!ADULT_RE.test(label) && !DRIVE_RE.test(label)) return null;
  return fill(yesNoAction(field, true) ?? (affirmativeOption(field) ? pick(field, affirmativeOption(field)!) : null));
}

const US_PERSON_RE =
  /\bu[\s.]*s[\s.]*person\b|\bunited states person\b|\bofac\b|\bcitizen or lawful permanent residen|\blawful permanent residen\w*.{0,60}(united states|u[\s.]*s)/i;

/** ITAR / export-control "U.S. person": yes only when the profile country is the United States. */
function usPerson(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!US_PERSON_RE.test(label)) return null;
  const home = countryCode(ctx.profile.country) ?? "IN";
  const yes = home === "US";
  const pair = yesNoAction(field, yes);
  if (pair) return fill(pair);
  const options = real(field.options);
  if (options.length === 0) return null;
  const no = options.find((o) => /\b(not a|i am not|non[- ]?us|neither|no)\b/.test(normalizeLabel(o)));
  const aye = options.find((o) => /\b(yes|i am a|united states person)\b/.test(normalizeLabel(o)) && !/\bnot\b/.test(normalizeLabel(o)));
  const hit = yes ? aye : no;
  return hit ? fill(pick(field, hit)) : null;
}

const PLACE_PREF_RE =
  /\b(comfortable|willing|open|able|okay|ok|happy|ready|fine)\b.*\b(work(ing)? (from|in|at|out of)|relocat\w*|move (to|here|there)|moving (to|here|there)|commut\w*|on ?site|in ?office|from (the )?office|hybrid)\b|\b(can|could|will|would) you\b.*\b(fulfil+|meet|work (on ?site|in ?office|from (the )?office|in person)|commute|relocate|attend)\b.*\b(on ?site|in ?office|office|hybrid|in person|relocat\w*|requirement)\b|\brequires (the )?candidate to be present\b|\bbest describe\b.*\b(present|relocat\w*|based|location|live|reside)\b|\bpresent in\b.*\bbest describe\b/;
const TARGET_COUNTRIES = new Set(["IN", "DE", "JP"]);

function workPlace(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!PLACE_PREF_RE.test(label)) return null;
  if (/\b(react|frontend|backend|python|java|spring|skill)\b/.test(label) && !/\b(office|relocat|hybrid|on ?site)\b/.test(label)) return null;
  const named = countriesIn(label);
  const places = named.length > 0 ? named : [workCountry("", ctx.job) ?? "IN"];
  if (!places.some((c) => TARGET_COUNTRIES.has(c))) return fill(yesNoAction(field, false));
  const willing = factValue(ctx.facts, "relocation.willingness");
  if (typeof willing !== "boolean") return null;
  // Prefer a relocate / cannot-relocate row over yesNoAction: "I am already based…" starts with
  // "I am" and would otherwise win as Yes when the applicant lives elsewhere.
  return fill(relocationOption(field, willing) ?? yesNoAction(field, willing));
}

const CANNOT_MOVE_RE = /\b(cannot|can ?t|unable to|not willing to|unwilling to|won ?t) relocate\b/;

/** "No, however I am willing to relocate to Bengaluru" and its siblings, when the choices describe the move. */
function relocationOption(field: FieldDescriptor, willing: boolean): RecipeAction | null {
  const options = real(field.options);
  const wanted = options.find((o) => {
    const text = normalizeLabel(o);
    if (willing) return /\brelocat\w*\b/.test(text) && !CANNOT_MOVE_RE.test(text);
    return CANNOT_MOVE_RE.test(text);
  });
  return wanted ? pick(field, wanted) : null;
}

// ---------- Sponsorship ----------

const CURRENT_PLACE_RE =
  /\b(current (location|country)|where you (currently )?(live|reside)|remain in your|country of residence|where you are (currently )?(based|located))\b/;

function sponsorship(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!isWorkAuthLabel(field.label)) return null;
  const home = countryCode(ctx.profile.country) ?? "IN";
  const atHome: JobLocation = { country: home, location: null, remoteScope: null };
  const job = CURRENT_PLACE_RE.test(label) || !workCountry(field.label, ctx.job) ? atHome : ctx.job;
  const options = real(field.options);
  const probe = options.length > 0 ? field : { ...field, control: "radio" as const, options: ["Yes", "No"] };
  const action = answerWorkAuth(probe, job, home);
  if (!action || options.length > 0) return fill(action);
  const value = action.type === "option" ? action.value : null;
  if (!value) return null;
  return fill(field.control === "combobox" ? { type: "option", value } : { type: "literal", value });
}

// ---------- Hours and contracts ----------

const NIGHT_RE = /\b(night shifts?|24 ?x ?7|24 7|rotational shifts?|rotating shifts?|graveyard|on[- ]?call( rotations?)?)\b/;
const HOURS_RE =
  /\b(overlap|later hours|late hours|evening hours|time ?zones?|(us|est|pst|cet|uk|european|eastern|pacific) (business )?(hours|shift)|us shift|uk shift)\b/;
const CONTRACT_RE = /\b(contract(ual)?|fixed term|temporary|freelanc\w*)\b/;

/** Shifts, overlap hours and contracts of any length: the applicant takes them on. */
function hoursAndContract(field: FieldDescriptor, label: string): Standing | null {
  if (NIGHT_RE.test(label) || HOURS_RE.test(label)) return fill(yesNoAction(field, true));
  if (CONTRACT_RE.test(label) && /\b(comfortable|willing|open|okay|ok|fine|interested|accept)\b/.test(label)) {
    return fill(yesNoAction(field, true));
  }
  return null;
}

// ---------- Experience and skill levels ----------

function experienceBand(field: FieldDescriptor, ctx: ResolveContext): Standing | null {
  if (mapLabelToProfileKey({ label: field.label, control: "radio" }) !== "yearsOfExperience") return null;
  const years = Number(ctx.profile.yearsOfExperience);
  if (!(years > 0)) return null;
  const options = real(field.options);
  if (options.length === 0) return fill({ type: "literal", value: String(years) });
  const hits = options
    .map((o) => ({ o, r: parseRange(o) }))
    .filter((x) => x.r !== null && years >= x.r.min && years <= x.r.max)
    .sort((a, b) => b.r!.min - a.r!.min);
  return hits.length > 0 ? fill(pick(field, hits[0].o)) : null;
}

const LEVEL_RE =
  /\b(proficien\w*|experience level|level of (experience|expertise|proficiency|familiarity)|familiarity|how (well|comfortable|experienced)|rate your(self)?|expertise|best describ\w*|professional experience with)\b/;
const PERSONALLY_DONE_RE = /\bwhich of the following have you personally (done|built|used|worked)\b|\bhave you personally (done|built)\b/;
const STRONG_RE = /\b(expert|advanced|strong|hands on|production|extensive|proficient|professional|daily|regularly|significant|deep)\b/;
const WEAK_RE = /\b(none|never|theoretical|basic|beginner|limited|learning|no experience|only|not used|have not used|never used)\b/;
const OPPOSED_RE = /\b(opposed|against|refuse|avoid|prefer traditional|do not use|don t use|no ai)\b/;
const AI_CODING_RE = /\b(ai[ /-]?(llm|coding|code|assisted|pair|tools?)|llm solutions?|coding agents?|copilot|cursor|claude code|codex)\b/;
const AI_DAILY_RE = /\b(daily|every day|regularly|frequently|always|most (days|of)|multiple times|core part|power user)\b/;

/** Numbered scale options ("0", "5 - Expert") when every choice is a number. */
function ratingScale(options: string[]): Array<{ o: string; n: number }> | null {
  const offered = real(options);
  const scale = offered
    .map((o) => ({ o, n: /^\s*(\d+)\b/.exec(o)?.[1] }))
    .filter((x): x is { o: string; n: string } => x.n !== undefined)
    .map((x) => ({ o: x.o, n: Number(x.n) }));
  const isRating = scale.length >= 3 && scale.length === offered.length && !offered.some((o) => /\b(years?|months?)\b/i.test(o));
  return isRating ? scale : null;
}

/** The strongest level offered: the top of a numbered scale ("5 - Expert"), else the first worded strong. */
function strongest(options: string[]): string | null {
  const scale = ratingScale(options);
  if (scale) return scale.sort((a, b) => b.n - a.n)[0].o;
  const strong = real(options).filter((o) => STRONG_RE.test(normalizeLabel(o)) && !WEAK_RE.test(normalizeLabel(o)));
  return strong[0] ?? null;
}

function weakest(options: string[]): string | null {
  const scale = ratingScale(options);
  if (scale) return scale.sort((a, b) => a.n - b.n)[0].o;
  return real(options).find((o) => WEAK_RE.test(normalizeLabel(o)) || isExclusiveOption(o)) ?? null;
}

const SKILL_ASK_RE =
  /\b(strong|solid|deep|proven|hands on|professional) (expertise|experience|knowledge|background)\b|\b(experience|expertise|proficiency) (with|in|testing|using|building)\b|\bhave you (used|worked with|built with)\b/;

const MOBILE_ASK_RE = /\b(mobile (dev|development|apps?|feature)|android|ios|react native)\b/;

/** Later user facts on `experience.mobile_*` beat an old Yes saved from another form. */
function mobileExperience(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!MOBILE_ASK_RE.test(label)) return null;
  const facts = [...(ctx.facts?.byKey.entries() ?? [])].filter(([key, f]) => key.startsWith("experience.mobile_") && f.source === "user");
  if (facts.length === 0) return null;
  const yes = facts.some(([, f]) => f.value === true || (typeof f.value === "number" && Number(f.value) > 0));
  return fill(yesNoAction(field, yes));
}

/** A yes or no about a tool: yes for every skill except the ones never used (`isUnusedSkill`). */
function skillYesNo(field: FieldDescriptor, label: string): Standing | null {
  if (!SKILL_ASK_RE.test(label) || !yesNoOptions(real(field.options))) return null;
  return fill(yesNoAction(field, !namesUnusedSkill(field.label)));
}

const SPOKEN_RE = /\b(which|what) languages? (do|can) you (speak|know)\b|\blanguages? (you )?(speak|spoken)\b/;

/** English, plus any language the facts mark fluent or native. */
function spokenLanguages(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!SPOKEN_RE.test(label) || /\b(programming|coding|scripting)\b/.test(label)) return null;
  const spoken = new Set(["english"]);
  for (const f of ctx.facts?.facts ?? []) {
    const m = /^language\.([a-z]+)\.(fluent|level|proficiency)$/.exec(f.key);
    if (!m) continue;
    const v = normalizeLabel(String(f.value));
    if (f.value === true || /\b(native|bilingual|fluent|professional)\b/.test(v)) spoken.add(m[1]);
  }
  const options = real(field.options);
  if (options.length === 0) return field.control === "combobox" ? fill({ type: "option", value: "English" }) : null;
  const hits = options.filter((o) => spoken.has(normalizeLabel(o)));
  if (hits.length === 0) return null;
  return fill(field.control === "checkbox" ? { type: "options", values: hits } : { type: "option", value: hits[0] });
}

/** A spoken language other than English; with no level on file the applicant has none. */
const FOREIGN_LANGUAGE_RE =
  /\b(japanese|german|french|spanish|mandarin|chinese|cantonese|korean|portuguese|italian|dutch|polish|arabic|russian|turkish|swedish|norwegian|danish|finnish|hebrew|vietnamese|thai|indonesian|czech|greek)\b/;

function skillLevel(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  const options = real(field.options);
  if (options.length < 2) {
    if (LEVEL_RE.test(label) && (field.control === "combobox" || field.control === "select" || field.control === "radio")) {
      return fill({ type: "option", value: namesUnusedSkill(field.label) ? "none" : "production" });
    }
    return null;
  }
  if (PERSONALLY_DONE_RE.test(label) && field.control === "checkbox") {
    const hits = options.filter((o) => {
      const n = normalizeLabel(o);
      return !WEAK_RE.test(n) && !OPPOSED_RE.test(n) && !isExclusiveOption(o) && !namesUnusedSkill(o) && !/\bsap\b/i.test(n);
    });
    if (hits.length === 0) return null;
    const offered = options.filter((o) => !isExclusiveOption(o));
    // Ticking every box fails the pre-submit audit unless a complete fact list is behind it.
    const values = hits.length === offered.length && hits.length > 1 ? hits.slice(0, -1) : hits;
    return fill({ type: "options", values });
  }
  if (AI_CODING_RE.test(label)) {
    const daily = factValue(ctx.facts, "skill.ai_coding_tools.daily");
    if (daily !== true) return null;
    if (yesNoOptions(options) && !options.some((o) => AI_DAILY_RE.test(normalizeLabel(o)))) {
      return fill(yesNoAction(field, true));
    }
    const usable = options.filter((o) => !WEAK_RE.test(normalizeLabel(o)) && !OPPOSED_RE.test(normalizeLabel(o)));
    const dailyish = usable.filter((o) => AI_DAILY_RE.test(normalizeLabel(o)));
    const mid = /\b(experimented|occasionally|sometimes|tried|tinkered|small tasks)\b/;
    const solid = usable.filter((o) => !mid.test(normalizeLabel(o)));
    const ranked = dailyish.length > 0 ? dailyish : solid.length > 0 ? solid : usable;
    const option = strongest(ranked) ?? ranked[0] ?? null;
    return option ? fill(pick(field, option)) : null;
  }
  if (!LEVEL_RE.test(label) || yesNoOptions(options)) return null;
  const spoken = FOREIGN_LANGUAGE_RE.exec(label)?.[1];
  if (spoken) {
    const level = factValue(ctx.facts, `language.${spoken}.level`) ?? factValue(ctx.facts, `language.${spoken}.proficiency`);
    const known = typeof level === "string" && level.trim() ? matchOption(level, options) : null;
    if (known) return fill(pick(field, known));
    if (factValue(ctx.facts, `language.${spoken}.fluent`) === true) return null;
    const none = options.find((o) => WEAK_RE.test(normalizeLabel(o)) || isExclusiveOption(o));
    return none ? fill(pick(field, none)) : null;
  }
  if (namesUnusedSkill(field.label)) {
    const none = weakest(options);
    return none ? fill(pick(field, none)) : null;
  }
  const years = Number(ctx.profile.yearsOfExperience);
  const yearOptions = options.filter((o) => parseRange(o) && /\b(years?|yrs|months?)\b/i.test(o));
  if (years > 0 && yearOptions.length >= 1) {
    const fit = bucket(years, yearOptions);
    if (fit) return fill(pick(field, fit));
    const rest = options.filter(
      (o) => !yearOptions.includes(o) && !/\brather than\b|\bprimarily in (ai|ml|data science)\b|\bnot (a )?backend\b/i.test(normalizeLabel(o)),
    );
    if (rest.length === 0) return null;
    const fallback =
      strongest(rest) ??
      rest.filter((o) => !WEAK_RE.test(normalizeLabel(o)) && !OPPOSED_RE.test(normalizeLabel(o)) && !isExclusiveOption(o)).at(-1) ??
      null;
    return fallback ? fill(pick(field, fallback)) : null;
  }
  const option =
    strongest(options) ??
    options.filter((o) => !WEAK_RE.test(normalizeLabel(o)) && !OPPOSED_RE.test(normalizeLabel(o)) && !isExclusiveOption(o)).at(-1) ??
    null;
  return option ? fill(pick(field, option)) : null;
}

// ---------- Self-identification ----------

const GENDER_RE = /^(gender|sex)$|\bgender( identity)?\b|\bwhat is your sex\b/;
const PRONOUN_RE = /\bpronouns?\b/;
const OTHER_DEMO_RE = /\b(race|racial|ethnic\w*|hispanic|latin[oax]|veteran|military|disabilit\w*|sexual orientation|transgender|lgbt\w*|religio\w*|caste|marital)\b/;
const DECLINE_RE = /\b(decline|prefer not|rather not|do not wish|don t wish|not to (say|answer|disclose)|choose not)\b/;

function selfId(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  const options = real(field.options);
  if (options.length === 0) return null;
  const pronouns = normalizeLabel(String(factValue(ctx.facts, "profile.pronouns") ?? ""));
  const he = /^he\b/.test(pronouns);
  if (GENDER_RE.test(label) && he) {
    const male = options.find((o) => /\b(male|man)\b/.test(normalizeLabel(o)));
    if (male) return fill(pick(field, male));
  }
  if (/\bsalutation\b|\bname title\b|\bprefix\b/.test(label) && !/\b(job title|current title|position title)\b/.test(label)) {
    if (he) {
      const mr = options.find((o) => /^(mr|mr\.)$/.test(normalizeLabel(o)));
      if (mr) return fill(pick(field, mr));
    }
  }
  if (PRONOUN_RE.test(label) && he) {
    const him = options.find((o) => /\bhe\b.*\bhim\b/.test(normalizeLabel(o)));
    if (him) return fill(pick(field, him));
  }
  if (!GENDER_RE.test(label) && !PRONOUN_RE.test(label) && !OTHER_DEMO_RE.test(label)) return null;
  const decline = options.find((o) => DECLINE_RE.test(normalizeLabel(o)));
  if (decline) return fill(pick(field, decline));
  if (/\bveteran|military\b/.test(label)) {
    const not = options.find((o) => /\b(not a (protected )?veteran|i am not|no military)\b/.test(normalizeLabel(o)));
    if (not) return fill(pick(field, not));
    // An Indian civilian: "Are you a veteran?" is a plain no.
    if (/\b(are|have) you\b/.test(label) && yesNoOptions(options)) return fill(yesNoAction(field, false));
  }
  if (/\b(hispanic|latin[oax])\b/.test(label)) return fill(yesNoAction(field, false));
  return null;
}

// ---------- Date of birth ----------

const DOB_RE = /\b(date of birth|birth ?date|\bdob\b|born on|birthday)\b/;

function dateOfBirth(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!DOB_RE.test(label)) return null;
  const value = String(factValue(ctx.facts, "profile.date_of_birth") ?? "").trim();
  if (!value) return { kind: "park", reason: "Date of birth is not on file" };
  if (real(field.options).length > 0) return null;
  return fill({ type: "literal", value });
}

// ---------- Current pay ----------

const CURRENT_PAY_RE = /\bcurrent (fixed |annual |base |total )*(ctc|salary|compensation|pay)\b/;

function currentPay(field: FieldDescriptor, label: string, ctx: ResolveContext): Standing | null {
  if (!CURRENT_PAY_RE.test(label) || real(field.options).length > 0) return null;
  const inr = /\b(inr|ctc|lpa|lakhs?|rupees?)\b|₹/i.test(field.label) || workCountry("", ctx.job) === "IN";
  const value = factValue(ctx.facts, "profile.current_salary_inr");
  if (!inr || value == null) return null;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  const figure = /\blakhs?\b/i.test(field.label) && n > 0 ? String(Math.round(n / 100_000)) : String(value);
  return fill({ type: "literal", value: figure });
}

// ---------- Answers that outrank saved ones ----------

const START_DATE_RE =
  /\b(start date|starting date|joining date|date of joining|availability date|date (of )?availability|date available|available (to )?(start|join)( date)?|earliest (possible )?(start|joining|available)( date)?|when (are|would|will) you (be )?(available|able) to (start|join)|when can you (start|join)|when could you (start|join)|when are you available)\b/;
const OWN_HISTORY_RE = /\b(education|employment|school|degree|universit\w*|college|current (job|role|position|employer)|previous|last (job|role)|job history)\b/;
/** Notice, start and joining dates are settled after an offer; a week out is the standing answer. */
export const START_LEAD_DAYS = 7;

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The start date given on forms: a week from `now`. */
export function availableFrom(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + START_LEAD_DAYS);
  return d;
}

function availability(field: FieldDescriptor, label: string, now: Date): RecipeAction | null {
  if (!START_DATE_RE.test(label) || OWN_HISTORY_RE.test(label) || field.label.includes(" — ")) return null;
  const date = availableFrom(now);
  const options = real(field.options);
  if (options.length === 0) {
    if (field.control === "text" || field.control === "textarea") return { type: "literal", value: isoDate(date) };
    return null;
  }
  if (yesNoOptions(options)) return null;
  const notice = noticeOption(options, START_LEAD_DAYS);
  if (notice) return pick(field, notice);
  const month = String(date.getMonth() + 1);
  return monthYearAction(field, month, String(date.getFullYear()), "both") ?? monthYearAction(field, month, String(date.getFullYear()), "month");
}

const TZ_RE = /\btime ?zones?\b|\btz\b/;
const TZ_HOME_RE = /\b(asia\w*|india\w*|ist|apac|gmt ?\+ ?5(30)?|utc ?\+ ?5(30)?)\b/;
const TZ_AWAY_RE = /\b(europe\w*|emea|cet|cest|gmt|bst|uk|british|americas?|american|usa|us (based|time)|north america|latam|est|edt|pst|pdt|cst|mst|pacific|eastern|central|mountain)\b/;

/** "Are you in a European time zone?" is where you are; IST is neither Europe nor the Americas. */
function timeZone(field: FieldDescriptor, label: string): RecipeAction | null {
  if (!TZ_RE.test(label) || !/\b(are|do) you\b/.test(label)) return null;
  if (/\b(willing|able|comfortable|open|overlap|available|work (from|in|during|across))\b/.test(label)) return null;
  if (TZ_HOME_RE.test(label)) return yesNoAction(field, true);
  if (TZ_AWAY_RE.test(label)) return yesNoAction(field, false);
  return null;
}

const CONTACT_RE =
  /\bhow (should|can|could|do|would|may) (we|you like us to|you prefer us to) (communicate|contact|reach)\b|\b(preferred|best) (method|mode|way|channel|means) (of|for|to) (communication|contact|reach)\w*|\bpreferred contact method\b|\bcontact preferences?\b|\bcommunication preferences?\b/;

function contactChannel(field: FieldDescriptor, label: string): RecipeAction | null {
  if (!CONTACT_RE.test(label)) return null;
  const email = real(field.options).find((o) => /\be ?mail\b/.test(normalizeLabel(o)));
  return email ? pick(field, email) : null;
}

const SOCIAL_RE = /^(twitter|x)( (twitter|x))?( (url|profile|handle|link|account))?$|^other (website|url|link|profile)s?( url)?$/;

/** No Twitter or extra site on file: a profile URL from another box there reads as a mistake. */
function extraLinks(field: FieldDescriptor, label: string): RecipeAction | null {
  if (field.required || real(field.options).length > 0) return null;
  return SOCIAL_RE.test(label) ? { type: "skip" } : null;
}

const NONCOMPETE_RE = /\bnon[- ]compet\w*\b|\bnon[- ]solicitation\b|\brestrictive covenant\b/;
const LICENSE_RE = /\b(active or expired )?(professional )?(license|licence)\b/;
const DATE_SIGNED_RE = /\b(application )?date signed\b|\bdate of (application|signature)\b/;

/** No non-compete, no professional license; today's date for an application-signed box. */
/** iCIMS phone "Type" is Home / Mobile / Work; email "Type" is Personal / Work. */
function phoneType(field: FieldDescriptor, label: string): Standing | null {
  if (!/^type$/.test(label) && !/\b(phone|mobile|number|email|e-?mail) type\b/.test(label)) return null;
  const options = real(field.options);
  if (options.length === 0) return fill({ type: "option", value: "Mobile" });
  const named = (re: RegExp) => options.find((o) => re.test(normalizeLabel(o)));
  const pickNamed =
    named(/\bpersonal (mobile|cell)\b/) ??
    named(/\b(mobile|cell|cellular)\b/) ??
    named(/\bpersonal\b/) ??
    named(/\bhome\b/) ??
    named(/\bwork\b/) ??
    named(/\bother\b/);
  return pickNamed ? fill(pick(field, pickNamed)) : null;
}

function legalStatus(field: FieldDescriptor, label: string, now: Date): Standing | null {
  if (NONCOMPETE_RE.test(label) || (LICENSE_RE.test(label) && /\b(hold|have|do you)\b/.test(label))) {
    return fill(yesNoAction(field, false));
  }
  if (!DATE_SIGNED_RE.test(label) || real(field.options).length > 0) return null;
  return field.control === "text" || field.control === "textarea" ? fill({ type: "literal", value: isoDate(now) }) : null;
}

/**
 * Answers that win over saved recipes: the start date, time zone, contact channel and links on
 * file. A saved answer from another form cannot know today's date or which channels this one lists.
 */
export function firstAnswer(field: FieldDescriptor, now: Date = new Date()): RecipeAction | null {
  const label = normalizeLabel(field.label);
  return availability(field, label, now) ?? timeZone(field, label) ?? contactChannel(field, label) ?? extraLinks(field, label);
}

/**
 * The standing answer for one question, a reason to leave the job for you, or null when none
 * applies. Runs only where saved answers and the fact path found nothing.
 */
export function standingAnswer(field: FieldDescriptor, ctx: ResolveContext): Standing | null {
  const label = normalizeLabel(field.label);
  const options = real(field.options);
  if (field.control === "checkbox" && options.length === 1 && isExclusiveOption(options[0])) {
    return { kind: "park", reason: `Only "${options[0]}" was read for: ${field.label.slice(0, 80)}` };
  }
  return (
    signature(field, label, ctx) ??
    pdfResumeConfirm(field, label) ??
    consent(field, label) ??
    sponsorship(field, label, ctx) ??
    employerFollowUp(field, label, ctx.company) ??
    employerTies(field, label, ctx.company) ??
    joinWindow(field, label, ctx) ??
    hoursAndContract(field, label) ??
    workPlace(field, label, ctx) ??
    residence(field, label, ctx) ??
    homePlace(field, label, ctx) ??
    ageAndDrive(field, label) ??
    usPerson(field, label, ctx) ??
    dateOfBirth(field, label, ctx) ??
    currentPay(field, label, ctx) ??
    experienceBand(field, ctx) ??
    skillLevel(field, label, ctx) ??
    mobileExperience(field, label, ctx) ??
    skillYesNo(field, label) ??
    spokenLanguages(field, label, ctx) ??
    selfId(field, label, ctx) ??
    phoneType(field, label) ??
    legalStatus(field, label, new Date())
  );
}
