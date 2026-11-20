import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { coerceFactValue, isFactKey, isFactType, type StoredFact } from "./facts";
import type { FactType, FactValue } from "./types";

export interface FactRow extends StoredFact {
  updatedAt: string;
}

export async function listStoredFacts(): Promise<FactRow[]> {
  const rows = await db.applicantFact.findMany({ orderBy: [{ source: "asc" }, { key: "asc" }] });
  return rows.map((r) => ({
    key: r.key,
    question: r.question,
    type: r.type,
    value: r.value,
    complete: r.complete,
    source: r.source,
    evidence: r.evidence,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export interface FactInput {
  key: string;
  question: string;
  type: FactType;
  value: unknown;
  complete?: boolean;
  source: "resume" | "user" | "settings";
  evidence?: string | null;
}

/** Saves one fact after checking its key, type and value. Returns the stored value, or null when it does not fit. */
export async function saveFact(input: FactInput): Promise<FactValue | null> {
  if (!isFactKey(input.key) || !isFactType(input.type)) return null;
  const value = coerceFactValue(input.type, input.value);
  if (value === null) return null;
  const data = {
    question: input.question.trim().slice(0, 300) || input.key,
    type: input.type,
    value: value as unknown as Prisma.InputJsonValue,
    complete: input.type === "list" ? Boolean(input.complete) : false,
    source: input.source,
    evidence: input.evidence ?? null,
  };
  await db.applicantFact.upsert({ where: { key: input.key }, create: { key: input.key, ...data }, update: data });
  return value;
}

export type EditFactResult = { ok: true; value: FactValue } | { ok: false; error: "not_found" | "invalid"; type?: string };

/** Changes one saved fact's value from Settings. An edited fact is yours: the resume never overwrites it. */
export async function editFact(key: string, value: unknown, complete?: boolean): Promise<EditFactResult> {
  const row = await db.applicantFact.findUnique({ where: { key } });
  if (!row || !isFactType(row.type)) return { ok: false, error: "not_found" };
  const stored = await saveFact({
    key: row.key,
    question: row.question,
    type: row.type,
    value,
    complete: complete ?? row.complete,
    source: "user",
    evidence: "Edited in Settings",
  });
  return stored === null ? { ok: false, error: "invalid", type: row.type } : { ok: true, value: stored };
}

export async function deleteFact(key: string): Promise<boolean> {
  const res = await db.applicantFact.deleteMany({ where: { key } });
  return res.count > 0;
}

/**
 * Replaces resume-extracted facts with a new extraction. Your own answers are never overwritten,
 * and resume facts the new resume no longer states are removed.
 */
export async function replaceResumeFacts(facts: FactInput[]): Promise<{ saved: number; removed: number }> {
  const userKeys = new Set(
    (await db.applicantFact.findMany({ where: { source: { not: "resume" } }, select: { key: true } })).map((r) => r.key),
  );
  let saved = 0;
  const kept: string[] = [];
  for (const f of facts) {
    if (userKeys.has(f.key)) continue;
    if ((await saveFact({ ...f, source: "resume" })) !== null) {
      saved += 1;
      kept.push(f.key);
    }
  }
  const removed = await db.applicantFact.deleteMany({ where: { source: "resume", key: { notIn: kept } } });
  return { saved, removed: removed.count };
}
