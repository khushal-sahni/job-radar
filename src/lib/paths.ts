import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OS user-data folder for Job Radar (database, secrets, Chrome profiles).
 * Mac keeps the existing Application Support path so local Chrome logins stay put.
 */
export function userDataDir(): string {
  if (process.env.JOB_RADAR_DATA_DIR) return process.env.JOB_RADAR_DATA_DIR;

  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "job-radar");
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "job-radar",
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME || path.join(home, ".local", "share"),
        "job-radar",
      );
  }
}

export function ensureUserDataDir(): string {
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function secretsPath(): string {
  return path.join(userDataDir(), "secrets.json");
}

export function embeddedDbDir(): string {
  return path.join(userDataDir(), "pglite");
}

export function embeddedDbPortFile(): string {
  return path.join(userDataDir(), "pglite-port");
}

export function chromeProfilesDir(): string {
  if (process.env.JOB_RADAR_CHROME_DIR) return process.env.JOB_RADAR_CHROME_DIR;
  return path.join(userDataDir(), "chrome");
}

export function projectRoot(): string {
  return process.env.JOB_RADAR_ROOT ?? process.cwd();
}
