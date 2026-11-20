import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { FieldKeys } from "./fingerprint";
import type { RecipeAction, RecipeSourceName } from "./types";

/** Saved answers to form questions (recipes), keyed by question fingerprint. */

export interface StoredRecipe {
  id: string;
  label: string;
  action: RecipeAction;
  source: RecipeSourceName;
}

function toStored(row: {
  id: string;
  label: string;
  action: Prisma.JsonValue;
  source: string;
}): StoredRecipe {
  return {
    id: row.id,
    label: row.label,
    action: row.action as unknown as RecipeAction,
    source: row.source as RecipeSourceName,
  };
}

/** Exact vendor fingerprint first, then the same question seen on another vendor (user answers win). */
export async function findRecipe(keys: FieldKeys): Promise<StoredRecipe | null> {
  const exact = await db.fieldRecipe.findUnique({ where: { fingerprint: keys.fingerprint } });
  const row =
    exact ??
    (await db.fieldRecipe.findFirst({
      where: { genericKey: keys.genericKey },
      orderBy: [{ source: "desc" }, { updatedAt: "desc" }],
    }));
  if (!row) return null;
  await db.fieldRecipe.update({ where: { id: row.id }, data: { uses: { increment: 1 } } });
  return toStored(row);
}

export async function saveRecipe(input: {
  keys: FieldKeys;
  label: string;
  action: RecipeAction;
  source: RecipeSourceName;
  model?: string | null;
}): Promise<void> {
  const data = {
    genericKey: input.keys.genericKey,
    label: input.label,
    action: input.action as unknown as Prisma.InputJsonValue,
    source: input.source,
    model: input.model ?? null,
  };
  await db.fieldRecipe.upsert({
    where: { fingerprint: input.keys.fingerprint },
    create: { fingerprint: input.keys.fingerprint, ...data },
    update: data,
  });
}

/** Saved user answers the model may point at instead of guessing. */
export async function listUserAnswers(limit = 40): Promise<StoredRecipe[]> {
  const rows = await db.fieldRecipe.findMany({
    where: { source: "user" },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  return rows.map(toStored);
}

/** Text of the most recently uploaded resume, or empty. */
export async function latestResumeText(): Promise<string> {
  const row = await db.resume.findFirst({ orderBy: { createdAt: "desc" }, select: { rawText: true } });
  return row?.rawText ?? "";
}

/** Text the user wrote themselves, used only as a tone sample for short written answers. */
export async function voiceSamples(resumeSummary: string): Promise<string[]> {
  const samples: string[] = [];
  if (resumeSummary.trim()) samples.push(resumeSummary.trim().slice(0, 800));
  const answers = await listUserAnswers(20);
  for (const a of answers) {
    if (a.action.type !== "literal") continue;
    if (a.action.value.trim().length < 40) continue;
    samples.push(a.action.value.trim().slice(0, 400));
    if (samples.length >= 4) break;
  }
  return samples;
}
