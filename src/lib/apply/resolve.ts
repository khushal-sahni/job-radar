import { chooseOption } from "./choose-option";
import type { ResolveContext } from "./context";
import { emptyFactSheet, isExclusiveOption, isOtherOption, isUnusedSkill, projectFact, skillYears, yesNoOptions, type Fact, type FactSheet } from "./facts";
import { blockAction, blockPart, graduationYearMismatch, isCurrentJob } from "./form-sections";
import { fieldKeys, isCompanySpecific, normalizeLabel, type FieldKeys } from "./fingerprint";
import { OFFICE_CITY_LABEL, englishLabel } from "./german";
import { identityAnswer, identityKind } from "./identity";
import { parseInstructions } from "./instructions";
import {
  HEARD_ABOUT_ANSWER,
  affirmativeOption,
  affirmativeOptions,
  consentOption,
  isAcknowledgementLabel,
  isHeardAboutLabel,
  isLinkQuestion,
  isMiddleNameLabel,
  isUnaskedExtra,
  knownOption,
  mapLabelToProfileKey,
  middleNameAction,
  isResidenceStateLabel,
  matchOption,
  residenceState,
} from "./profile-map";
import { recordFactQuestion, recordQuestion } from "./question-store";
import { findRecipe, saveRecipe } from "./recipe-store";
import { classifyQuestions } from "./classify";
import type {
  Classification,
  FactType,
  FieldDescriptor,
  ProfileValues,
  RecipeAction,
  RecipeSourceName,
} from "./types";
import { firstAnswer, noticeDays, noticeOption, standingAnswer, yesNoAction } from "./standing";
import { isSensitiveLabel } from "./validate";
import { writeAnswer } from "./written";
import {
  answerWorkAuth,
  countryCode,
  describeJobLocation,
  expectedSalaryFor,
  isOfficeQuestion,
  isWorkAuthLabel,
  jobCity,
  jobCityWithCountry,
  workPlaceChoice,
} from "./work-auth";

/** A fact the modal asks once; the answer then fills every form that asks the same thing. */
export interface FactAsk {
  key: string;
  question: string;
  type: FactType;
}

export type FillSource = RecipeSourceName | "recipe" | "fact";

export type Resolution =
  /** `grounds` are the fact ids the answer rests on; empty for profile, rules and saved answers. */
  | { kind: "fill"; action: RecipeAction; source: FillSource; keys: FieldKeys; grounds?: string[] }
  | { kind: "skip"; keys: FieldKeys }
  | { kind: "ask"; reason: string; keys: FieldKeys; field: FieldDescriptor; fact?: FactAsk }
  /** A written answer the models could not ground; the job goes to "needs a look", never the modal. */
  | { kind: "park"; reason: string; keys: FieldKeys }
  /** Rules and saved answers do not settle it; the caller classifies the batch and resolves again. */
  | { kind: "classify"; keys: FieldKeys; field: FieldDescriptor }
  /** The form rules the applicant out (its location list has no India, Germany or Japan); the task fails. */
  | { kind: "ineligible"; reason: string; keys: FieldKeys };

const EMPLOYER_ASK_REASON = "question about this employer";
const WORK_AUTH_ASK_REASON = "work authorization for this location";
const SALARY_ASK_REASON = "expected salary for this country";
/** Asked once per place and reused for every job there, even when the form names the company. */
const PLACE_ASK_REASONS = new Set([WORK_AUTH_ASK_REASON, SALARY_ASK_REASON]);

const PREFERRED_NAME_RE = /\b(have|use) a preferred name\b|^preferred name\??$/i;
const DECLINE_RE = /\b(decline|prefer not|rather not|do not wish|don t wish|not to (say|answer|disclose)|choose not)\b/;

/** The country whose currency a salary label names (INR / CTC / LPA, EUR, JPY, USD), or null. */
export function salaryCurrency(label: string): "IN" | "DE" | "JP" | "US" | null {
  if (/\b(inr|ctc|lpa|lakhs?|rupees?)\b|₹/i.test(label)) return "IN";
  if (/\b(eur|euros?)\b|€/i.test(label)) return "DE";
  if (/\b(jpy|yen)\b|¥/i.test(label)) return "JP";
  if (/\b(usd|us dollars?|dollars?)\b|\$/i.test(label)) return "US";
  return null;
}

