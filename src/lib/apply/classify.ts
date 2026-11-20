import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { completeJson, isOutOfCredits } from "@/lib/openrouter";
import { isSubjectiveQuestion } from "./subjective";
import { isFactKey, isFactType, yesNoOptions, type FactSheet } from "./facts";
import { isCompanySpecific, normalizeLabel } from "./fingerprint";
import type { Classification, FactType, FieldDescriptor, QuestionKind } from "./types";

const KINDS: readonly QuestionKind[] = ["fact", "preference", "written", "demographic", "consent", "instruction", "derived"];
const FACT_KINDS: readonly QuestionKind[] = ["fact", "preference", "derived", "demographic"];

const SYSTEM_PROMPT = `You sort job application questions by what they ask. You never answer them and never see answers.
Reply with JSON only: {"questions":[{"n":<number>,"kind":"...","factKey":"...","question":"...","type":"...","item":"...","atLeast":<number>,"employer":<true or omit>}]}
kind:
- fact: something true about the applicant (tools used, years, education, eligibility, where they live, languages, notice period, certifications).
- preference: what the applicant wants (relocating, remote or office, start date, expected salary, shifts, travel).
- written: an open question that needs a few sentences (why this role, a project, motivation, cover letter).
- demographic: gender, race, ethnicity, veteran, disability, sexual orientation, age, pronouns.
- consent: agreeing to terms, privacy, data processing, being contacted, confirming the application is truthful.
- instruction: the label itself says what to type or pick, whoever the applicant is.
factKey (fact, preference, demographic only): one fact that settles the question for every company.
- Reuse a key from knownFacts when it asks the same thing in other words.
- Otherwise make one: lowercase dotted snake_case, 2 to 4 parts, never a company or product brand of the employer.
- One tool yes/no: skill.<name>.professional (boolean) with item = the tool. "Which of these have you used": a list key such as llm_providers.professional or cloud_providers.professional.
- "N+ years of X?": skill.<name>.years or experience.total_years (number) with atLeast = N.
- Ties to the employer asking (worked or contracted here before, relatives or friends working here, applied here before,
  government or competitor links to this company): a list of company names with "employer":true, for example
  employment.employers (every company you have worked at or for), relations.employers (companies where relatives or
  close friends work), applications.employers (companies applied to in the past year).
- New keys need question (asked once of the applicant as "you", no company name, e.g. "Which LLM providers have you used professionally?") and type: boolean, text, number or list.
Leave factKey null for written, consent and instruction.`;

export interface ClassifyContext {
  company: string;
  facts: FactSheet;
  log?: (message: string) => void;
}

/** Cache key: the question and its choices, scoped to the company when the wording names it. */
export function questionKey(field: Pick<FieldDescriptor, "label" | "options">, company: string): string {
  const options = field.options.map(normalizeLabel).filter(Boolean).sort().join("|");
  const scope = isCompanySpecific(field.label, company) ? normalizeLabel(company) : "";
  return createHash("sha1").update(`${normalizeLabel(field.label)}\u0001${options}\u0001${scope}`).digest("hex").slice(0, 24);
}

function isMultiChoice(field: FieldDescriptor): boolean {
  return field.control === "checkbox" && (field.multi || field.options.length > 1);
}

/** The type a new fact gets when the model did not say: from the shape of the control. */
function typeFromControl(field: FieldDescriptor): FactType {
  if (isMultiChoice(field)) return "list";
  if (yesNoOptions(field.options)) return "boolean";
  return "text";
}

interface RawItem {
  n?: unknown;
  kind?: unknown;
  factKey?: unknown;
  question?: unknown;
  type?: unknown;
  item?: unknown;
  atLeast?: unknown;
  employer?: unknown;
}

