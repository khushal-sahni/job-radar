/**
 * Daily job CLI — talks to Postgres directly (Next.js not required). Three steps (ingest,
 * Naukri browse, auto-apply), each tracked on its own in .cache/daily-state.json: a step runs
 * when it has not succeeded in 20h, and a failed step retries on the next hourly wake with backoff.
 *
 * Usage: npm run ingest:daily [-- --force] [--skip-ingest] [--skip-naukri] [--skip-apply]
 * Prefer the in-app schedule (Settings). Mac launchd install remains optional for power users.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const PG_WAIT_MS = 120_000;
const PG_RETRY_MS = 3_000;

loadEnv({ path: path.join(PROJECT_ROOT, ".env") });

function log(message: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

async function ensureDatabase(): Promise<void> {
  const {
    dockerComposeDir,
    ensureEmbeddedDatabase,
    hasExternalDatabaseUrl,
    isLocalDockerDatabaseUrl,
  } = await import("../src/lib/embedded-db");

  if (!hasExternalDatabaseUrl()) {
    log("Starting embedded database…");
    await ensureEmbeddedDatabase();
    return;
  }

  if (isLocalDockerDatabaseUrl()) {
    const composeDir = dockerComposeDir();
    if (composeDir) {
      log("Ensuring Postgres container is up…");
      const result = spawnSync("docker", ["compose", "up", "-d"], {
        cwd: composeDir,
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        const err = (result.stderr || result.stdout || "").trim();
        log(`docker compose up failed (continuing anyway): ${err || "unknown error"}`);
      }
    }
  }
}

async function waitForPostgres(): Promise<void> {
  const { Pool } = await import("pg");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const deadline = Date.now() + PG_WAIT_MS;
  let lastError = "unknown";

  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      log("Postgres is ready");
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await pool.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, PG_RETRY_MS));
    }
  }

  throw new Error(`Postgres not ready after ${PG_WAIT_MS / 1000}s: ${lastError}`);
}

type StepResult = { ok: boolean; summary: string };

async function runIngest(): Promise<StepResult> {
  const { ingestAllSources } = await import("../src/lib/ingest");
  const result = await ingestAllSources();
  const summary = `fetched ${result.fetched}, upserted ${result.upserted}, unchanged ${result.unchanged}, keyword-skipped ${result.keywordSkipped}, skipped ${result.skipped}, deactivated ${result.deactivated}, boards harvested ${result.boardsHarvested}, errors ${result.errors.length}`;
  for (const err of result.errors.slice(0, 20)) log(`  error: ${err}`);
  if (result.errors.length > 20) log(`  …and ${result.errors.length - 20} more`);
  const hardFailure =
    result.fetched === 0 &&
    result.errors.length > 0 &&
    Object.keys(result.bySource).length === 0;
  return hardFailure
    ? { ok: false, summary: "no sources returned jobs" }
    : { ok: true, summary };
}

async function runNaukri(): Promise<StepResult> {
  const { ingestNaukri } = await import("../src/lib/naukri-ingest");
  const naukri = await ingestNaukri({ log });
  for (const err of naukri.errors.slice(0, 10)) log(`  naukri error: ${err}`);
  const summary = `new ${naukri.fetched}, upserted ${naukri.upserted}, keyword-skipped ${naukri.keywordSkipped}, refreshed ${naukri.refreshed}, errors ${naukri.errors.length}`;
  return naukri.blocked
    ? { ok: false, summary: `stopped early: ${naukri.blocked}` }
    : { ok: true, summary };
}

async function runAutoApply(): Promise<StepResult> {
  const { runApply } = await import("../src/lib/apply/run-loop");
  const { SCHEDULED_PLAN } = await import("../src/lib/apply/plan");
  const apply = await runApply(SCHEDULED_PLAN, { root: PROJECT_ROOT, log });
  const summary = `queued ${apply.queued}, attempted ${apply.attempted}, submitted ${apply.submitted}, needs answer ${apply.needsAnswer}, needs you ${apply.needsYou}, failed ${apply.failed}`;
  if (apply.skippedReason && apply.skippedReason !== "daily submit cap reached") {
    return { ok: false, summary: `${apply.skippedReason} (${summary})` };
  }
  return { ok: true, summary };
}

async function main(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  const force = process.argv.includes("--force");
  const {
    DAILY_STEPS,
    isStepDue,
    readDailyState,
    recordStep,
    writeDailyState,
  } = await import("../src/lib/daily-state");

  await ensureDatabase();
  await waitForPostgres();

  const { ensureDb } = await import("../src/lib/db");
  await ensureDb();
  const { getPreferences } = await import("../src/lib/preferences");
  const prefs = await getPreferences();

  const skipApply =
    process.argv.includes("--skip-apply") ||
    (!force && !prefs.applyScheduleEnabled);
  const skipNaukri =
    process.argv.includes("--skip-naukri") ||
    (!force && !prefs.naukriEnabled);
  const skipIngest = process.argv.includes("--skip-ingest");

  if (!force && !prefs.findScheduleEnabled && !process.argv.includes("--force-steps")) {
    // Manual CLI still runs when invoked; preference gate is for scheduled wakes.
    // The in-app scheduler only launches this script when find is on.
  }

  const state = readDailyState(PROJECT_ROOT);
  const due = DAILY_STEPS.filter((step) => {
    if (step === "ingest" && skipIngest) return false;
    if (step === "naukri" && skipNaukri) return false;
    if (step === "apply" && skipApply) return false;
    return force || isStepDue(state[step], Date.now());
  });

  if (due.length === 0) {
    log(
      "Nothing due: every step succeeded recently, is waiting out a retry, or is turned off. Use --force to run anyway.",
    );
    return;
  }

  const runners: Record<(typeof DAILY_STEPS)[number], () => Promise<StepResult>> = {
    ingest: runIngest,
    naukri: runNaukri,
    apply: runAutoApply,
  };
  for (const step of due) {
    log(`Starting ${step}…`);
    let result: StepResult;
    try {
      result = await runners[step]();
    } catch (err) {
      result = {
        ok: false,
        summary: err instanceof Error ? err.message.split("\n")[0] : String(err),
      };
    }
    log(`${step} ${result.ok ? "done" : "failed"}: ${result.summary}`);
    state[step] = recordStep(state[step], Date.now(), result);
    writeDailyState(PROJECT_ROOT, state);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
