import { db } from "@/lib/db";
import { coerceFactValue } from "./facts";

/** What the feed's apply panel shows: open questions, parked jobs, and today's counts. */

export interface OpenQuestion {
  fingerprint: string;
  prompt: string;
  control: string;
  options: string[];
  maxLength: number | null;
  /** Set for fact questions; the answer becomes that fact. */
  factType: string | null;
  /** List facts: the items already known, shown ticked. */
  known: string[];
  jobs: Array<{ title: string; company: string }>;
}

export interface NeedsYouItem {
  taskId: string;
  title: string;
  company: string;
  url: string;
  reason: string;
  code: string | null;
  updatedAt: string;
}

export interface ApplyInbox {
  questions: OpenQuestion[];
  needsYou: NeedsYouItem[];
  counts: {
    queued: number;
    needsAnswer: number;
    needsYou: number;
    captcha: number;
    submittedToday: number;
  };
}

export async function getApplyInbox(startOfDay: Date): Promise<ApplyInbox> {
  const [openRows, needsYouRows, grouped, submittedToday] = await Promise.all([
    db.applyQuestion.findMany({
      where: { answer: null, task: { status: "NEEDS_ANSWER" } },
      include: { task: { include: { job: { select: { title: true, company: true } } } } },
      orderBy: { createdAt: "asc" },
    }),
    db.applyTask.findMany({
      where: { status: "NEEDS_YOU" },
      include: { job: { select: { title: true, company: true, url: true } } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    db.applyTask.groupBy({ by: ["status"], _count: { _all: true } }),
    db.applyTask.count({ where: { status: "SUBMITTED", submittedAt: { gte: startOfDay } } }),
  ]);

  const factKeys = [...new Set(openRows.map((r) => r.factKey).filter((k): k is string => Boolean(k)))];
  const knownRows = factKeys.length > 0 ? await db.applicantFact.findMany({ where: { key: { in: factKeys }, type: "list" } }) : [];
  const known = new Map(knownRows.map((r) => [r.key, (coerceFactValue("list", r.value) as string[] | null) ?? []]));

  const byFingerprint = new Map<string, OpenQuestion>();
  for (const row of openRows) {
    const existing = byFingerprint.get(row.fingerprint);
    const job = { title: row.task.job.title, company: row.task.job.company };
    if (existing) {
      existing.jobs.push(job);
      continue;
    }
    byFingerprint.set(row.fingerprint, {
      fingerprint: row.fingerprint,
      prompt: row.prompt,
      control: row.control,
      options: row.options,
      maxLength: row.maxLength,
      factType: row.factType,
      known: (row.factKey && known.get(row.factKey)) || [],
      jobs: [job],
    });
  }

  const count = (status: string): number =>
    grouped.find((g) => g.status === status)?._count._all ?? 0;

  return {
    questions: [...byFingerprint.values()],
    needsYou: needsYouRows.map((t) => ({
      taskId: t.id,
      title: t.job.title,
      company: t.job.company,
      url: t.job.url,
      reason: t.lastError ?? "Needs a look",
      code: t.code,
      updatedAt: t.updatedAt.toISOString(),
    })),
    counts: {
      queued: count("QUEUED"),
      needsAnswer: count("NEEDS_ANSWER"),
      needsYou: count("NEEDS_YOU"),
      captcha: needsYouRows.filter((t) => t.code === "captcha").length,
      submittedToday,
    },
  };
}