const MONTHLY_RE = /\b(monthly|per month|a month|each month|month(ly)? salary)\b|\/ ?(month|mo)\b/i;
const LAKHS_RE = /\blakhs?\b/i;

/** Salary figures on file are yearly rupees; a monthly box gets a twelfth and a lakhs box gets / 100000. */
export function salaryForLabel(label: string, yearly: string): string {
  const n = Number(yearly.replace(/[,\s]/g, ""));
  if (!(n > 0)) return yearly;
  if (MONTHLY_RE.test(label)) return String(Math.round(n / 12));
  if (LAKHS_RE.test(label)) return String(Math.round(n / 100_000));
  return yearly;
}

/** Model picks of choice answers were guesses without facts; only written answers and your own count. */
function trustedRecipe(source: RecipeSourceName, action: RecipeAction): boolean {
  return source === "user" || source === "heuristic" || action.type === "compose";
}

/** A profile recipe saved under an older label rule ("mobile feature" read as phone) no longer applies. */
const PROFILE_LINK_FACT_RE = /^profile\.(linkedinurl|githuburl|portfoliourl)$/;

export function staleProfileRecipe(action: RecipeAction, field: FieldDescriptor, profile: ProfileValues): boolean {
  if (action.type === "profile") return mapLabelToProfileKey(field) !== action.key;
  const text = action.type === "literal" ? action.value : action.type === "compose" ? action.text : null;
  const links = [profile.linkedInUrl, profile.githubUrl, profile.portfolioUrl].filter(Boolean);
  if (text && /^https?:\/\//i.test(text.trim())) {
    const key = mapLabelToProfileKey(field);
    const linkBox = key === "linkedInUrl" || key === "githubUrl" || key === "portfolioUrl";
    if (!linkBox || yesNoOptions(field.options) || isLinkQuestion(field.label)) return true;
  }
  return text !== null && isLinkQuestion(field.label) && links.includes(text.trim());
}

/** A leftover on the page that is not an answer to this question — overwrite it. */
export function staleShownValue(field: FieldDescriptor, value: string, profile: ProfileValues): boolean {
  const shown = value.trim();
  if (!shown) return false;
  if (/^https?:\/\//i.test(shown)) {
    return staleProfileRecipe({ type: "literal", value: shown }, field, profile);
  }
  if (mapLabelToProfileKey(field) === "noticePeriod") {
    if (field.options.length > 0) return !field.options.some((o) => normalizeLabel(o) === normalizeLabel(shown));
    if (field.control === "select" || field.control === "combobox" || field.control === "radio") {
      return /^(0|immediate)$/i.test(shown);
    }
  }
  return false;
}

function fieldFor(raw: FieldDescriptor): { field: FieldDescriptor; instruction: RecipeAction | null } {
  const label = englishLabel(raw.label);
  const instructions = parseInstructions(label, raw.control, raw.options);
  return { field: { ...raw, label: instructions.cleanedLabel || label }, instruction: instructions.action };
}

/** The fact a classification points at, or for one tool, a complete list of tools that settles it. */
function lookupFact(c: Classification, facts: FactSheet): Fact | undefined {
  if (!c.factKey) return undefined;
  const direct = facts.byKey.get(c.factKey);
  if (direct) return direct;
  const skill = /^skill\.([a-z0-9_]+)\.(professional|years)$/.exec(c.factKey);
  if (!skill) return undefined;
  // No answer on file for this skill: the standing rule (0 for unused skills, else total years) is the fact.
  const total = facts.byKey.get("experience.total_years");
  const unused = isUnusedSkill(skill[1]) || isUnusedSkill(c.item ?? "");
  const name = c.item ?? skill[1].replace(/_/g, " ");
  if (skill[2] === "years") {
    const value = unused ? 0 : skillYears(skill[1], Number(total?.value ?? 0));
    return { id: total?.id ?? "f0", key: c.factKey, question: `Years of experience with ${name}`, type: "number", value, complete: false, source: "settings", evidence: "Standing skill years" };
  }
  return { id: total?.id ?? "f0", key: c.factKey, question: `Have you used ${name} professionally?`, type: "boolean", value: !unused, complete: false, source: "settings", evidence: "Standing skill use" };
}

