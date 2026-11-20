import fs from "node:fs";
import path from "node:path";
import { chromeProfilesDir, projectRoot as pathsProjectRoot } from "@/lib/paths";

/**
 * Chrome profiles the app owns. Each one is driven by a single long-lived Chrome that every
 * run attaches to (see `manager.ts`); nothing else may start Chrome on these directories.
 *
 * Profiles live in the OS user-data folder so a background Chrome is not blocked by
 * Documents folder permissions (macOS) and so Windows/Linux keep logins outside the repo.
 */
export type ProfileName = "naukri" | "apply";

const LEGACY_DIRS: Record<ProfileName, string> = {
  naukri: ".cache/naukri-profile",
  apply: ".cache/apply-profile",
};

export function projectRoot(): string {
  return pathsProjectRoot();
}

function profilesHome(root: string): string {
  if (process.env.JOB_RADAR_CHROME_DIR) return process.env.JOB_RADAR_CHROME_DIR;
  // Prefer the shared user-data chrome dir; fall back only for tests that set a fake root.
  void root;
  return chromeProfilesDir();
}

export function profileDir(profile: ProfileName, root = projectRoot()): string {
  return path.join(profilesHome(root), profile);
}

/** The pre-move location inside the repo, moved over once by the browser manager. */
export function legacyProfileDir(profile: ProfileName, root = projectRoot()): string {
  return path.join(root, LEGACY_DIRS[profile]);
}

/** Moves a profile left in the repo to its new home, keeping its logins. False if it could not. */
export function migrateLegacyProfile(profile: ProfileName, root = projectRoot()): boolean {
  const from = legacyProfileDir(profile, root);
  const to = profileDir(profile, root);
  if (from === to || fs.existsSync(to) || !fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  return true;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pid of the Chrome holding this profile directory.
 * On Unix Chrome's SingletonLock is a symlink ending in -<pid>. On Windows the lock is a
 * regular file with no pid — callers attach via DevToolsActivePort instead, and clear stale
 * files when that port no longer accepts connections.
 */
export function profileHolder(dir: string): number | null {
  try {
    const lockPath = path.join(dir, "SingletonLock");
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(lockPath);
      const pid = Number(target.slice(target.lastIndexOf("-") + 1));
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
    }
  } catch {
    // no lock / not a symlink (Windows)
  }
  return null;
}

/** True when a Chrome is running on the profile (it may have no windows). */
export function isProfileRunning(profile: ProfileName, root = projectRoot()): boolean {
  const dir = profileDir(profile, root);
  try {
    const port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf-8").split("\n")[0]);
    return Number.isInteger(port) && port > 0;
  } catch {
    return profileHolder(dir) !== null;
  }
}

export function profileLabel(profile: ProfileName): string {
  return profile === "naukri" ? "Naukri Chrome" : "job-site Chrome";
}

export const ALL_PROFILES: ProfileName[] = ["naukri", "apply"];
