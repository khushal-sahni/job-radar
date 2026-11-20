import fs from "node:fs";
import path from "node:path";
import type { Frame, Page } from "playwright";

type IcimsView = Page | Frame;

/** The job form lives in `#icims_content_iframe`. Navigating to its src as a top-level page often bounces back to the shell. */
function icimsView(page: Page): IcimsView {
  return (
    page.frame({ name: "icims_content_iframe" }) ??
    page.frames().find((f) => f !== page.mainFrame() && /in_iframe=1/i.test(f.url())) ??
    page
  );
}

function hostPage(view: IcimsView): Page {
  return "mainFrame" in view ? view : view.page();
}
import { ICIMS_SITE, restoreSession, saveSession } from "@/lib/browser/cookie-vault";
import { delay, settle } from "./browser-fill";
import { gmailUser, isGmailConfigured, waitForAccountMail, type AccountMail } from "./gmail";
import { park, type TaskOutcome } from "./outcome";
import { generatePassword } from "./workday";

/**
 * iCIMS career portals (`*.icims.com`). The shell page embeds the real UI in
 * `#icims_content_iframe`. Applying starts with an email + GDPR gate, then either a password
 * sign-in (returning candidate) or a create-profile form that is the application itself.
 * Passwords are stored per host; verify / reset mail is read from Gmail like Workday.
 */

export interface IcimsInput {
  root: string;
  email: string;
  log?: (message: string) => void;
}

const MAIL_WAIT_MS = 120_000;
const MAIL_SKEW_MS = 30_000;
const MAX_ROUNDS = 12;

export function isIcimsUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith("icims.com");
  } catch {
    return false;
  }
}

/** Host key for one portal account, e.g. careers-orange.icims.com. */
export function icimsHost(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** Prefer the iframe content URL so Playwright scans the real form, not the branded shell. */
export function icimsContentUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("in_iframe", "1");
  // The pasted Orange link ends in /login with tracking params; keep the login path for the email gate.
  return u.toString();
}

/** `/login` shells that never render a form: the job content iframe (`…/job?in_iframe=1`). */
export function icimsJobContentUrl(url: string): string {
  const u = new URL(url);
  if (/\/login\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/login\/?$/, "/job");
  u.searchParams.set("in_iframe", "1");
  return u.toString();
}

interface StoredAccount {
  email: string;
  password: string;
  createdAt: string;
}

