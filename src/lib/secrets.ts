import fs from "node:fs";
import { ensureUserDataDir, secretsPath } from "./paths";

export interface AppSecrets {
  openRouterApiKey?: string;
  gmailUser?: string;
  gmailAppPassword?: string;
}

function readFile(): AppSecrets {
  try {
    const raw = fs.readFileSync(secretsPath(), "utf-8");
    const parsed = JSON.parse(raw) as AppSecrets;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeFile(secrets: AppSecrets): void {
  ensureUserDataDir();
  const file = secretsPath();
  fs.writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows and some filesystems have no Unix mode bits.
  }
}

export function getSecrets(): AppSecrets {
  return readFile();
}

export function updateSecrets(patch: AppSecrets): AppSecrets {
  const next = { ...readFile(), ...patch };
  for (const key of Object.keys(next) as (keyof AppSecrets)[]) {
    const value = next[key];
    if (typeof value === "string" && value.trim() === "") {
      delete next[key];
    } else if (typeof value === "string") {
      next[key] = value.trim();
    }
  }
  writeFile(next);
  return next;
}

/** OpenRouter key: env wins (tests / hand-written .env), then the secrets file. */
export function getOpenRouterApiKey(): string | null {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readFile().openRouterApiKey?.trim();
  return fromFile || null;
}

export function getGmailUser(): string | null {
  const fromEnv = process.env.GMAIL_USER?.trim().toLowerCase();
  if (fromEnv) return fromEnv;
  return readFile().gmailUser?.trim().toLowerCase() || null;
}

export function getGmailAppPassword(): string | null {
  const fromEnv = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (fromEnv) return fromEnv;
  const fromFile = readFile().gmailAppPassword?.replace(/\s+/g, "");
  return fromFile || null;
}

export function isGmailConfigured(): boolean {
  return Boolean(getGmailUser() && getGmailAppPassword());
}

export function hasOpenRouterKey(): boolean {
  return Boolean(getOpenRouterApiKey());
}
