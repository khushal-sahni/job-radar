import { spawn } from "node:child_process";
import path from "node:path";
import { ensureDb } from "@/lib/db";
import { getPreferences } from "@/lib/preferences";
import { projectRoot } from "@/lib/paths";

const TICK_MS = 60_000;

const globalForScheduler = globalThis as unknown as {
  __jobRadarScheduler?: { started: boolean; timer?: ReturnType<typeof setInterval> };
};

function log(message: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[scheduler ${ts}] ${message}`);
}

async function tick(): Promise<void> {
  try {
    await ensureDb();
    const prefs = await getPreferences();
    if (!prefs.findScheduleEnabled) return;

    const hour = new Date().getHours();
    if (hour !== prefs.scheduleHour) return;

    const root = projectRoot();
    const script = path.join(root, "scripts", "daily-ingest.ts");
    const args = ["tsx", script];
    if (!prefs.applyScheduleEnabled) args.push("--skip-apply");
    if (!prefs.naukriEnabled) args.push("--skip-naukri");

    log(
      `Starting daily run (find on, apply ${prefs.applyScheduleEnabled ? "on" : "off"}, naukri ${prefs.naukriEnabled ? "on" : "off"})`,
    );

    const child = spawn("npx", args, {
      cwd: root,
      env: { ...process.env },
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
  } catch (err) {
    log(`Tick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Start the once-a-minute schedule loop. Safe to call more than once. */
export function startScheduler(): void {
  if (globalForScheduler.__jobRadarScheduler?.started) return;
  globalForScheduler.__jobRadarScheduler = { started: true };
  log("In-app scheduler started — leave Job Radar open for the daily run");
  void tick();
  globalForScheduler.__jobRadarScheduler.timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Keep the timer alive in Node without blocking process exit in tests.
  globalForScheduler.__jobRadarScheduler.timer.unref?.();
}