/** A model reply made safe: unknown kinds and malformed keys never get through. */
export function cleanClassification(raw: RawItem, field: FieldDescriptor, facts: FactSheet, model: string | null): Classification {
  const kind = KINDS.includes(raw.kind as QuestionKind) ? (raw.kind as QuestionKind) : "fact";
  const out: Classification = { kind, factKey: null, model };
  if (!FACT_KINDS.includes(kind) || !isFactKey(raw.factKey)) return out;
  out.factKey = raw.factKey;
  const known = facts.byKey.get(raw.factKey);
  out.type = known?.type ?? (isFactType(raw.type) ? raw.type : typeFromControl(field));
  // A yes/no, radio, select or combobox takes one answer; the model sometimes calls its choices a list.
  if (!known && out.type === "list" && raw.employer !== true && !isMultiChoice(field)) {
    out.type = yesNoOptions(field.options) ? "boolean" : "text";
  }
  out.question = known?.question ?? (typeof raw.question === "string" && raw.question.trim() ? raw.question.trim().slice(0, 200) : field.label);
  if (typeof raw.item === "string" && raw.item.trim() && !raw.item.includes("\n")) out.item = raw.item.trim().slice(0, 60);
  const atLeast = Number(raw.atLeast);
  if (raw.atLeast != null && Number.isFinite(atLeast)) out.atLeast = atLeast;
  if (raw.employer === true) {
    // The answer depends on who asks, so it can only come from a list of companies.
    out.employer = true;
    out.type = "list";
    delete out.item;
    if (!known) out.question = typeof raw.question === "string" && raw.question.trim() ? raw.question.trim().slice(0, 200) : field.label;
  }
  return out;
}

/** Without a model: open questions are written, everything else goes to you. Not cached. */
function fallback(field: FieldDescriptor): Classification {
  return isSubjectiveQuestion(field) ? { kind: "written", factKey: null } : { kind: "fact", factKey: null };
}

function fromRow(row: { kind: string; factKey: string | null; detail: Prisma.JsonValue; model: string | null }): Classification {
  const detail = (row.detail ?? {}) as Partial<Classification>;
  return { ...detail, kind: row.kind as QuestionKind, factKey: row.factKey, model: row.model };
}

/** Facts the classifier may point at. Background lines are prose for written answers, not keys. */
function knownFactLines(facts: FactSheet): string[] {
  return facts.facts.filter((f) => !f.key.startsWith("background.")).map((f) => `${f.key} (${f.type}): ${f.question}`);
}

/**
 * What each question asks, keyed by field id. Cached questions cost nothing; the rest go to
 * one cheap call for the whole batch, which sees fact keys and questions but no answers.
 */
export async function classifyQuestions(fields: FieldDescriptor[], ctx: ClassifyContext): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>();
  if (fields.length === 0) return out;
  const keyed = fields.map((f) => ({ field: f, key: questionKey(f, ctx.company) }));
  const rows = await db.questionMap.findMany({ where: { key: { in: keyed.map((k) => k.key) } } });
  const cached = new Map(rows.map((r) => [r.key, fromRow(r)]));

  const todo: typeof keyed = [];
  for (const k of keyed) {
    const hit = cached.get(k.key);
    if (hit) out.set(k.field.id, hit);
    else if (!todo.some((t) => t.key === k.key)) todo.push(k);
  }
  const fillDuplicates = () => {
    for (const k of keyed) {
      if (out.has(k.field.id)) continue;
      const same = keyed.find((o) => o.key === k.key && out.has(o.field.id));
      out.set(k.field.id, same ? out.get(same.field.id)! : fallback(k.field));
    }
  };
  const { getOpenRouterApiKey } = await import("@/lib/secrets");
  if (todo.length === 0 || !getOpenRouterApiKey()) {
    fillDuplicates();
    return out;
  }

  const prompt = JSON.stringify({
    knownFacts: knownFactLines(ctx.facts),
    questions: todo.map((t, i) => ({
      n: i + 1,
      label: t.field.label.slice(0, 400),
      control: t.field.multi ? "checkboxes (several may be ticked)" : t.field.control,
      ...(t.field.options.length > 0 ? { options: t.field.options.slice(0, 30) } : {}),
    })),
  });
  try {
    const res = await completeJson<{ questions?: RawItem[] }>({ tier: "cheap", system: SYSTEM_PROMPT, prompt, maxTokens: 120 + todo.length * 90 });
    const items = Array.isArray(res.data?.questions) ? res.data.questions : [];
    for (const [i, t] of todo.entries()) {
      const raw = items.find((it) => Number(it.n) === i + 1);
      if (!raw) continue;
      const c = cleanClassification(raw, t.field, ctx.facts, res.model);
      out.set(t.field.id, c);
      const { kind, factKey, model, ...detail } = c;
      const data = { label: t.field.label.slice(0, 500), kind, factKey, detail: detail as Prisma.InputJsonValue, model: model ?? null };
      await db.questionMap.upsert({ where: { key: t.key }, create: { key: t.key, ...data }, update: data });
    }
    ctx.log?.(`  classified ${todo.length} question(s) in one call`);
  } catch (err) {
    if (isOutOfCredits(err)) throw err;
    ctx.log?.(`  classify failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
  }
  fillDuplicates();
  return out;
}
