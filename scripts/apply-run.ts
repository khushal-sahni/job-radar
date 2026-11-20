/**
 * Auto-apply runner: work the queue for one plan, one job at a time.
 *
 * Usage:
 *   npm run apply:run                          # the scheduled plan: enqueue + apply, unattended
 *   npm run apply:run -- --attended            # someone is here to solve captchas
 *   npm run apply:run -- --dry-run --max=2     # fill and check, never submit
 *   npm run apply:run -- --tasks=id1,id2 --no-enqueue
 *   npm run apply:run -- --fill --tasks=id1    # parked jobs: filled and left open, never sent
 *   npm run apply:run -- --naukri-login        # log the Naukri Chrome in and save the session
 *
 * Every run attaches to the app's own Chrome per profile (see src/lib/browser/manager.ts).
 * Also runs from `npm run ingest:daily` (skip with --skip-apply). LinkedIn is never opened.
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

async function naukriLogin(): Promise<boolean> {
  const { leaseBrowser } = await import("../src/lib/browser/manager");
  const { loginToNaukri } = await import("../src/lib/browser/naukri-session");
  const lease = await leaseBrowser("naukri", { root: PROJECT_ROOT, log });
  try {
    return (await loginToNaukri(lease, { root: PROJECT_ROOT, log })) === "ok";
  } finally {
    await lease.release();
  }
}

async function main(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  if (process.argv.includes("--naukri-login")) {
    process.exit((await naukriLogin()) ? 0 : 1);
  }
  const { planFromArgs } = await import("../src/lib/apply/plan");
  const { runApply } = await import("../src/lib/apply/run-loop");
  const summary = await runApply(planFromArgs(process.argv), { root: PROJECT_ROOT, log });

  if (summary.skippedReason) log(`Stopped early: ${summary.skippedReason}`);
  log(
    `Apply done — attempted ${summary.attempted}, submitted ${summary.submitted}, needs answer ${summary.needsAnswer}, needs you ${summary.needsYou}, failed ${summary.failed}, back in queue ${summary.requeued}${summary.ready ? `, dry-run ready ${summary.ready}` : ""}`,
  );
  process.exit(0);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