function factAsk(c: Classification, field: FieldDescriptor): FactAsk | undefined {
  if (!c.factKey) return undefined;
  return { key: c.factKey, question: c.question ?? field.label, type: c.type ?? "text" };
}

async function fromFact(field: FieldDescriptor, c: Classification, keys: FieldKeys, ctx: ResolveContext): Promise<Resolution> {
  const facts = ctx.facts ?? emptyFactSheet();
  if (!c.factKey) return { kind: "ask", reason: "not tied to a fact", keys, field };
  if (PROFILE_LINK_FACT_RE.test(c.factKey) && isLinkQuestion(field.label)) {
    if (field.freeText) return fromClassification(field, { kind: "written", factKey: null }, keys, ctx);
    return { kind: "park", reason: `A question about your work, not a profile link: ${field.label.slice(0, 80)}`, keys };
  }
  if (c.employer) {
    // "Worked here before?" is a yes/no about this company against a list of companies; any other shape is this form's own.
    if (!yesNoOptions(field.options)) return { kind: "ask", reason: EMPLOYER_ASK_REASON, keys, field };
    c = { ...c, item: ctx.company };
  }
  let fact = lookupFact(c, facts);
  if (c.employer && fact && fact.type !== "list") fact = undefined;
  const projection = projectFact(fact, field, c);
  if (projection.kind === "answer") {
    return { kind: "fill", action: projection.action, source: "fact", keys, grounds: [projection.fact.id] };
  }
  if (projection.kind === "pick") {
    const choice = await chooseOption({ label: field.label, query: projection.value, wanted: projection.value, options: field.options, ctx });
    if (choice) return { kind: "fill", action: { type: "option", value: choice.option }, source: "fact", keys, grounds: [projection.fact.id] };
    return { kind: "ask", reason: `no choice fits ${projection.fact.key}`, keys, field };
  }
  // Missing, or a list known only in part: ask the fact once. A known fact the choices cannot express: ask this form.
  if (!fact || (fact.type === "list" && !fact.complete) || fact.key !== c.factKey) {
    return { kind: "ask", reason: projection.why, keys, field, fact: factAsk(c, field) };
  }
  return { kind: "ask", reason: projection.why, keys, field };
}

async function fromClassification(
  field: FieldDescriptor,
  c: Classification,
  keys: FieldKeys,
  ctx: ResolveContext,
): Promise<Resolution> {
  switch (c.kind) {
    case "written": {
      if (!field.freeText) return fromFact(field, { ...c, kind: "fact" }, keys, ctx);
      const written = await writeAnswer(field, {
        company: ctx.company,
        jobTitle: ctx.jobTitle,
        jobDescription: ctx.jobDescription,
        facts: ctx.facts ?? emptyFactSheet(),
        voiceSamples: ctx.voiceSamples,
        log: ctx.log,
      });
      if ("park" in written) return { kind: "park", reason: written.park, keys };
      await saveRecipe({ keys, label: field.label, action: written.action, source: written.source, model: written.model });
      return { kind: "fill", action: written.action, source: written.source, keys, grounds: written.uses };
    }
    case "consent": {
      const values = affirmativeOptions(field);
      if (values.length === 0)
        return {
          kind: "park",
          reason: `Acknowledgement with no affirmative choice: ${field.label.slice(0, 80)} (${field.control}; ${field.options.slice(0, 4).join(" | ").slice(0, 100)})`,
          keys,
        };
      const action: RecipeAction =
        field.control === "checkbox" ? { type: "options", values } : { type: "option", value: values[0] };
      return { kind: "fill", action, source: "heuristic", keys };
    }
    case "demographic": {
      const fact = lookupFact(c, ctx.facts ?? emptyFactSheet());
      if (fact) return fromFact(field, c, keys, ctx);
      const decline = field.options.find((o) => DECLINE_RE.test(normalizeLabel(o)) || (isExclusiveOption(o) && /not|decline/i.test(o)));
      if (decline) {
        const action: RecipeAction = field.control === "checkbox" ? { type: "options", values: [decline] } : { type: "option", value: decline };
        return { kind: "fill", action, source: "heuristic", keys };
      }
      return fromFact(field, c, keys, ctx);
    }
    case "instruction":
      return { kind: "ask", reason: "instruction in the label not understood", keys, field };
    case "fact":
    case "preference":
    case "derived":
      return fromFact(field, c, keys, ctx);
  }
}

