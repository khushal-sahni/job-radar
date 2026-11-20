/**
 * One-off move to fact-grounded autofill:
 * 1. Deletes model-made choice and short-text recipes (guesses without facts). Dropdown picks ("label @ query") stay.
 * 2. Claim-checks model-written answers against the fact sheet and deletes the ones that do not hold.
 * 3. Turns your saved answers into facts where the question asks one (classify call), never overwriting a fact.
 * 4. Lists submitted applications whose log shows a deleted or model answer, so you can follow up.
 * 5. Re-queues jobs held for answers or failed on fill/reject, with their open questions cleared.
 *
 * Usage: npx tsx scripts/apply-facts-migrate.ts [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(PROJECT_ROOT, ".env") });

interface LogTask {
  header: string;
  fills: Array<{ source: string; label: string }>;
  outcome: string;
}

/** Tasks in the run log: the `[i/n] Company: Title (vendor)` header, its fills, and its outcome. */
function parseRunLog(file: string): LogTask[] {
  if (!fs.existsSync(file)) return [];
  const tasks: LogTask[] = [];
  let current: LogTask | null = null;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/^\[[^\]]+\]\s?/, "");
    const header = /^\[\d+\/\d+\]\s+(.*)$/.exec(line);
    if (header) {
      current = { header: header[1], fills: [], outcome: "" };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const fill = /^\s+filled \[([a-z_]+)\] (.*)$/.exec(line);
    if (fill) current.fills.push({ source: fill[1], label: fill[2].trim() });
    const outcome = /^\s+→ (\S+)/.exec(line);
    if (outcome) current.outcome = outcome[1].replace(/:$/, "");
  }
  return tasks;
}

