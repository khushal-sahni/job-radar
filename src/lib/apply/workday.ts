import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { WORKDAY_SITE, restoreSession, saveSession } from "@/lib/browser/cookie-vault";
import { delay, jitter, settle } from "./browser-fill";
import { gmailUser, isGmailConfigured, waitForAccountMail, type AccountMail } from "./gmail";
import { SUBMITTED, park, type TaskOutcome } from "./outcome";

/**
 * Workday career sites (`<tenant>.wdN.myworkdayjobs.com`). Some let you apply as a guest; others
 * want a candidate account per tenant. The account is made here with the profile email and a
 * generated password kept in `.cache/sessions/`. An email that already has an account gets a
 * password reset through Gmail, so no step waits for you.
 */

export interface WorkdayInput {
  root: string;
  email: string;
  log?: (message: string) => void;
}

const MAIL_WAIT_MS = 120_000;
const MAIL_SKEW_MS = 30_000;
const MAX_ROUNDS = 24;

export function isWorkdayUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith("myworkdayjobs.com") || host.endsWith("myworkdaysite.com");
  } catch {
    return false;
  }
}

/** "thales.wd3.myworkdayjobs.com" → "thales.wd3": one account per tenant. */
export function workdayTenant(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/\.myworkdayjobs\.com$/, "");
}

/** Meets Workday's rule: 8+ characters with upper, lower, digit and a special character. */
export function generatePassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%*?"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 16) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

interface StoredAccount {
  email: string;
  password: string;
  createdAt: string;
}