/**
 * Decide how to fill one unfilled required field. Rules first (label instructions, the job's
 * place and salary, your saved answers, the profile, consent); then, with the question classified,
 * a fact projected onto the control, a grounded written answer, or one question to you.
 * Without a classification it returns `classify` so the caller can classify the page in one call.
 * A question only this employer would ask is never put to you: it parks instead.
 */
export async function resolveField(
  raw: FieldDescriptor,
  ctx: ResolveContext,
  classification?: Classification,
): Promise<Resolution> {
  const res = await resolveOne(raw, ctx, classification);
  const { field, instruction } = fieldFor(raw);
  if (!instruction && identityKind(field) && (res.kind === "ask" || res.kind === "park" || res.kind === "classify")) {
    return res;
  }
  const standing = instruction ? null : standingAnswer(field, ctx);
  if (standing?.kind === "ineligible") return { kind: "ineligible", reason: standing.reason, keys: res.keys };
  if (standing?.kind === "skip") return { kind: "skip", keys: res.keys };
  if (standing?.kind === "fill") {
    return { kind: "fill", action: standing.action, source: "heuristic", keys: res.keys };
  }
  if (standing?.kind === "park" && (res.kind === "ask" || res.kind === "park" || res.kind === "classify")) {
    return { kind: "park", reason: standing.reason, keys: res.keys };
  }
  return parkUnreadableList(parkFormAsk(parkCompanyAsk(res, ctx.company)), ctx.facts);
}

/**
 * A list question needs choices to tick: the form's own checkboxes or what is already on file.
 * With neither, the modal would offer only "None of these", so the job parks instead.
 */
export function parkUnreadableList(res: Resolution, facts: FactSheet | undefined): Resolution {
  if (res.kind !== "ask" || res.fact?.type !== "list") return res;
  const offered = res.field.control === "checkbox" ? res.field.options.filter((o) => !isExclusiveOption(o) && !isOtherOption(o)) : [];
  const known = facts?.byKey.get(res.fact.key);
  const onFile = known?.type === "list" && Array.isArray(known.value) ? known.value : [];
  if (offered.length > 0 || onFile.length > 0) return res;
  return { kind: "park", reason: `${UNREADABLE_CHOICES_REASON} ${res.field.label.slice(0, 80)}`, keys: res.keys };
}

/**
 * The modal only collects facts that answer later forms. A question tied to no fact (this
 * form's own wording, a block entry not on file) leaves the job under "needs a look" instead.
 */
export function parkFormAsk(res: Resolution): Resolution {
  if (res.kind !== "ask" || res.fact || PLACE_ASK_REASONS.has(res.reason)) return res;
  return { kind: "park", reason: `No standing answer for: ${res.field.label.slice(0, 80)}`, keys: res.keys };
}

/** An ask whose wording is about this employer becomes a park; facts for later jobs stay asks. */
const YES_NO_ASK_RE = /^(have|has|did|do|are|is|were|was|will) you\b/;

export function parkCompanyAsk(res: Resolution, company: string): Resolution {
  if (res.kind !== "ask" || PLACE_ASK_REASONS.has(res.reason)) return res;
  const shown = res.fact?.question ?? res.field.label;
  if (res.reason === EMPLOYER_ASK_REASON || isCompanySpecific(shown, company)) {
    const action = YES_NO_ASK_RE.test(normalizeLabel(shown)) ? yesNoAction(res.field, false) : null;
    if (action) return { kind: "fill", action, source: "heuristic", keys: res.keys };
    return { kind: "park", reason: `Question only ${company} asks: ${shown.slice(0, 80)}`, keys: res.keys };
  }
  return res;
}

