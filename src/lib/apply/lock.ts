import fs from "node:fs";
import path from "node:path";

/**
 * One apply run at a time. The lock file holds the run's pid, when it started, and a heartbeat
 * the run refreshes while it works. A lock whose process is gone, or whose heartbeat stopped
 * (a hung or crashed run, or a reused pid), is stale and is taken over.
 */

const LOCK_FILE = ".cache/apply-run.lock";
const RESULT_FILE = ".cache/apply-run.result.json";
export const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 5 * 60_000;

interface LockBody {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

function lockPath(root: string): string {
  return path.join(root, LOCK_FILE);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(root: string): LockBody | null {
  try {
    const raw = fs.readFileSync(lockPath(root), "utf-8").trim();
    const parsed = JSON.parse(raw) as LockBody;
    return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeLockBody(root: string, body: LockBody): void {
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), JSON.stringify(body));
}

/** Pid of a live apply run, or null. */
export function activeRunPid(root: string): number | null {
  const lock = readLock(root);
  if (!lock || !alive(lock.pid)) return null;
  if (Date.now() - Date.parse(lock.heartbeatAt) > STALE_AFTER_MS) return null;
  return lock.pid;
}

/** Records a run that was just spawned, before its process takes the lock itself. */
export function writeLock(root: string, pid: number): void {
  const now = new Date().toISOString();
  writeLockBody(root, { pid, startedAt: now, heartbeatAt: now });
}

/**
 * Takes the lock for this process. A lock written by `startApplyRun` holds the tsx launcher pid,
 * which is this process or its parent. Returns a release function, or null when another run is live.
 */
export function acquireLock(root: string): (() => void) | null {
  const holder = activeRunPid(root);
  if (holder && holder !== process.pid && holder !== process.ppid) return null;
  writeLock(root, process.pid);
  const beat = setInterval(() => {
    const lock = readLock(root);
    if (lock?.pid === process.pid) writeLockBody(root, { ...lock, heartbeatAt: new Date().toISOString() });
  }, HEARTBEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    if (readLock(root)?.pid === process.pid) fs.rmSync(lockPath(root), { force: true });
  };
}

/**
 * Ends the active run. `startApplyRun` spawns it detached, so its pid leads a process group
 * holding tsx and node; the whole group is signalled. Chrome is started on its own by the
 * browser manager and stays open. Returns false when nothing was running.
 */
export async function stopApplyRun(root: string): Promise<boolean> {
  const pid = activeRunPid(root);
  if (!pid) return false;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 150));
  if (alive(pid)) signal("SIGKILL");
  fs.rmSync(lockPath(root), { force: true });
  return true;
}

/** Stop reason the panel shows as a banner until a later run finishes without it. */
export const OUT_OF_CREDITS_REASON = "the AI provider is out of credits";

export interface LastRunResult {
  skippedReason: string | null;
  finishedAt: string;
}

/** Why the last run stopped early, if it did; read by the panel once the run is gone. */
export function writeRunResult(root: string, skippedReason: string | null): void {
  try {
    fs.mkdirSync(path.dirname(path.join(root, RESULT_FILE)), { recursive: true });
    const result: LastRunResult = { skippedReason, finishedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(root, RESULT_FILE), JSON.stringify(result));
  } catch {
    // The run's own log still has the reason.
  }
}

export function readRunResult(root: string): LastRunResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, RESULT_FILE), "utf-8")) as LastRunResult;
  } catch {
    return null;
  }
}
