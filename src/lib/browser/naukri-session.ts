import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { NAUKRI_SITE, restoreSession, saveSession } from "./cookie-vault";
import type { Lease } from "./manager";
import { projectRoot } from "./profiles";

/**
 * Owns the Naukri login on the Naukri profile: checks it, restores it from the cookie vault
 * when Chrome lost it, and records the last known state for the feed's health strip.
 */

export type NaukriSessionState = "ok" | "login_required" | "challenge";

export interface NaukriSessionStatus {
  state: NaukriSessionState;
  checkedAt: string;
}

export const NAUKRI_LOGIN_URL = "https://www.naukri.com/nlogin/login";
const HOMEPAGE_URL = "https://www.naukri.com/mnjuser/homepage";
const LOGGED_OUT_URL_RE = /\/nlogin\/|\/login\b|\/registration\b/i;
export const NAUKRI_HEADER_LOGIN = "#login_Layer, a[href*='/nlogin/login']";
export const NAUKRI_CHALLENGE_RE = /\b(access denied|verify you are human|captcha|unusual traffic)\b/i;

function statusPath(root: string): string {
  return path.join(root, ".cache", "sessions", "naukri.status.json");
}

export function readNaukriStatus(root = projectRoot()): NaukriSessionStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusPath(root), "utf-8")) as NaukriSessionStatus;
  } catch {
    return null;
  }
}

function writeStatus(state: NaukriSessionState, root: string): void {
  const file = statusPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: NaukriSessionStatus = { state, checkedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(body));
}

async function visibleCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).filter({ visible: true }).count().catch(() => 0);
}

/** Loads the account homepage in a tab of its own: logged out is sent to login or shows the Login link. */
export async function checkNaukriLogin(lease: Lease): Promise<NaukriSessionState> {
  const page = await lease.newPage();
  try {
    await page.goto(HOMEPAGE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await delay(3_000);
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (NAUKRI_CHALLENGE_RE.test(text.slice(0, 3000))) return "challenge";
    if (LOGGED_OUT_URL_RE.test(page.url())) return "login_required";
    return (await visibleCount(page, NAUKRI_HEADER_LOGIN)) > 0 ? "login_required" : "ok";
  } catch {
    return "login_required";
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Makes sure the Naukri Chrome is logged in: live check, then the saved session, then a second
 * check. A good login is saved again each time, so rotated cookies stay current.
 */
export async function ensureNaukriSession(
  lease: Lease,
  options: { root?: string; log?: (message: string) => void } = {},
): Promise<NaukriSessionState> {
  const root = options.root ?? projectRoot();
  const log = options.log ?? (() => undefined);
  let state = await checkNaukriLogin(lease);
  if (state === "login_required" && (await restoreSession(lease.context, NAUKRI_SITE, root))) {
    log("Naukri was logged out in Chrome; restored the saved login");
    state = await checkNaukriLogin(lease);
  }
  if (state === "ok") await saveSession(lease.context, NAUKRI_SITE, root);
  writeStatus(state, root);
  return state;
}

/** Records a state seen outside `ensureNaukriSession` (a job page showing a login wall). */
export function noteNaukriState(state: NaukriSessionState, root = projectRoot()): void {
  writeStatus(state, root);
}

/**
 * Opens the Naukri login page and waits until the account page loads logged in, or the tab is
 * closed, or time runs out. A confirmed login is saved to the vault.
 */
export async function loginToNaukri(
  lease: Lease,
  options: { root?: string; log?: (message: string) => void; timeoutMs?: number } = {},
): Promise<NaukriSessionState> {
  const root = options.root ?? projectRoot();
  const log = options.log ?? (() => undefined);
  const already = await ensureNaukriSession(lease, { root, log });
  if (already === "ok") {
    log("Naukri is already logged in");
    return already;
  }
  const page = await lease.newPage();
  await page.goto(NAUKRI_LOGIN_URL).catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
  log("Log in to Naukri in the opened window. This finishes by itself once you are logged in.");

  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    await delay(2_000);
    if (!lease.isConnected() || page.isClosed()) break;
    if (/naukri\.com\/(mnjuser|myapply|.*-jobs)/.test(page.url())) break;
  }
  await page.close().catch(() => undefined);
  if (!lease.isConnected()) return "login_required";
  const state = await ensureNaukriSession(lease, { root, log });
  log(state === "ok" ? "Naukri login confirmed and saved" : "Naukri is still logged out; nothing was saved");
  return state;
}