async function resolveOne(
  raw: FieldDescriptor,
  ctx: ResolveContext,
  classification?: Classification,
): Promise<Resolution> {
  const { field, instruction } = fieldFor(raw);
  const keys = fieldKeys({
    vendor: ctx.vendor,
    control: field.control,
    label: field.label,
    options: field.options,
    company: ctx.company,
  });

  if (instruction?.type === "skip") return { kind: "skip", keys };
  // Workday's "I have a preferred name" box opens extra name fields; the legal name is the one used.
  if (!instruction && field.control === "checkbox" && PREFERRED_NAME_RE.test(field.label)) return { kind: "skip", keys };

  // Before saved answers and any model: a saved pick of another country is never replayed.
  const identity = instruction ? null : identityKind(field);
  if (identity) {
    const answer = identityAnswer(field, identity, ctx.profile.country);
    if ("park" in answer) return { kind: "park", reason: answer.park, keys };
    return { kind: "fill", action: answer.action, source: "heuristic", keys };
  }

  if (!instruction && isResidenceStateLabel(field.label) && field.options.length > 0) {
    const state = residenceState(ctx.profile.location);
    if (!state || !matchOption(state, field.options)) {
      return { kind: "ineligible", reason: `State list has no Indian state: ${field.options.slice(0, 6).join(", ")}`, keys };
    }
  }

  if (!instruction) {
    const place = workPlaceChoice(field);
    if (place === null) {
      return { kind: "ineligible", reason: `Location list has no India, Germany or Japan: ${field.options.slice(0, 6).join(", ")}`, keys };
    }
    if (place) {
      // Later questions on this form (visa, salary, office city) answer for the place picked here.
      ctx.job = { country: place.country, location: place.place, remoteScope: null };
      return { kind: "fill", action: { type: "option", value: place.place }, source: "heuristic", keys };
    }
  }

  // The answer depends on where the job is: derive it, and scope any user answer to that place.
  if (!instruction && isWorkAuthLabel(field.label)) {
    const home = countryCode(ctx.profile.country) ?? "IN";
    const action = answerWorkAuth(field, ctx.job, home);
    if (action) return { kind: "fill", action, source: "heuristic", keys };
    const where = describeJobLocation(ctx.job);
    const placeKeys = fieldKeys({
      vendor: ctx.vendor,
      control: field.control,
      label: `${field.label} @ ${where ?? ctx.company}`,
      options: field.options,
      company: ctx.company,
    });
    const answered = await findRecipe(placeKeys);
    if (answered && answered.action.type !== "skip") {
      return { kind: "fill", action: answered.action, source: "recipe", keys: placeKeys };
    }
    const shown = {
      ...field,
      label: `${field.label} (${where ? `job in ${where}` : "job location not listed"})`,
    };
    return { kind: "ask", reason: WORK_AUTH_ASK_REASON, keys: placeKeys, field: shown };
  }

  // Per-job facts: never saved as recipes, so another job's city or currency is not replayed.
  if (!instruction && (normalizeLabel(field.label) === normalizeLabel(OFFICE_CITY_LABEL) || isOfficeQuestion(field.label))) {
    const city = field.control === "combobox" ? jobCityWithCountry(ctx.job) : jobCity(ctx.job);
    const value = city && (field.options.length === 0 ? city : matchOption(city, field.options));
    if (value) {
      const action: RecipeAction = field.options.length === 0 ? { type: "literal", value } : { type: "option", value };
      return { kind: "fill", action, source: "heuristic", keys };
    }
  }
  if (!instruction && mapLabelToProfileKey(field) === "expectedCtc") {
    const currency = salaryCurrency(field.label);
    const salary = currency
      ? { country: currency, value: currency === "IN" ? ctx.profile.expectedCtc || null : String(ctx.salaryFloors?.[currency] ?? "") || null }
      : expectedSalaryFor(ctx.job, ctx.salaryFloors ?? {}, ctx.profile.expectedCtc);
    // A country with no figure of its own, asked without a currency, gets the US dollar figure, labelled.
    const usd = ctx.salaryFloors?.US;
    if (!currency && salary.country && !salary.value && usd) salary.value = `${salaryForLabel(field.label, String(usd))} USD`;
    else if (salary.value) salary.value = salaryForLabel(field.label, salary.value);
    if (currency === "IN" && salary.value) {
      // A rupee question takes the rupee figure whatever the job's country; a saved USD answer never lands here.
      const value = field.options.length === 0 ? salary.value : matchOption(salary.value, field.options);
      if (value) {
        const yearly = value === ctx.profile.expectedCtc;
        const action: RecipeAction =
          field.options.length > 0 ? { type: "option", value } : yearly ? { type: "profile", key: "expectedCtc" } : { type: "literal", value };
        return { kind: "fill", action, source: "heuristic", keys };
      }
    }
    if (salary.country && salary.country !== "IN") {
      const value = salary.value && (field.options.length === 0 ? salary.value : matchOption(salary.value, field.options));
      if (value) {
        const action: RecipeAction = field.options.length === 0 ? { type: "literal", value } : { type: "option", value };
        return { kind: "fill", action, source: "heuristic", keys };
      }
      const placeKeys = fieldKeys({
        vendor: ctx.vendor,
        control: field.control,
        label: `${field.label} @ ${salary.country}`,
        options: field.options,
        company: ctx.company,
      });
      const answered = await findRecipe(placeKeys);
      if (answered && answered.action.type !== "skip") {
        return { kind: "fill", action: answered.action, source: "recipe", keys: placeKeys };
      }
      const shown = { ...field, label: `${field.label} (job in ${salary.country}, local currency)` };
      return { kind: "ask", reason: SALARY_ASK_REASON, keys: placeKeys, field: shown };
    }
  }

  // Facts on file and standing choices beat saved answers: a recipe from another form put the phone
  // in "Phone Extension", a model's résumé blurb in "Role Description" and "Ambition Box" as the source.
  if (!instruction && isUnaskedExtra(field.label)) return { kind: "skip", keys };
  if (!instruction && isMiddleNameLabel(field.label)) {
    const action = middleNameAction(field);
    return action ? { kind: "fill", action, source: "heuristic", keys } : { kind: "skip", keys };
  }
  const blockFill = !instruction && blockPart(field.label) ? blockAction(field) : null;
  if (blockFill?.type === "skip") return { kind: "skip", keys };
  if (blockFill) return { kind: "fill", action: blockFill, source: "heuristic", keys };
  if (!instruction && isHeardAboutLabel(field.label)) {
    const known = knownOption(field);
    if (known) return { kind: "fill", action: { type: "option", value: known }, source: "heuristic", keys };
    // Ashby and similar comboboxes often list no options until opened; type LinkedIn.
    if (field.options.length === 0 && (field.control === "combobox" || field.control === "select")) {
      return { kind: "fill", action: { type: "option", value: HEARD_ABOUT_ANSWER }, source: "heuristic", keys };
    }
  }
  const placeKey = instruction || field.options.length === 0 ? null : mapLabelToProfileKey(field);
  if (placeKey === "location" || placeKey === "city") {
    const home = matchOption(ctx.profile.city, field.options) ?? matchOption(ctx.profile.location, field.options);
    if (home) return { kind: "fill", action: { type: "option", value: home }, source: "heuristic", keys };
  }
  const first = instruction ? null : firstAnswer(field);
  if (first?.type === "skip") return { kind: "skip", keys };
  if (first) return { kind: "fill", action: first, source: "heuristic", keys };

  const recipe = await findRecipe(keys);
  if (recipe && trustedRecipe(recipe.source, recipe.action) && !staleProfileRecipe(recipe.action, field, ctx.profile)) {
    if (recipe.action.type === "skip") return { kind: "skip", keys };
    return { kind: "fill", action: recipe.action, source: "recipe", keys };
  }

  // Education and employment entries not on file are yours to give.
  if (!instruction && blockPart(field.label)) {
    const mismatch = graduationYearMismatch(field);
    if (mismatch) return { kind: "park", reason: mismatch, keys };
    return { kind: "ask", reason: "education or employment detail not on file", keys, field };
  }

  const remember = async (action: RecipeAction): Promise<Resolution> => {
    await saveRecipe({ keys, label: field.label, action, source: "heuristic" });
    return { kind: "fill", action, source: "heuristic", keys };
  };

  if (instruction) return remember(instruction);

  const consent = consentOption(field);
  if (consent !== null) {
    return remember(field.control === "checkbox" ? { type: "options", values: [consent] } : { type: "option", value: consent });
  }
  if (isAcknowledgementLabel(field.label)) {
    return { kind: "park", reason: `Acknowledgement with no affirmative choice: ${field.label.slice(0, 80)}`, keys };
  }

  if (!isSensitiveLabel(field.label)) {
    const key = mapLabelToProfileKey(field);
    const composeInstead = key === "resumeSummary" && !ctx.profile.resumeSummary && field.freeText;
    if (key && !composeInstead) {
      const value = ctx.profile[key];
      if (!value) return { kind: "ask", reason: `profile field ${key} is empty`, keys, field };
      if (key === "noticePeriod" && (field.options.length > 0 || field.control === "select" || field.control === "combobox")) {
        const days = noticeDays(value);
        const option = (days !== null ? noticeOption(field.options, days) : null) ?? matchOption(value, field.options);
        if (option) return remember({ type: "option", value: option });
        if (field.options.length === 0) return remember({ type: "option", value: days === 0 ? "Immediate" : value });
      } else if (field.options.length === 0 || matchOption(value, field.options)) {
        return remember({ type: "profile", key });
      }
    }

    const known = knownOption(field);
    if (known) return remember({ type: "option", value: known });
    if (isHeardAboutLabel(field.label)) {
      if (field.control === "text" || field.control === "textarea") {
        return remember({ type: "literal", value: HEARD_ABOUT_ANSWER });
      }
      if (field.options.length === 0 && (field.control === "combobox" || field.control === "select")) {
        return remember({ type: "option", value: HEARD_ABOUT_ANSWER });
      }
      return { kind: "park", reason: `No LinkedIn, career-page or Other choice for: ${field.label.slice(0, 80)}`, keys };
    }
  }

  if (field.control === "checkbox" && /currently work here/.test(normalizeLabel(field.label))) {
    if (!isCurrentJob()) return { kind: "skip", keys };
    const option = field.options.find((o) => /currently work here/i.test(o)) ?? field.options[0];
    if (option) return { kind: "fill", action: { type: "options", values: [option] }, source: "heuristic", keys };
  }

  if (isResidenceStateLabel(field.label)) {
    const state = residenceState(ctx.profile.location);
    const value = state && (field.options.length === 0 ? state : matchOption(state, field.options));
    if (value) {
      return remember(field.options.length === 0 ? { type: "literal", value } : { type: "option", value });
    }
    if (field.options.length > 0) {
      return { kind: "ineligible", reason: `State list has no Indian state: ${field.options.slice(0, 6).join(", ")}`, keys };
    }
  }

  if (!classification) return { kind: "classify", keys, field };
  return fromClassification(field, classification, keys, ctx);
}

