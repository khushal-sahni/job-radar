import fs from "node:fs";
import path from "node:path";

/** Recent filled forms kept for a human to skim for wrong answers. */
export const REVIEW_DIR = ".cache/apply-reviews";
export const REVIEW_KEEP = 5;
/** Every form actually sent, newest 50, for a periodic review (`docs/prompts/review-submissions.md`). */
export const SUBMISSIONS_DIR = ".cache/apply-submissions";
export const SUBMISSIONS_KEEP = 50;

export interface ReviewAnswer {
  label: string;
  value: string;
  /** prefilled (extension or resume upload), saved answer, rule, cheap model, strong model, your answer, asked you, not filled */
  source: string;
}

export interface ReviewSample {
  taskId: string;
  company: string;
  title: string;
  vendor: string;
  url: string;
  outcome: string;
  answers: ReviewAnswer[];
  at: Date;
}

export interface SampleFile {
  file: string;
  vendor: string;
  taskId: string;
  at: number;
}

const SOURCE_NAMES: Record<string, string> = {
  recipe: "saved answer",
  heuristic: "rule",
  cheap_model: "cheap model",
  strong_model: "strong model",
  user: "your answer",
  fact: "known fact",
};

export function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source;
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** `20261008-051200--ashby--<taskId>.md` */
export function sampleFileName(sample: Pick<ReviewSample, "at" | "vendor" | "taskId">): string {
  return `${stamp(sample.at)}--${sample.vendor}--${sample.taskId}.md`;
}

export function parseSampleFile(file: string): SampleFile | null {
  const m = file.match(/^(\d{8})-(\d{6})--([a-z]+)--(.+)\.md$/);
  if (!m) return null;
  const [, d, t, vendor, taskId] = m;
  const at = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
  return { file, vendor, taskId, at };
}

/**
 * Files to delete so `keep` remain: the oldest file of the vendor with the most samples,
 * or the oldest overall once every vendor appears once.
 */
export function samplesToDrop(files: SampleFile[], keep = REVIEW_KEEP): string[] {
  const left = [...files].sort((a, b) => a.at - b.at);
  const drop: string[] = [];
  while (left.length > keep) {
    const counts = new Map<string, number>();
    for (const f of left) counts.set(f.vendor, (counts.get(f.vendor) ?? 0) + 1);
    const most = Math.max(...counts.values());
    const victim = most > 1 ? left.find((f) => counts.get(f.vendor) === most)! : left[0];
    drop.push(victim.file);
    left.splice(left.indexOf(victim), 1);
  }
  return drop;
}

export function reviewMarkdown(sample: ReviewSample): string {
  const lines = [
    `# ${sample.company}: ${sample.title}`,
    "",
    `- Outcome: ${sample.outcome}`,
    `- Vendor: ${sample.vendor}`,
    `- When: ${sample.at.toISOString().replace("T", " ").replace(/\..*$/, "")} UTC`,
    `- URL: ${sample.url}`,
    "",
  ];
  for (const a of sample.answers) {
    lines.push(`**${a.label.replace(/\s+/g, " ").trim()}**`);
    lines.push(`${a.value ? a.value.replace(/\s+/g, " ").trim() : "(empty)"} _(${a.source})_`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Writes one sample (replacing an older one for the same task) and prunes to the newest diverse five. */
export function saveReviewSample(root: string, sample: ReviewSample): string | null {
  if (sample.answers.length === 0) return null;
  const dir = path.join(root, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs
    .readdirSync(dir)
    .map(parseSampleFile)
    .filter((f): f is SampleFile => f !== null);
  for (const f of existing.filter((e) => e.taskId === sample.taskId)) fs.rmSync(path.join(dir, f.file), { force: true });

  const file = sampleFileName(sample);
  fs.writeFileSync(path.join(dir, file), reviewMarkdown(sample));
  const current = [
    ...existing.filter((e) => e.taskId !== sample.taskId),
    parseSampleFile(file)!,
  ];
  for (const f of samplesToDrop(current)) fs.rmSync(path.join(dir, f), { force: true });
  return path.join(dir, file);
}

/** Files beyond the newest `keep`, oldest first. */
export function oldestBeyond(files: SampleFile[], keep = SUBMISSIONS_KEEP): string[] {
  return [...files].sort((a, b) => b.at - a.at).slice(keep).map((f) => f.file);
}

/** Writes one sent form and keeps the newest fifty. */
export function saveSubmission(root: string, sample: ReviewSample): string | null {
  if (sample.answers.length === 0) return null;
  const dir = path.join(root, SUBMISSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = sampleFileName(sample);
  fs.writeFileSync(path.join(dir, file), reviewMarkdown(sample));
  const all = fs
    .readdirSync(dir)
    .map(parseSampleFile)
    .filter((f): f is SampleFile => f !== null);
  for (const f of oldestBeyond(all)) fs.rmSync(path.join(dir, f), { force: true });
  return path.join(dir, file);
}
