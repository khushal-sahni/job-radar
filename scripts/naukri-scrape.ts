/**
 * Paced Naukri browse (one tab in the Naukri Chrome) → enrich → upsert.
 *
 * Usage:
 *   npm run naukri:scrape
 *   npm run naukri:scrape -- --max=20 --minutes=8
 *
 * Also runs at the end of `npm run ingest:daily` (skip with --skip-naukri).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

loadEnv({ path: path.join(PROJECT_ROOT, ".env") });

function log(message: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

function numberArg(name: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const n = Number(arg.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  const { ingestNaukri } = await import("../src/lib/naukri-ingest");
  const result = await ingestNaukri({
    maxNewJobs: numberArg("max"),
    maxMinutes: numberArg("minutes"),
    log,
  });

  log(
    `Naukri done — new ${result.fetched}, upserted ${result.upserted}, keyword-skipped ${result.keywordSkipped}, skipped ${result.skipped}, refreshed ${result.refreshed}, deactivated ${result.deactivated}, errors ${result.errors.length}`,
  );
  if (result.blocked) log(`Stopped early: ${result.blocked}`);
  for (const err of result.errors.slice(0, 20)) log(`  error: ${err}`);
  process.exit(0);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