function accountPath(root: string, tenant: string): string {
  return path.join(root, ".cache", "sessions", `workday-${tenant.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

function readAccount(root: string, tenant: string): StoredAccount | null {
  try {
    return JSON.parse(fs.readFileSync(accountPath(root, tenant), "utf-8")) as StoredAccount;
  } catch {
    return null;
  }
}

/** The tenant's password, made and saved on first use. */
function accountFor(root: string, tenant: string, email: string): StoredAccount {
  const saved = readAccount(root, tenant);
  if (saved && saved.email === email) return saved;
  const account = { email, password: generatePassword(), createdAt: new Date().toISOString() };
  const file = accountPath(root, tenant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(account, null, 2), { mode: 0o600 });
  return account;
}

/** The saved (or newly made) Workday password for this job's tenant. */
export function workdayPassword(root: string, url: string, email: string): string {
  return accountFor(root, workdayTenant(url), email).password;
}

const LINK_WORDS_RE = /verif|activat|confirm|reset|password|token/i;
const CODE_RE = /\b(?:code|passcode)\b(?:\s+is)?\s*[:-]?\s*\b((?=[A-Z0-9]*[0-9])[A-Z0-9]{4,8})\b/i;

/** The verify / reset link (on the tenant's host) or one-time code in a Workday account email. */
export function extractWorkdayMail(body: { text: string; html: string }, linkHost: string): AccountMail | null {
  const hrefs = [...body.html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  const stripped = `${body.text} ${body.html.replace(/<[^>]+>/g, " ")}`;
  const plain = [...stripped.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((m) => m[0].replace(/&amp;/g, "&"));
  const link =
    [...hrefs, ...plain].find((u) => {
      try {
        const host = new URL(u).hostname.toLowerCase();
        return (host === linkHost || host.endsWith(".myworkday.com") || host.endsWith(".myworkdayjobs.com")) && LINK_WORDS_RE.test(u);
      } catch {
        return false;
      }
    }) ?? null;
  const text = body.text || body.html.replace(/<[^>]+>/g, " ");
  const code = CODE_RE.exec(text.replace(/\s+/g, " "))?.[1] ?? null;
  return link || code ? { link, code } : null;
}

/**
 * Workday apply screens. Auth (`reachWorkdayForm`) walks these until `wizard` or
 * `already_applied`. Fill stays on that tab and walks wizard steps separately.
 *
 * Same machine every public Workday automator uses (data-automation-id, not URL):
 *   apply_button → apply_dialog → account_choice → create_account | sign_in
 *     → forgot_password → set_password | code | verify_notice → wizard
 *   already_applied is terminal (counts as submitted).
 *   click_filter takes the click; beecatcher stays empty.
 */
export type WorkdayScreen =
  | "wizard"
  | "already_applied"
  | "apply_dialog"
  | "apply_button"
  | "create_account"
  | "sign_in"
  | "account_choice"
  | "forgot_password"
  | "set_password"
  | "code"
  | "verify_notice"
  | "unknown";

/** Visible Workday controls. Account widgets beat leftover progress-bar chrome. */
export interface WorkdayFlags {
  alreadyApplied: boolean;
  resetPasswordButton: boolean;
  forgotPasswordSubmit: boolean;
  verifyPassword: boolean;
  createAccountSubmit: boolean;
  signInSubmit: boolean;
  password: boolean;
  email: boolean;
  otp: boolean;
  applyManually: boolean;
  createAccountLink: boolean;
  signInLink: boolean;
  applyButton: boolean;
  applicationField: boolean;
  verifyNotice: boolean;
  passwordResetUrl: boolean;
}

/**
 * One screen from the live controls. Order is the state machine: a Reset Password button on a
 * leftover step bar is forgot-password, not the wizard. Same rule every Workday automator uses
 * (data-automation-id of the action, not the chrome).
 */
export function classifyWorkdayScreen(f: WorkdayFlags): WorkdayScreen {
  if (f.alreadyApplied) return "already_applied";
  if (f.passwordResetUrl && f.password) return "set_password";
  if (f.resetPasswordButton || f.forgotPasswordSubmit) return "forgot_password";
  if (f.verifyPassword || (f.password && f.createAccountSubmit)) return "create_account";
  if (f.password) return "sign_in";
  if (f.otp) return "code";
  if (f.verifyNotice) return "verify_notice";
  if (f.applicationField) return "wizard";
  if (f.applyManually) return "apply_dialog";
  if (f.createAccountLink || f.signInLink) return "account_choice";
  if (f.applyButton) return "apply_button";
  return "unknown";
}

export function isWorkdayWizard(flags: {
  progressBar: boolean;
  activeStep: boolean;
  email: boolean;
  password: boolean;
  signIn: boolean;
  createAccount: boolean;
  forgotPassword: boolean;
  applicationField?: boolean;
}): boolean {
  return (
    classifyWorkdayScreen({
      alreadyApplied: false,
      resetPasswordButton: flags.forgotPassword,
      forgotPasswordSubmit: false,
      verifyPassword: false,
      createAccountSubmit: flags.createAccount,
      signInSubmit: flags.signIn,
      password: flags.password,
      email: flags.email,
      otp: false,
      applyManually: false,
      createAccountLink: false,
      signInLink: false,
      applyButton: false,
      applicationField: flags.applicationField ?? (flags.activeStep && flags.progressBar && !flags.email && !flags.password),
      verifyNotice: false,
      passwordResetUrl: false,
    }) === "wizard"
  );
}

/** Plain JS: functions compiled by tsx reference a `__name` helper the page does not have. */
const READ_FLAGS_JS = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const id = (name) => [...document.querySelectorAll("[data-automation-id='" + name + "']")].some(visible);
  const body = document.body ? document.body.innerText : "";
  const error = [...document.querySelectorAll("[data-automation-id='errorMessage'], [role='alert']")]
    .filter(visible)
    .map((e) => (e.textContent || "").replace(/\\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 300);
  const applicationField = id("legalNameSection_firstName") || id("jobTitle") || [...document.querySelectorAll("[data-automation-id^='formField-']")].some((el) => {
    const a = (el.getAttribute("data-automation-id") || "").toLowerCase();
    return visible(el) && a.indexOf("email") === -1 && a.indexOf("password") === -1;
  });
  return {
    alreadyApplied: id("alreadyApplied") || /\\/jobtasks\\/completed\\/application/i.test(location.href) || /\\b(you('ve| have) already applied|already applied for this job)\\b/i.test(body),
    resetPasswordButton: id("resetPasswordButton"),
    forgotPasswordSubmit: id("forgotPasswordSubmitButton"),
    verifyPassword: id("verifyPassword"),
    createAccountSubmit: id("createAccountSubmitButton"),
    signInSubmit: id("signInSubmitButton"),
    password: [...document.querySelectorAll("input[type='password']")].some(visible),
    email: id("email"),
    otp: [...document.querySelectorAll("input[autocomplete='one-time-code'], input[id*='verificationCode' i], input[data-automation-id*='verificationCode' i]")].some(visible),
    applyManually: id("applyManually"),
    createAccountLink: id("createAccountLink"),
    signInLink: id("signInLink"),
    applyButton: id("adventureButton") || id("continueApplicationButton") || id("continueButton") || [...document.querySelectorAll("button, a, [role='button']")].some((el) => {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      return visible(el) && /^(apply|apply now|continue application|continue)$/i.test(t);
    }),
    applicationField: Boolean(applicationField),
    verifyNotice: /\\b(verify|confirm|activate) your (email|account)\\b|\\bverification email\\b/i.test(body),
    error,
  };
})()`;

/** What the Workday page is showing, by its automation ids. */
async function readScreen(page: Page): Promise<{ screen: WorkdayScreen; error: string }> {
  const flags = (await page.evaluate(READ_FLAGS_JS)) as Omit<WorkdayFlags, "passwordResetUrl"> & { error: string };
  const screen = classifyWorkdayScreen({ ...flags, passwordResetUrl: /passwordreset/i.test(page.url()) });
  return { screen, error: flags.error };
}

/** Workday lays a transparent "click_filter" over its submit buttons; that is what takes the click. */
async function clickWorkday(page: Page, automationId: string): Promise<boolean> {
  const target = page.locator(`[data-automation-id='${automationId}']`).filter({ visible: true }).first();
  if ((await target.count()) === 0) return false;
  const filter = target.locator("xpath=..").locator("[data-automation-id='click_filter']").first();
  if ((await filter.count()) > 0) await filter.click({ timeout: 10_000 });
  else await target.click({ timeout: 10_000 });
  await settle(page);
  return true;
}

async function fillWorkday(page: Page, automationId: string, value: string): Promise<boolean> {
  const input = page.locator(`input[data-automation-id='${automationId}']`).filter({ visible: true }).first();
  if ((await input.count()) === 0) return false;
  await input.fill(value);
  await jitter(150, 400);
  return true;
}

async function passwordInputs(page: Page): Promise<ReturnType<Page["locator"]>> {
  return page.locator("input[type='password']").filter({ visible: true });
}

async function fillEmail(page: Page, email: string): Promise<void> {
  if (await fillWorkday(page, "email", email)) return;
  const input = page.locator("input[type='email'], input[autocomplete='email'], input[name*='email' i]").filter({ visible: true }).first();
  if ((await input.count()) > 0) await input.fill(email);
}

/** Password and confirm password (create account, or the reset page). */
async function fillNewPassword(page: Page, password: string): Promise<void> {
  if (await fillWorkday(page, "password", password)) {
    await fillWorkday(page, "verifyPassword", password);
    return;
  }
  const inputs = await passwordInputs(page);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) await inputs.nth(i).fill(password);
}

async function tickAgreement(page: Page): Promise<void> {
  const box = page.locator("input[data-automation-id='createAccountCheckbox']").first();
  if ((await box.count()) > 0 && !(await box.isChecked().catch(() => true))) await box.check({ force: true }).catch(() => undefined);
}

async function pressFirst(page: Page, ids: string[]): Promise<boolean> {
  for (const id of ids) if (await clickWorkday(page, id)) return true;
  const button = page.getByRole("button", { name: /^(create account|sign in|submit|verify|continue|reset password|send|send email|request)$/i }).first();
  if ((await button.count()) === 0) return false;
  await button.click({ timeout: 10_000 });
  await settle(page);
  return true;
}

const RESET_SENT_RE = /we('ve| have) sent|check your (email|inbox)|password reset (email|link).{0,20}sent|reset (email|link) (has been )?sent/i;

async function submitForgotPassword(page: Page, email: string, log: (m: string) => void): Promise<boolean> {
  await fillEmail(page, email);
  await page.keyboard.press("Tab").catch(() => undefined);
  await delay(400);
  const clicked = await pressFirst(page, [
    "resetPasswordButton",
    "forgotPasswordSubmitButton",
    "resetPasswordSubmitButton",
    "authForgotPasswordSubmitButton",
    "submitButton",
  ]);
  if (!clicked) {
    const named = page.getByRole("button", { name: /reset|send|submit|continue/i }).filter({ visible: true }).first();
    if ((await named.count()) > 0) {
      await named.click({ timeout: 10_000 }).catch(() => undefined);
      await settle(page);
    }
  }
  for (let i = 0; i < 8; i++) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (RESET_SENT_RE.test(body)) {
      log("  Workday: reset email sent (page confirmed)");
      return true;
    }
    await delay(500);
  }
  if (clicked) {
    log("  Workday: reset password clicked; waiting for the email");
    return true;
  }
  log("  Workday: forgot-password submit did not show a sent confirmation");
  return false;
}

/** Posting URL → `/apply/applyManually`, stripping query strings and stacked `/apply` tails. */
export function applyManuallyUrl(url: string): string {
  const clean = url.split("?")[0].replace(/\/$/, "");
  if (!/\/job\//.test(clean)) return url;
  return `${clean.replace(/\/apply(\/.*)?$/i, "")}/apply/applyManually`;
}

/**
 * Gets a Workday posting to its application wizard: Apply → Apply Manually → account (create,
 * sign in, or reset the password through Gmail). Null when the wizard is on screen. The tab
 * stays open for the filler — closing it drops the session.
 */
export async function reachWorkdayForm(page: Page, entryUrl: string, input: WorkdayInput): Promise<TaskOutcome | null> {
  const log = input.log ?? (() => undefined);
  const tenant = workdayTenant(entryUrl);
  const host = new URL(entryUrl).hostname.toLowerCase();
  const formUrl = applyManuallyUrl(entryUrl);
  let account: StoredAccount | null = null;
  const ensureAccount = (): StoredAccount | TaskOutcome => {
    if (!isGmailConfigured()) {
      return park("account_required", "Workday needs an account; add Gmail in Settings so the runner can read its emails");
    }
    if (input.email.trim().toLowerCase() !== gmailUser()) {
      return park("account_required", `Workday account email ${input.email} is not the Gmail address in Settings, so its emails can't be read`);
    }
    account ??= accountFor(input.root, tenant, input.email.trim().toLowerCase());
    return account;
  };
  const readMail = async (since: Date, what: string, timeoutMs = MAIL_WAIT_MS): Promise<AccountMail | TaskOutcome> => {
    log(`  Workday ${what}; checking Gmail`);
    try {
      const mail = await waitForAccountMail({
        since,
        fromDomain: "workday",
        linkHost: host,
        extract: extractWorkdayMail,
        timeoutMs,
      });
      return mail ?? park("account_required", `Workday ${what}, but no email arrived in Gmail in time`);
    } catch (err) {
      return park("account_required", `Could not read Gmail for the Workday email: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`);
    }
  };
  const openForm = async () => {
    await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await settle(page);
  };

  if (await restoreSession(page.context(), WORKDAY_SITE, input.root)) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await settle(page);
  }

  const hadAccount = readAccount(input.root, tenant) !== null;
  let created = false;
  let signInSubmitted = false;
  let resetRequested = false;
  let resetDone = false;
  let mailSince = new Date(Date.now() - MAIL_SKEW_MS);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    await page.locator("[data-automation-id='legalNoticeAcceptButton']").click({ timeout: 1_500 }).catch(() => undefined);
    let screen: WorkdayScreen = "unknown";
    let error = "";
    try {
      ({ screen, error } = await readScreen(page));
    } catch {
      await settle(page);
      continue;
    }
    log(`  Workday screen: ${screen}${error ? ` (${error.slice(0, 80)})` : ""}`);
    switch (screen) {
      case "wizard":
        await saveSession(page.context(), WORKDAY_SITE, input.root).catch(() => 0);
        return null;
      case "already_applied":
        log("  Workday says this job was already applied to");
        return SUBMITTED;
      case "apply_button":
        if (!(await clickWorkday(page, "adventureButton"))) {
          if (!(await clickWorkday(page, "continueApplicationButton"))) {
            await clickWorkday(page, "continueButton");
            const named = page.getByRole("button", { name: /^(apply|apply now|continue application|continue)$/i }).filter({ visible: true }).first();
            if ((await named.count()) > 0) await named.click({ timeout: 5_000 }).catch(() => undefined);
            else {
              const link = page.getByRole("link", { name: /^(apply|apply now|continue application)$/i }).filter({ visible: true }).first();
              if ((await link.count()) > 0) await link.click({ timeout: 5_000 }).catch(() => undefined);
            }
          }
        }
        break;
      case "apply_dialog":
        await clickWorkday(page, "applyManually");
        break;
      case "account_choice": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        const signIn = hadAccount || created || resetDone || resetRequested;
        if (!(await clickWorkday(page, signIn ? "signInLink" : "createAccountLink"))) await clickWorkday(page, "signInLink");
        break;
      }
      case "create_account": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        if (!created && hadAccount) {
          log("  Workday: this email already has an account; signing in");
          if (!(await clickWorkday(page, "signInLink"))) await page.getByRole("button", { name: /^sign in$/i }).first().click().catch(() => undefined);
          await settle(page);
          break;
        }
        if (created && /\b(already|exists|in use|registered)\b/i.test(error)) {
          log("  Workday: this email already has an account; signing in instead");
          if (!(await clickWorkday(page, "signInLink"))) await page.getByText(/^sign in$/i).first().click().catch(() => undefined);
          await settle(page);
          break;
        }
        if (created) return park("account_required", `Workday did not accept the new account: ${error || "no message"}`);
        log(`  Workday: creating an account for ${acc.email}`);
        mailSince = new Date(Date.now() - MAIL_SKEW_MS);
        await fillEmail(page, acc.email);
        await fillNewPassword(page, acc.password);
        await tickAgreement(page);
        await pressFirst(page, ["createAccountSubmitButton"]);
        created = true;
        await delay(1_500);
        break;
      }
      case "sign_in": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        if (!hadAccount && !created && !resetDone && !resetRequested && (await clickWorkday(page, "createAccountLink"))) break;
        if (!signInSubmitted) {
          log("  Workday: signing in");
          await fillEmail(page, acc.email);
          const pw = (await passwordInputs(page)).first();
          await pw.fill(acc.password);
          await pressFirst(page, ["signInSubmitButton"]);
          signInSubmitted = true;
          await delay(1_500);
          break;
        }
        if (resetDone) return park("account_required", `Workday sign-in failed after a password reset: ${error || "no message"}`);
        log("  Workday: sign-in failed; resetting the password");
        mailSince = new Date(Date.now() - MAIL_SKEW_MS);
        if (!(await clickWorkday(page, "forgotPasswordLink"))) {
          await page.getByText(/forgot (your )?password/i).first().click({ timeout: 5_000 }).catch(() => undefined);
          await settle(page);
        }
        resetRequested = true;
        signInSubmitted = false;
        break;
      }
      case "forgot_password": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        mailSince = new Date(Date.now() - MAIL_SKEW_MS);
        const sent = await submitForgotPassword(page, acc.email, log);
        resetRequested = true;
        if (!sent) {
          return park("account_required", "Workday forgot-password did not confirm that a reset email was sent");
        }
        let mail = await readMail(mailSince, "sent a password reset email");
        if ("status" in mail) {
          log("  Workday: no fresh reset mail; looking back 12 hours");
          mail = await readMail(new Date(Date.now() - 12 * 60 * 60 * 1000), "sent a password reset email", 8_000);
        }
        if ("status" in mail) return mail;
        if (!mail.link) return park("account_required", "Workday sent a reset email with no link");
        await page.goto(mail.link, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        break;
      }
      case "set_password": {
        const acc = ensureAccount();
        if ("status" in acc) return acc;
        log("  Workday: setting the new password");
        await fillNewPassword(page, acc.password);
        await pressFirst(page, ["resetPasswordSubmitButton", "changePasswordSubmitButton", "submitButton", "resetPasswordButton"]);
        resetDone = true;
        signInSubmitted = false;
        await delay(1_500);
        await openForm();
        break;
      }
      case "code": {
        const mail = await readMail(mailSince, "asked for an emailed code");
        if ("status" in mail) return mail;
        if (!mail.code) return park("account_required", "Workday asked for an emailed code, but the email had none");
        const input2 = page.locator("input[autocomplete='one-time-code'], input[name*='code' i], input[id*='verificationCode' i]").filter({ visible: true }).first();
        await input2.fill(mail.code);
        await pressFirst(page, ["verifyButton", "submitButton"]);
        break;
      }
      case "verify_notice": {
        const mail = await readMail(mailSince, "asked to verify the account email");
        if ("status" in mail) return mail;
        if (!mail.link) return park("account_required", "Workday asked to verify the email, but the email had no link");
        await page.goto(mail.link, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        await openForm();
        break;
      }
      case "unknown": {
        await clickWorkday(page, "adventureButton");
        await clickWorkday(page, "continueApplicationButton");
        const apply = page.getByRole("button", { name: /apply|continue application/i }).filter({ visible: true }).first();
        if ((await apply.count()) > 0) await apply.click({ timeout: 5_000 }).catch(() => undefined);
        await clickWorkday(page, "applyManually");
        if (round >= 2) await openForm();
        if (created || signInSubmitted || resetRequested || resetDone) break;
        if (round < 8) break;
        return park("account_required", "Workday's account steps did not reach the application form");
      }
    }
    await delay(800);
  }
  return park("account_required", "Workday's account steps did not reach the application form");
}