async function main(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  const dryRun = process.argv.includes("--dry-run");
  const { db } = await import("../src/lib/db");
  const { buildFactSheet } = await import("../src/lib/apply/facts");
  const { listStoredFacts, saveFact } = await import("../src/lib/apply/fact-store");
  const { reviewAnswer } = await import("../src/lib/apply/written");
  const { classifyQuestions } = await import("../src/lib/apply/classify");
  const { normalizeLabel } = await import("../src/lib/apply/fingerprint");
  const { buildProfileValues } = await import("../src/lib/apply/profile-map");
  const { getUserProfile } = await import("../src/lib/profile");
  const { getPreferences } = await import("../src/lib/preferences");
  const { latestResumeText } = await import("../src/lib/apply/recipe-store");
  const { isWorkAuthLabel } = await import("../src/lib/apply/work-auth");
  const { blockPart } = await import("../src/lib/apply/form-sections");
  type RecipeAction = import("../src/lib/apply/types").RecipeAction;

  const [profile, prefs, resumeText] = await Promise.all([getUserProfile(), getPreferences(), latestResumeText()]);
  const profileValues = buildProfileValues(profile, prefs.yearsOfExperience);
  const sheet = buildFactSheet({ profile: profileValues, stored: await listStoredFacts(), resumeText });

  // 1 + 2: model recipes.
  const modelRows = await db.fieldRecipe.findMany({ where: { source: { in: ["cheap_model", "strong_model"] } } });
  const deleted: Array<{ id: string; label: string; why: string }> = [];
  for (const row of modelRows) {
    const action = row.action as unknown as RecipeAction;
    if (row.label.includes(" @ ")) continue;
    if (action.type !== "compose") {
      deleted.push({ id: row.id, label: row.label, why: `model ${action.type} without a fact` });
      continue;
    }
    try {
      const bad = (await reviewAnswer(row.label, action.text, sheet.facts, { title: "", company: "" })).unsupported;
      if (bad.length > 0) deleted.push({ id: row.id, label: row.label, why: `unsupported: ${bad.join("; ").slice(0, 120)}` });
    } catch (err) {
      console.log(`  claim check failed for "${row.label.slice(0, 60)}": ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nModel recipes: ${modelRows.length}, deleting ${deleted.length}`);
  for (const d of deleted) console.log(`  - ${d.label.slice(0, 80)}  (${d.why})`);
  if (!dryRun && deleted.length > 0) await db.fieldRecipe.deleteMany({ where: { id: { in: deleted.map((d) => d.id) } } });

  // 3: your answers to facts.
  const userRows = (await db.fieldRecipe.findMany({ where: { source: "user" } })).filter((r) => !r.label.includes(" @ "));
  const fields = userRows.map((r) => {
    const action = r.action as unknown as RecipeAction;
    const options = action.type === "options" ? action.values : action.type === "option" ? [action.value] : [];
    return {
      id: r.id,
      label: r.label,
      control: action.type === "options" ? ("checkbox" as const) : action.type === "option" ? ("radio" as const) : ("text" as const),
      options: action.type === "option" && /^(yes|no)$/i.test(action.value) ? ["Yes", "No"] : options,
      required: true,
      maxLength: null,
      freeText: action.type === "literal" || action.type === "compose",
      multi: action.type === "options",
    };
  });
  const classes = fields.length > 0 ? await classifyQuestions(fields, { company: "", facts: sheet, log: (m) => console.log(m) }) : new Map();
  type Candidate = { key: string; question: string; type: "boolean" | "text" | "number" | "list"; value: string | string[]; label: string };
  const byKey = new Map<string, Candidate[]>();
  console.log(`\nYour saved answers: ${userRows.length}`);
  for (const row of userRows) {
    const c = classes.get(row.id);
    if (!c?.factKey || !c.type || c.employer || !["fact", "preference", "demographic", "derived"].includes(c.kind)) continue;
    // Work authorization depends on where the job is; those answers stay scoped to their place.
    // Education and employment entries are filled per block, never from a fact.
    if (isWorkAuthLabel(row.label) || blockPart(row.label) || sheet.byKey.has(c.factKey)) continue;
    const action = row.action as unknown as RecipeAction;
    const value =
      action.type === "options" ? action.values : action.type === "option" ? action.value : action.type === "literal" ? action.value : null;
    if (value === null) continue;
    // One saved pick says nothing about the rest of a list; "80k" or "35 LPA" is text, not a number.
    let type = c.type;
    if (type === "list" && !Array.isArray(value)) type = "text";
    if (type === "number" && (Array.isArray(value) || !/^\d+(\.\d+)?$/.test(value.trim()))) type = "text";
    const list = byKey.get(c.factKey) ?? [];
    list.push({ key: c.factKey, question: c.question ?? row.label, type, value, label: row.label });
    byKey.set(c.factKey, list);
  }
  let converted = 0;
  for (const [key, candidates] of byKey) {
    const values = new Set(candidates.map((x) => normalizeLabel(JSON.stringify(x.value))));
    if (values.size > 1) {
      console.log(`  ? ${key}: your answers differ (${candidates.map((x) => JSON.stringify(x.value)).join(" vs ")}); left to ask`);
      continue;
    }
    const first = candidates[0];
    console.log(`  + ${key} (${first.type}) = ${JSON.stringify(first.value)}   from "${first.label.slice(0, 60)}"`);
    if (dryRun) continue;
    const stored = await saveFact({
      key,
      question: first.question,
      type: first.type,
      value: first.value,
      complete: false,
      source: "user",
      evidence: `Your answer to "${first.label.slice(0, 120)}"`,
    });
    if (stored !== null) converted += 1;
  }
  console.log(`  ${converted} saved as facts${dryRun ? " (dry run)" : ""}`);

  // 4: submitted applications that used a deleted or model answer.
  const deletedLabels = new Set(deleted.map((d) => normalizeLabel(d.label.slice(0, 70))));
  const tasks = parseRunLog(path.join(PROJECT_ROOT, ".cache/apply-run.log"));
  const flagged = tasks
    .filter((t) => t.outcome === "SUBMITTED")
    .map((t) => ({
      header: t.header,
      fills: t.fills.filter(
        (f) =>
          f.source === "cheap_model" ||
          f.source === "strong_model" ||
          (f.source === "recipe" && [...deletedLabels].some((l) => l && normalizeLabel(f.label).startsWith(l.slice(0, 50)))),
      ),
    }))
    .filter((t) => t.fills.length > 0);
  console.log(`\nSubmitted applications with a model or deleted answer: ${flagged.length}`);
  for (const t of flagged) {
    console.log(`  ${t.header}`);
    for (const f of t.fills) console.log(`      [${f.source}] ${f.label}`);
  }

  // 5: re-queue.
  const stuck = await db.applyTask.findMany({
    where: {
      OR: [
        { status: "NEEDS_ANSWER" },
        { status: "NEEDS_YOU", lastError: { startsWith: "Form rejected" } },
        { status: "NEEDS_YOU", lastError: { startsWith: "Could not fill" } },
      ],
    },
    select: { id: true, status: true },
  });
  console.log(`\nRe-queueing ${stuck.length} task(s)${dryRun ? " (dry run)" : ""}`);
  if (!dryRun && stuck.length > 0) {
    const ids = stuck.map((t) => t.id);
    await db.applyQuestion.deleteMany({ where: { taskId: { in: ids }, answer: null } });
    await db.applyTask.updateMany({ where: { id: { in: ids } }, data: { status: "QUEUED", attempts: 0, lastError: null } });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
