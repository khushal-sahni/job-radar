import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { projectRoot } from "./profiles";

/**
 * Logged-in sessions saved outside Chrome. Sites like Naukri log in with session cookies, which
 * Chrome drops on exit (its "continue where you left off" pref is signed, so it can't be set from
 * outside). After a confirmed login the site's cookies are saved here and put back into a fresh
 * Chrome, so a login survives Chrome restarts and reboots. Files stay under `.cache/` (gitignored).
 */

export interface SessionSite {
  name: string;
  /** Registrable domains whose cookies make up the session. */
  domains: string[];
}

export const NAUKRI_SITE: SessionSite = { name: "naukri", domains: ["naukri.com"] };
/** Candidate accounts on every company's Workday career site (one account per tenant, same email). */
export const WORKDAY_SITE: SessionSite = { name: "workday", domains: ["myworkdayjobs.com", "myworkday.com"] };
/** Candidate accounts on iCIMS portals (one account per host, same email). */
export const ICIMS_SITE: SessionSite = { name: "icims", domains: ["icims.com"] };

type Cookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

interface VaultFile {
  savedAt: string;
  cookies: Cookie[];
}

function vaultPath(site: SessionSite, root: string): string {
  return path.join(root, ".cache", "sessions", `${site.name}.json`);
}

function belongsTo(site: SessionSite, domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  return site.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export async function saveSession(context: BrowserContext, site: SessionSite, root = projectRoot()): Promise<number> {
  const cookies = (await context.cookies()).filter((c) => belongsTo(site, c.domain));
  if (cookies.length === 0) return 0;
  const file = vaultPath(site, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: VaultFile = { savedAt: new Date().toISOString(), cookies };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  return cookies.length;
}

function readVault(site: SessionSite, root: string): VaultFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(vaultPath(site, root), "utf-8")) as VaultFile;
    return Array.isArray(parsed.cookies) ? parsed : null;
  } catch {
    return null;
  }
}

export function hasSavedSession(site: SessionSite, root = projectRoot()): boolean {
  return (readVault(site, root)?.cookies.length ?? 0) > 0;
}

/** Puts saved cookies back into the context. False when nothing usable is saved. */
export async function restoreSession(context: BrowserContext, site: SessionSite, root = projectRoot()): Promise<boolean> {
  const vault = readVault(site, root);
  if (!vault) return false;
  const now = Date.now() / 1000;
  const cookies = vault.cookies.filter((c) => c.expires === -1 || c.expires > now);
  if (cookies.length === 0) return false;
  await context.addCookies(cookies);
  return true;
}

export function forgetSession(site: SessionSite, root = projectRoot()): void {
  fs.rmSync(vaultPath(site, root), { force: true });
}
