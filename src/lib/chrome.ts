import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAC_CHROME_APP = "/Applications/Google Chrome.app";
const MAC_CHROME = `${MAC_CHROME_APP}/Contents/MacOS/Google Chrome`;

function which(bin: string): string | null {
  try {
    const out = execFileSync(
      process.platform === "win32" ? "where" : "which",
      [bin],
      { encoding: "utf-8" },
    )
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

function windowsChromeCandidates(): string[] {
  const local = process.env.LOCALAPPDATA;
  const programFiles = process.env.PROGRAMFILES;
  const programFilesX86 = process.env["PROGRAMFILES(X86)"];
  return [
    local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    programFiles && path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    programFilesX86 &&
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((p): p is string => Boolean(p));
}

/** Absolute path to Google Chrome, or null when it is not installed. */
export function findGoogleChrome(): string | null {
  if (process.platform === "darwin") {
    if (fs.existsSync(MAC_CHROME)) return MAC_CHROME;
    return null;
  }

  if (process.platform === "win32") {
    for (const candidate of windowsChromeCandidates()) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return which("chrome.exe");
  }

  return (
    which("google-chrome-stable") ||
    which("google-chrome") ||
    which("chromium-browser") ||
    which("chromium")
  );
}

export function macChromeAppPath(): string | null {
  return fs.existsSync(MAC_CHROME_APP) ? MAC_CHROME_APP : null;
}

export function isGoogleChrome(binary: string): boolean {
  const lower = binary.toLowerCase();
  return (
    lower.includes("google chrome") ||
    lower.includes("google-chrome") ||
    lower.endsWith(`${path.sep}chrome.exe`) ||
    lower.endsWith(`${path.sep}chrome`)
  );
}

export type ChromeStatus =
  | { installed: true; binary: string; isGoogleChrome: true }
  | { installed: true; binary: string; isGoogleChrome: false; note: string }
  | { installed: false };

export async function getChromeStatus(): Promise<ChromeStatus> {
  const google = findGoogleChrome();
  if (google) {
    return { installed: true, binary: google, isGoogleChrome: true };
  }

  try {
    const { chromium } = (await import("patchright")) as {
      chromium: typeof import("playwright").chromium;
    };
    const binary = chromium.executablePath();
    if (binary && fs.existsSync(binary)) {
      return {
        installed: true,
        binary,
        isGoogleChrome: false,
        note: "Google Chrome was not found. Job Radar can use a bundled browser, but some career sites block it.",
      };
    }
  } catch {
    // Patchright not installed yet.
  }

  return { installed: false };
}