/**
 * Resolves a page of fields: rules first, then one classify call for every question the rules
 * left open, then each of those from its classification. Keyed by field id.
 */
export async function resolveFields(fields: FieldDescriptor[], ctx: ResolveContext): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  const pending: FieldDescriptor[] = [];
  for (const f of fields) {
    const res = await resolveField(f, ctx);
    if (res.kind === "classify") pending.push(f);
    else out.set(f.id, res);
  }
  if (pending.length === 0) return out;
  const classes = await classifyQuestions(
    pending.map((f) => fieldFor(f).field),
    { company: ctx.company, facts: ctx.facts ?? emptyFactSheet(), log: ctx.log },
  );
  for (const f of pending) {
    out.set(f.id, await resolveField(f, ctx, classes.get(f.id) ?? { kind: "fact", factKey: null }));
  }
  return out;
}

export const UNREADABLE_CHOICES_REASON = "Could not read the choices for:";

/**
 * Puts an ask in the modal: a fact question once for every form, or this form's own question.
 * Returns a park reason instead when there is nothing real to show.
 */
export async function recordAsk(
  taskId: string,
  res: Extract<Resolution, { kind: "ask" }>,
  ctx: Pick<ResolveContext, "facts">,
): Promise<string | null> {
  if (!res.fact) {
    await recordQuestion(taskId, res.keys, res.field);
    return null;
  }
  const known = ctx.facts?.byKey.get(res.fact.key);
  const saved = await recordFactQuestion(taskId, res.fact, res.field, known?.type === "list" ? (known.value as string[]) : []);
  return saved ? null : `${UNREADABLE_CHOICES_REASON} ${res.field.label.slice(0, 80)}`;
}

/** Concrete value to type or pick for an action. */
export function valueForAction(action: RecipeAction, profile: ProfileValues): string | string[] | null {
  switch (action.type) {
    case "profile":
      return profile[action.key] || null;
    case "option":
    case "literal":
      return action.value;
    case "compose":
      return action.text;
    case "options":
      return action.values;
    case "skip":
      return null;
  }
}
