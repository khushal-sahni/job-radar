import { db } from "@/lib/db";
import { saveFact } from "./fact-store";
import { coerceFactValue, isExclusiveOption, isFactType, isOtherOption } from "./facts";
import type { FieldKeys } from "./fingerprint";
import { matchOption } from "./profile-map";
import { saveRecipe } from "./recipe-store";
import type { FactType, FieldDescriptor, RecipeAction } from "./types";

/** Open questions stored for a later chat ask, then turned into facts or recipes. */

/** Parks a form-specific question for the modal (a choice no known fact can express). */
export async function recordQuestion(taskId: string, keys: FieldKeys, field: FieldDescriptor): Promise<void> {
  const data = {
    genericKey: keys.genericKey,
    prompt: field.label,
    control: field.control,
    options: field.options,
    required: field.required,
    maxLength: field.maxLength,
    factKey: null,
    factType: null,
  };
  await db.applyQuestion.upsert({
    where: { taskId_fingerprint: { taskId, fingerprint: keys.fingerprint } },
    create: { taskId, fingerprint: keys.fingerprint, ...data },
    // Asked again means the saved answer no longer fills it.
    update: { ...data, answer: null, answeredAt: null },
  });
}

/** Offered on every list question so "none of them" is an answer, not a blank. */
export const NONE_OF_THESE = "None of these";

export function factFingerprint(key: string): string {
  return `fact:${key}`;
}

/**
 * Parks a fact question: one row per fact however many forms word it, asked in neutral words.
 * Lists offer every choice any waiting form showed, plus what is already known.
 * Returns false, saving nothing, when a list has no real choice to offer.
 */
export async function recordFactQuestion(
  taskId: string,
  fact: { key: string; question: string; type: FactType },
  field: FieldDescriptor,
  known: string[] = [],
): Promise<boolean> {
  const fingerprint = factFingerprint(fact.key);
  let control = "text";
  let options: string[] = [];
  if (fact.type === "boolean") {
    control = "radio";
    options = ["Yes", "No"];
  } else if (fact.type === "list") {
    control = "checkbox";
    const open = await db.applyQuestion.findMany({ where: { fingerprint, answer: null }, select: { options: true } });
    const seen = new Map<string, string>();
    const offered = field.control === "checkbox" && (field.multi || field.options.length > 1) ? field.options : [];
    for (const o of [...known, ...open.flatMap((r) => r.options), ...offered]) {
      const k = o.trim().toLowerCase();
      if (k && !seen.has(k)) seen.set(k, o.trim());
    }
    options = [...seen.values()].filter((o) => !isExclusiveOption(o) && !isOtherOption(o)).slice(0, 59);
    if (options.length === 0) return false;
    options.push(NONE_OF_THESE);
  } else if (fact.type === "text" && field.options.length > 0) {
    control = "select";
    options = field.options;
  }
  const data = {
    genericKey: fingerprint,
    prompt: fact.question,
    control,
    options,
    required: true,
    maxLength: fact.type === "number" ? 20 : null,
    factKey: fact.key,
    factType: fact.type,
  };
  await db.applyQuestion.upsert({
    where: { taskId_fingerprint: { taskId, fingerprint } },
    create: { taskId, fingerprint, ...data },
    update: { ...data, answer: null, answeredAt: null },
  });
  if (fact.type === "list") await db.applyQuestion.updateMany({ where: { fingerprint, answer: null }, data: { options } });
  return true;
}

export async function clearOpenQuestions(taskId: string): Promise<void> {
  await db.applyQuestion.deleteMany({ where: { taskId, answer: null } });
}

function answerToAction(
  answer: string,
  question: { control: string; options: string[] },
): RecipeAction | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;
  if (question.control === "checkbox" && question.options.length > 0) {
    const values = trimmed
      .split("\n")
      .map((v) => matchOption(v, question.options))
      .filter((v): v is string => Boolean(v));
    return values.length > 0 ? { type: "options", values } : null;
  }
  if (question.options.length > 0) {
    const option = matchOption(trimmed, question.options);
    return option ? { type: "option", value: option } : null;
  }
  return { type: "literal", value: trimmed };
}

/** A modal answer as a fact value. Lists come one item per line; "None" and "Other" are not items. */
export function answerToFactValue(answer: string, type: FactType): unknown {
  if (type === "list") {
    return answer
      .split("\n")
      .map((v) => v.trim())
      .filter((v) => v && !isExclusiveOption(v) && !isOtherOption(v));
  }
  return answer.trim();
}

/**
 * Fact questions become facts (yours, never overwritten by the resume); form-specific ones
 * become recipes. Either way every open question with that fingerprint is marked answered.
 */
export async function saveAnswers(
  answers: Array<{ fingerprint: string; answer: string; complete?: boolean }>,
): Promise<{ saved: number; rejected: string[] }> {
  let saved = 0;
  const rejected: string[] = [];

  for (const { fingerprint, answer, complete } of answers) {
    const question = await db.applyQuestion.findFirst({
      where: { fingerprint, answer: null, task: { status: "NEEDS_ANSWER" } },
      orderBy: { createdAt: "asc" },
    });
    if (!question) {
      rejected.push(fingerprint);
      continue;
    }

    if (question.factKey && isFactType(question.factType)) {
      let value: unknown = answerToFactValue(answer, question.factType);
      // A list answer adds to what is on file; items are removed in Settings.
      if (question.factType === "list") {
        const existing = await db.applicantFact.findUnique({ where: { key: question.factKey } });
        const kept = existing?.type === "list" ? ((coerceFactValue("list", existing.value) as string[] | null) ?? []) : [];
        value = [...kept, ...(value as string[])];
      }
      const stored = await saveFact({
        key: question.factKey,
        question: question.prompt,
        type: question.factType,
        value,
        complete: complete ?? true,
        source: "user",
        evidence: "Your answer",
      });
      if (stored === null) {
        rejected.push(fingerprint);
        continue;
      }
    } else {
      const action = answerToAction(answer, question);
      if (!action) {
        rejected.push(fingerprint);
        continue;
      }
      await saveRecipe({
        keys: { fingerprint, genericKey: question.genericKey },
        label: question.prompt,
        action,
        source: "user",
      });
    }
    await db.applyQuestion.updateMany({
      where: { fingerprint, answer: null },
      data: { answer: answer.trim(), answeredAt: new Date() },
    });
    saved += 1;
  }

  return { saved, rejected };
}