function accountPath(root: string, host: string): string {
  return path.join(root, ".cache", "sessions", `icims-${host.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

function readAccount(root: string, host: string): StoredAccount | null {
  try {
    return JSON.parse(fs.readFileSync(accountPath(root, host), "utf-8")) as StoredAccount;
  } catch {
    return null;
  }
}

function accountFor(root: string, host: string, email: string): StoredAccount {
  const saved = readAccount(root, host);
  if (saved && saved.email === email) return saved;
  const account = { email, password: generatePassword(), createdAt: new Date().toISOString() };
  const file = accountPath(root, host);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(account, null, 2), { mode: 0o600 });
  return account;
}

/** The saved (or newly made) iCIMS password for this portal host. */
export function icimsPassword(root: string, url: string, email: string): string {
  return accountFor(root, icimsHost(url), email).password;
}

/** Password + confirm on the create-profile form (scanner skips password inputs). */
async function fillProfilePassword(view: IcimsView, password: string): Promise<void> {
  const inputs = view.locator("input[type='password']").filter({ visible: true });
  const n = await inputs.count();
  for (let i = 0; i < n; i++) await inputs.nth(i).fill(password);
}

const LINK_WORDS_RE = /verif|activat|confirm|reset|password|token|eem=/i;
const CODE_RE = /\b(?:code|passcode|verification code)\b(?:\s+is)?\s*[:-]?\s*\b((?=[A-Z0-9]*[0-9])[A-Z0-9]{4,8})\b/i;

/** Verify / reset link or one-time code from an iCIMS account email. */
export function extractIcimsMail(body: { text: string; html: string }, linkHost: string): AccountMail | null {
  const hrefs = [...body.html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  const plain = [...body.text.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((m) => m[0]);
  const link =
    [...hrefs, ...plain].find((u) => {
      try {
        const host = new URL(u).hostname.toLowerCase();
        return (host === linkHost || host.endsWith(".icims.com")) && LINK_WORDS_RE.test(u);
      } catch {
        return false;
      }
    }) ?? null;
  const text = body.text || body.html.replace(/<[^>]+>/g, " ");
  const code = CODE_RE.exec(text.replace(/\s+/g, " "))?.[1] ?? null;
  return link || code ? { link, code } : null;
}

type Screen =
  | "profile"
  | "email_gate"
  | "sign_in"
  | "forgot_password"
  | "code"
  | "verify_notice"
  | "unknown";

/** Plain JS for page.evaluate — no inner functions (tsx `__name` helper). */
const READ_SCREEN_JS = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const q = (sel) => [...document.querySelectorAll(sel)].find(visible) || null;
  const body = document.body ? document.body.innerText : "";
  const error = [...document.querySelectorAll("[role='alert'], .iCIMS_ErrorMessage, #iCIMS_ErrorMessage_login")]
    .filter(visible)
    .map((e) => (e.textContent || "").replace(/\\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 300);
  let screen = "unknown";
  if (q("#cp_form_submit_i") || q("input[name='PersonProfileFields.Password']") || q("input[name='profileButton']"))
    screen = "profile";
  else if (q("#enterEmailForm") || (q("#email") && q("#accept_gdpr")) || q("#enterEmailSubmitButton") || (q("#css_loginName, input[name='css_loginName']") && !q("#css_password, input[name='css_password'], input[type='password']")))
    screen = "email_gate";
  else if (q("#css_password, input[name='css_password']") || (q("#css_loginName, input[name='css_loginName']") && q("#css_loginButton")))
    screen = "sign_in";
  else if (q("input[type='password']") && (q("#loginSubmitButton") || /\\bforgot (your )?password\\b/i.test(body)))
    screen = /\\bforgot (your )?password\\b/i.test(body) && !q("input[type='password'][autocomplete='current-password']") && q("input[type='email'], #email") && !q("#css_password")
      ? "forgot_password"
      : "sign_in";
  else if ([...document.querySelectorAll("input[autocomplete='one-time-code'], input[name*='code' i], input[id*='verification' i]")].some(visible))
    screen = "code";
  else if (/\\b(verify|confirm|activate) your (email|account)\\b|\\bverification email\\b|\\bcheck your (email|inbox)\\b/i.test(body))
    screen = "verify_notice";
  else if (q("input[type='password']")) screen = "sign_in";
  return { screen, error };
})()`;

async function readScreen(view: IcimsView): Promise<{ screen: Screen; error: string }> {
  return view.evaluate(READ_SCREEN_JS) as Promise<{ screen: Screen; error: string }>;
}

async function fillVisible(view: IcimsView, selector: string, value: string): Promise<boolean> {
  const input = view.locator(selector).filter({ visible: true }).first();
  if ((await input.count()) === 0) return false;
  await input.fill(value);
  return true;
}

async function clickVisible(view: IcimsView, selector: string): Promise<boolean> {
  const el = view.locator(selector).filter({ visible: true }).first();
  if ((await el.count()) === 0) return false;
  await el.click({ timeout: 10_000 });
  await settle(hostPage(view));
  return true;
}

/**
 * Gets an iCIMS posting to its application (or create-profile) form: open the content URL,
 * pass the email/GDPR gate, create or sign in with a stored password and Gmail for codes.
 * Null when the form is on screen.
 */
export async function reachIcimsForm(page: Page, entryUrl: string, input: IcimsInput): Promise<TaskOutcome | null> {
  const log = input.log ?? (() => undefined);
  const host = icimsHost(entryUrl);
  let account: StoredAccount | null = null;

  const ensureAccount = (): StoredAccount | TaskOutcome => {
    if (!isGmailConfigured()) {
      return park(
        "account_required",
        "iCIMS needs an account; add Gmail in Settings so the runner can read its emails",
      );
    }
    if (input.email.trim().toLowerCase() !== gmailUser()) {
      return park("account_required", `iCIMS account email ${input.email} is not the Gmail address in Settings, so its emails can't be read`);
    }
    account ??= accountFor(input.root, host, input.email.trim().toLowerCase());
    return account;
  };

  const readMail = async (since: Date, what: string): Promise<AccountMail | TaskOutcome> => {
    log(`  iCIMS ${what}; checking Gmail`);
    try {
      const mail = await waitForAccountMail({
        since,
        fromDomain: "icims.com",
        linkHost: host,
        extract: extractIcimsMail,
        timeoutMs: MAIL_WAIT_MS,
      });
      return mail ?? park("account_required", `iCIMS ${what}, but no email arrived in Gmail in time`);
    } catch (err) {
      return park(
        "account_required",
        `Could not read Gmail for the iCIMS email: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
      );
    }
  };

  if (await restoreSession(page.context(), ICIMS_SITE, input.root)) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await settle(page);
  }

  // Shell pages only embed the form; drive the in_iframe content URL.
  const content = icimsContentUrl(entryUrl);
  if (!page.url().includes("in_iframe=1")) {
    await page.goto(content, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await settle(page);
  }

  const hadAccount = readAccount(input.root, host) !== null;
  let created = false;
  let signedIn = false;
  let reset = false;
  let unknownReady = 0;
  let mailSince = new Date(Date.now() - MAIL_SKEW_MS);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let screen: Screen = "unknown";
    let error = "";
    const view = icimsView(page);
    try {
      ({ screen, error } = await readScreen(view));
    } catch {
      await settle(page);
      continue;
    }
    log(`  iCIMS screen: ${screen}${error ? ` (${error.slice(0, 80)})` : ""}`);

    switch (screen) {
      case "profile": {
        const pwCount = await view.locator("input[type='password']").filter({ visible: true }).count();
        if (pwCount > 0) {
          const acc = ensureAccount();
          if ("status" in acc) return acc;
          // Create-password boxes are part of the application; the scanner skips them.
          await fillProfilePassword(view, acc.password);
        }
        await saveSession(page.context(), ICIMS_SITE, input.root).catch(() => 0);
        return null;
      }

      case "email_gate": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        log(`  iCIMS: entering email for ${acc.email}`);
        mailSince = new Date(Date.now() - MAIL_SKEW_MS);
        await fillVisible(view, "#email, input[name='css_loginName'], input[type='email']", acc.email);
        const gdpr = view.locator("#accept_gdpr").filter({ visible: true }).first();
        if ((await gdpr.count()) > 0 && !(await gdpr.isChecked().catch(() => true))) {
          await gdpr.check({ force: true }).catch(() => undefined);
        }
        if (!(await clickVisible(view, "#enterEmailSubmitButton, #css_loginButton, input[type='submit'].gdprAnswerSubmitButton"))) {
          await view.getByRole("button", { name: /^next$/i }).first().click({ timeout: 5_000 }).catch(() => undefined);
        }
        await settle(page);
        await delay(1_000);
        break;
      }

      case "sign_in": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        if (!hadAccount && !created && !reset) {
          // Prefer creating when we have never signed in on this host.
          const create = view.getByRole("link", { name: /create|register|new (candidate|profile)/i }).first();
          if ((await create.count()) > 0) {
            await create.click({ timeout: 5_000 }).catch(() => undefined);
            await settle(page);
            break;
          }
        }
        if (!signedIn) {
          log("  iCIMS: signing in");
          await fillVisible(view, "#email, input[name='css_loginName'], input[type='email']", acc.email);
          await fillVisible(view, "input[type='password'], #css_password, input[name*='password' i]", acc.password);
          if (!(await clickVisible(view, "#loginSubmitButton, #css_loginButton, input[type='submit']"))) {
            await view.getByRole("button", { name: /^(log in|sign in|login)$/i }).first().click().catch(() => undefined);
          }
          signedIn = true;
          await delay(1_500);
          break;
        }
        if (reset) return park("account_required", `iCIMS sign-in failed after a password reset: ${error || "no message"}`);
        log("  iCIMS: sign-in failed; resetting the password");
        mailSince = new Date(Date.now() - MAIL_SKEW_MS);
        const forgot = view.getByRole("link", { name: /forgot (your )?password/i }).first();
        if ((await forgot.count()) > 0) await forgot.click({ timeout: 5_000 }).catch(() => undefined);
        else await view.getByText(/forgot (your )?password/i).first().click({ timeout: 5_000 }).catch(() => undefined);
        reset = true;
        await settle(page);
        break;
      }

      case "forgot_password": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        mailSince = new Date(Date.now() - MAIL_SKEW_MS);
        await fillVisible(view, "#email, input[type='email'], input[name='css_loginName']", acc.email);
        await clickVisible(view, "input[type='submit'], button[type='submit']");
        reset = true;
        const mail = await readMail(mailSince, "sent a password reset email");
        if ("status" in mail) return mail;
        if (mail.link) {
          await page.goto(mail.link, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await settle(page);
          const resetView = icimsView(page);
          await fillVisible(resetView, "input[type='password']", acc.password);
          const confirm = resetView.locator("input[type='password']").filter({ visible: true });
          if ((await confirm.count()) > 1) await confirm.nth(1).fill(acc.password);
          await clickVisible(resetView, "input[type='submit'], button[type='submit']");
        }
        signedIn = false;
        await page.goto(content, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        break;
      }

      case "code": {
        const mail = await readMail(mailSince, "asked for an emailed code");
        if ("status" in mail) return mail;
        if (!mail.code) return park("account_required", "iCIMS asked for an emailed code, but the email had none");
        await fillVisible(
          view,
          "input[autocomplete='one-time-code'], input[name*='code' i], input[id*='verification' i]",
          mail.code,
        );
        await clickVisible(view, "input[type='submit'], button[type='submit']");
        break;
      }

      case "verify_notice": {
        const mail = await readMail(mailSince, "asked to verify the account email");
        if ("status" in mail) return mail;
        if (!mail.link) return park("account_required", "iCIMS asked to verify the email, but the email had no link");
        await page.goto(mail.link, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        await page.goto(content, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        created = true;
        break;
      }

      case "unknown": {
        const fields = await view.locator("input:not([type='hidden']), textarea, select").filter({ visible: true }).count();
        if (fields >= 3) {
          await saveSession(page.context(), ICIMS_SITE, input.root).catch(() => 0);
          return null;
        }
        const hasLogin = await view
          .locator("#css_loginName, input[name='css_loginName'], #css_password, #css_loginButton, #email, #enterEmailForm")
          .filter({ visible: true })
          .count();
        const onShell = "mainFrame" in view;
        const onLogin = /\/login\/?$/.test(new URL(page.url()).pathname);
        if (onLogin && hasLogin === 0 && onShell) {
          const jobUrl = icimsJobContentUrl(page.url());
          if (jobUrl !== page.url()) {
            log("  iCIMS: opening the job content from the login shell");
            await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
            await settle(page);
            break;
          }
        }
        if (hasLogin === 0 && onShell) {
          await delay(800);
          break;
        }
        unknownReady += 1;
        if (unknownReady < 3) {
          await delay(800);
          break;
        }
        return park("account_required", "iCIMS did not show a sign-in or application form");
      }
    }
    await delay(800);
  }
  return park("account_required", "iCIMS account steps did not reach the application form");
}
