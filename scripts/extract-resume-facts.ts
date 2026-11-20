/**
 * Reads facts from the stored resume into ApplicantFact (one strong-model call).
 * Each fact must quote the resume word for word; your own answers are never overwritten.
 *
 * Usage: npx tsx scripts/extract-resume-facts.ts [--dry-run]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(PROJECT_ROOT, ".env") });

async function main(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  const dryRun = process.argv.includes("--dry-run");
  const { latestResumeText } = await import("../src/lib/apply/recipe-store");
  const { extractResumeFacts } = await import("../src/lib/apply/resume-facts");
  const { replaceResumeFacts } = await import("../src/lib/apply/fact-store");

  const text = await latestResumeText();
  if (!text) throw new Error("No resume stored; upload one in the feed first");
  const facts = await extractResumeFacts(text);
  for (const f of facts) console.log(`${f.key} (${f.type}) = ${JSON.stringify(f.value)}   ${f.evidence}`);
  if (dryRun) {
    console.log(`${facts.length} facts (dry run, nothing saved)`);
    return;
  }
  const res = await replaceResumeFacts(facts);
  console.log(`${res.saved} saved, ${res.removed} old resume facts removed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
