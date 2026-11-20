import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { activeRunPid, writeLock } from "./lock";
import { planArgs, type RunPlan } from "./plan";

function spawnScript(root: string, script: string, args: string[], logFile: string): number | undefined {
  fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
  const logFd = fs.openSync(path.join(root, logFile), "a");
  const child = spawn(path.join(root, "node_modules/.bin/tsx"), [script, ...args], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
  return child.pid;
}

/** Starts `scripts/apply-run.ts` in the background for the plan. Logs to .cache/apply-run.log. */
export function startApplyRun(root: string, plan: RunPlan): { started: boolean; reason?: string } {
  if (activeRunPid(root)) return { started: false, reason: "An apply run is already in progress" };
  const pid = spawnScript(root, "scripts/apply-run.ts", planArgs(plan), ".cache/apply-run.log");
  if (pid) writeLock(root, pid);
  return { started: true };
}

const LOGIN_PID_FILE = ".cache/naukri-login.pid";

/** True while a login window started from the app is still waiting for you. */
export function naukriLoginRunning(root: string): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(root, LOGIN_PID_FILE), "utf-8"));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Opens the Naukri login page in the Naukri Chrome; the script exits once you are logged in. */
export function startNaukriLogin(root: string): { started: boolean; reason?: string } {
  if (naukriLoginRunning(root)) return { started: false, reason: "The Naukri login window is already open" };
  const pid = spawnScript(root, "scripts/apply-run.ts", ["--naukri-login"], ".cache/naukri-login.log");
  if (pid) fs.writeFileSync(path.join(root, LOGIN_PID_FILE), String(pid));
  return { started: true };
}
