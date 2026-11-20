import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { Lease } from "@/lib/browser/manager";
import {
  applyAction,
  clickStamped,
  delay,
  fillSecurityCode,
  jitter,
  pageState,
  readAnswers,
  readComboOptions,
  readStampedValues,
  runExtensionFill,
  scanFields,
  settle,
  unreadRequired,
  uploadResume,
  type OptionChooser,
  type PageState,
  type ScannedField,
} from "./browser-fill";
import { chooseOption } from "./choose-option";
import { atsQuirks } from "./vendors/quirks";
import { internationalNumber } from "./countries";
import { blockSearch, isSearchCombo } from "./form-sections";
import { gmailUser, isGmailConfigured, submittedByEmail, waitForSecurityCode } from "./gmail";
import { mapLabelToProfileKey } from "./profile-map";
import { auditPage, findContradictions, type FillIntent } from "./audit";
import { emptyFactSheet } from "./facts";
import { CAPTCHA_REASON, SUBMITTED, fail, needsAnswer, optionalResolution, park, ready, type TaskOutcome } from "./outcome";
import type { ResolveContext } from "./context";
import { recordAsk, resolveFields, staleShownValue, type Resolution } from "./resolve";
import { sourceName, type ReviewAnswer } from "./review-sample";
import { SECURITY_CODE_REASONS } from "./security-code";
import type { ApplyVendor, ProfileValues } from "./types";
import { applicationEntryUrl, isLinkedInUrl } from "./vendor";
import { isIcimsUrl, reachIcimsForm } from "./icims";
import { isWorkdayUrl, reachWorkdayForm } from "./workday";

export interface AtsTaskInput {
  taskId: string;
  url: string;
  ctx: ResolveContext;
  extensionProfile: Record<string, unknown>;
  resumePath: string | null;
  root: string;
  dryRun: boolean;
  /** Someone is at the Mac to solve a captcha in the Chrome window. */
  attended: boolean;
  /** Look run: leave the tab open for the user and stop at a captcha. Used with `dryRun`. */
  keepOpen?: boolean;
  /** Filled in with what the form shows, for the review samples. */
  review: ReviewAnswer[];
}

const MAX_STEPS = 6;
/** Information, experience, questions, disclosures, self-identify, review, submit. */
const WORKDAY_MAX_STEPS = 8;
const CONFIRM_WAIT_MS = 25_000;
const CAPTCHA_WAIT_MS = 180_000;
/** How long a form gets to finish its own submit after a captcha before we touch it. */
const AFTER_CAPTCHA_MS = 20_000;
const VERIFY_ERROR_RE = /\b(error verifying|verification (failed|error)|captcha)\b/i;
const MISSING_ANSWER_RE = /\b(missing entry|required field|field is required|is required|this question is required|please (fill|complete|answer))\b/i;
const SECURITY_CODE_WAIT_MS = 90_000;
const PLACE_KEYS = new Set(["country", "city", "location"]);
/** How long the code field may stay on screen after we submit the code before it counts as rejected. */
const AFTER_CODE_MS = 15_000;
/** Allows for clock skew between this Mac and Gmail's received time. */
const MAIL_SKEW_MS = 30_000;

/**
 * Lever's résumé parser: "wait" while it runs, "done" once it showed a result, "none" off Lever.
 * A string, not a function: tsx rewrites nested functions to call `__name`, which the page lacks.
 */
const LEVER_PARSE_STATE = `(() => {
  const shown = (sel) => { const el = document.querySelector(sel); return !!(el && getComputedStyle(el).display !== "none"); };
  if (!document.querySelector(".resume-upload-working")) return "none";
  if (shown(".resume-upload-success") || shown(".resume-upload-failure") || shown(".resume-upload-oversize")) return "done";
  const file = document.querySelector("#resume-upload-input");
  return shown(".resume-upload-working") || (file && file.files && file.files.length > 0) ? "wait" : "none";
})()`;
const LEVER_PARSE_WAIT_MS = 12_000;

/** Saves what the page showed when the submit outcome is unclear: `.cache/apply-shots/<task>.png` plus a log line. */
async function recordUnclearPage(page: Page, input: AtsTaskInput): Promise<void> {
  try {
    const dir = path.join(input.root, ".cache", "apply-shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${input.taskId}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const headings = await page
      .evaluate(() =>
        [...document.querySelectorAll("h1, h2, h3, [role='alert']")]
          .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 6)
          .join(" | "),
      )
      .catch(() => "");
    input.ctx.log?.(`  page after submit: ${page.url()}`);
    if (headings) input.ctx.log?.(`  headings: ${headings.slice(0, 300)}`);
    input.ctx.log?.(`  screenshot: ${file}`);
  } catch {
    // Diagnostics only.
  }
}

/** Emailed one-time-code pages: Greenhouse's spam check, or Oracle Candidate Experience. */
function isGreenhouseSecurityPage(page: Page, input: AtsTaskInput): boolean {
  if (input.ctx.vendor === "greenhouse") return true;
  const url = page.url();
  return /greenhouse\.io|job_app|grnhse/i.test(url) || /oraclecloud\.com.*\/apply\/email/i.test(url);
}

/**
 * Greenhouse's spam check emailed a one-time code. Reads it from Gmail, types it in, and
 * submits again. Null means the code went in and the caller should keep waiting for confirmation.
 */
async function enterSecurityCode(
  page: Page,
  input: AtsTaskInput,
  ids: string[],
  since: Date,
): Promise<TaskOutcome | null> {
  if (!isGmailConfigured()) return park("security_code", SECURITY_CODE_REASONS.noMail);
  const formEmail = input.ctx.profile.email.trim().toLowerCase();
  if (formEmail && formEmail !== gmailUser()) {
    return park("security_code", SECURITY_CODE_REASONS.mismatch(formEmail));
  }

  input.ctx.log?.("  Greenhouse asked for an email security code; checking Gmail");
  let code: string | null;
  try {
    code = await waitForSecurityCode({ since, company: input.ctx.company, timeoutMs: SECURITY_CODE_WAIT_MS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return park("security_code", `Could not read Gmail for the security code: ${message.slice(0, 120)}`);
  }
  if (!code) return park("security_code", SECURITY_CODE_REASONS.noCode);
  if (!(await fillSecurityCode(page, ids, code))) {
    return park("security_code", "Could not type the emailed security code into the form");
  }

  input.ctx.log?.("  security code entered; submitting again");
  await jitter(500, 1_200);
  const fresh = await pageState(page, input.root).catch(() => null);
  if (fresh?.confirmation) return SUBMITTED;
  if (fresh?.submitId) await clickStamped(page, fresh.submitId);
  else await page.keyboard.press("Enter");
  return null;
}
/**
 * Unattended: park for Apply now. Attended: wait for the user to solve it.
 * Null means the captcha is gone and the flow should carry on.
 */
async function handleCaptcha(page: Page, input: AtsTaskInput): Promise<TaskOutcome | null> {
  if (!input.attended) return park("captcha", CAPTCHA_REASON);
  input.ctx.log?.("  Solve the captcha in the Chrome window (waiting up to 3 minutes)");
  await page.bringToFront().catch(() => undefined);
  const deadline = Date.now() + CAPTCHA_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(2_000);
    const state = await pageState(page, input.root).catch(() => null);
    if (!state) continue;
    if (state.confirmation) return SUBMITTED;
    if (!state.captcha) return null;
  }
  return park("captcha", CAPTCHA_REASON);
}

function short(labels: string[]): string {
  const list = labels.map((l) => (l.length > 60 ? `${l.slice(0, 57)}…` : l));
  return list.slice(0, 4).join("; ") + (list.length > 4 ? ` (+${list.length - 4} more)` : "");
}

/** The posting redirected to the company's job list: the job id is gone from the URL. */
function postingGone(original: string, current: string, vendor: ApplyVendor): boolean {
  if (!atsQuirks(vendor).closedDropsJobId) return false;
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(original)?.[0];
  return Boolean(id && !current.toLowerCase().includes(id.toLowerCase()));
}

const COOKIE_BUTTONS = ["Decline all", "Reject all", "Decline optional cookies", "Accept all", "Accept all cookies", "ACCEPT", "Accept"];
const PRIVACY_BUTTONS = [/^I Agree$/i, /^I agree$/i, /^Agree$/i];

/** A cookie banner over the form makes every later click time out (Workable). Optional cookies are declined. */
async function dismissCookieBanner(page: Page): Promise<void> {
  for (const name of COOKIE_BUTTONS) {
    const button = page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      await delay(300);
      return;
    }
  }
}

/** Career-site privacy notice over Apply Now (Qualcomm). */
async function dismissPrivacyNotice(page: Page): Promise<void> {
  for (const name of PRIVACY_BUTTONS) {
    const button = page.getByRole("button", { name }).filter({ visible: true }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      await delay(400);
      return;
    }
  }
}

/** iCIMS GDPR / cookie intro whose only control is "click here" or "I understand". */
async function dismissIcimsCookieIntro(page: Page): Promise<boolean> {
  if (!isIcimsUrl(page.url())) return false;
  for (const name of [/^(click here|i understand)$/i, /click here/i, /i understand/i]) {
    const link = page.getByRole("link", { name }).filter({ visible: true }).first();
    if (await link.isVisible().catch(() => false)) {
      await link.click({ timeout: 5_000 }).catch(() => undefined);
      await settle(page);
      return true;
    }
    const button = page.getByRole("button", { name }).filter({ visible: true }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      await settle(page);
      return true;
    }
  }
  return false;
}

/** Gets from the posting to a page with the application form, following one Apply link if needed. */
async function reachForm(
  page: Page,
  root: string,
): Promise<{ page: Page; state: PageState } | TaskOutcome> {
  await dismissCookieBanner(page);
  await dismissPrivacyNotice(page);
  let state = await pageState(page, root);
  if (state.closed && !state.hasForm) return fail("closed", "Posting is closed");
  if (state.hasForm) return { page, state };

  if (state.greenhouseFrame) {
    await page.goto(state.greenhouseFrame, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await settle(page);
    state = await pageState(page, root);
    if (state.hasForm) return { page, state };
  }

  if (state.icimsFrame && !page.frame({ name: "icims_content_iframe" })) {
    await page.goto(state.icimsFrame, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await settle(page);
    state = await pageState(page, root);
    if (state.hasForm) return { page, state };
  }

  if (await dismissIcimsCookieIntro(page)) {
    state = await pageState(page, root);
    if (state.hasForm) return { page, state };
    if (state.icimsFrame && !page.frame({ name: "icims_content_iframe" })) {
      await page.goto(state.icimsFrame, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await settle(page);
      state = await pageState(page, root);
      if (state.hasForm) return { page, state };
    }
  }

  await dismissPrivacyNotice(page);
  state = await pageState(page, root);

  if (state.applyLinkId) {
    const href = await page
      .locator(`[data-jr-id="${state.applyLinkId}"]`)
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (href && isLinkedInUrl(new URL(href, page.url()).toString())) {
      return park("linkedin", "Apply link goes to LinkedIn");
    }
    const popup = page.waitForEvent("popup", { timeout: 6_000 }).catch(() => null);
    await clickStamped(page, state.applyLinkId);
    const opened = await popup;
    const target = opened ?? page;
    await settle(target);
    if (isLinkedInUrl(target.url())) return park("linkedin", "Apply link goes to LinkedIn");
    state = await pageState(target, root);
    if (state.hasForm) return { page: target, state };
    page = target;
  }

  const fields = await scanFields(page, root);
  if (fields.filter((f) => f.control !== "file").length >= 3) {
    return { page, state: await pageState(page, root) };
  }
  return park("no_form", "No application form found on the page");
}

async function fillStep(
  page: Page,
  input: AtsTaskInput,
  profile: ProfileValues,
  sources: Map<string, string>,
  intents: Map<string, FillIntent>,
  /** Also fill these, even when the form does not mark them required or they already hold a value. */
  force?: (field: ScannedField) => boolean,
): Promise<{
  asked: number;
  parked: string | null;
  ineligible: string | null;
  unresolved: string[];
  fileAsk: string | null;
  notUnderstood: string[];
}> {
  let fields = await scanFields(page, input.root);
  const uploaded = await uploadResume(page, fields, input.resumePath);
  if (uploaded) input.ctx.log?.("  uploaded resume");
  // Lever's parser writes the résumé's place over a chosen location suggestion when it finishes, and
  // the extension may have attached the file (starting the parser) before this step, so wait it out first.
  if ((await page.evaluate(LEVER_PARSE_STATE).catch(() => "none")) === "wait") {
    const deadline = Date.now() + LEVER_PARSE_WAIT_MS;
    while (Date.now() < deadline && (await page.evaluate(LEVER_PARSE_STATE).catch(() => "wait")) === "wait") {
      await delay(200);
    }
    fields = await scanFields(page, input.root);
  } else if (uploaded) {
    await delay(1_500);
    fields = await scanFields(page, input.root);
  }
  // Lever prefills location from the résumé as plain text; only a picked suggestion fills #selected-location.
  const leverPlace = (await page.locator("#selected-location").count()) > 0;

  const shown = await readStampedValues(page).catch(() => new Map<string, string>());
  const leftover = new Set(
    fields.filter((f) => staleShownValue(f, shown.get(f.id) || f.shown || "", profile)).map((f) => f.id),
  );
  if (leftover.size > 0) {
    input.ctx.log?.(
      `  leftover overwrite: ${fields.filter((f) => leftover.has(f.id)).map((f) => f.label.slice(0, 40)).join("; ")}`,
    );
  }
  // Optional questions are tried too; one that cannot be answered stays blank (`optionalResolution`).
  const targets = fields.filter(
    (f) =>
      (f.empty && (f.required || f.control !== "file")) ||
      leftover.has(f.id) ||
      (f.control !== "file" && force?.(f)) ||
      (leverPlace && f.control === "combobox" && mapLabelToProfileKey(f) === "location"),
  );
  const fileAsk = targets.find((f) => f.control === "file")?.label ?? null;

  let asked = 0;
  let parked: string | null = null;
  let ineligible: string | null = null;
  const tried = new Set<string>();
  /** Left blank on purpose by a rule or saved answer; not an unfilled required field. */
  const skipped = new Set<string>();

  // Place comboboxes resolve to the profile value without a list; opening them first is a wasted gesture.
  const withOptions = async (field: ScannedField): Promise<ScannedField> => {
    const isPlace = PLACE_KEYS.has(mapLabelToProfileKey(field) ?? "");
    const placeSearch = isPlace && !/\b(preference|preferred)\b/i.test(field.label);
    return field.control === "combobox" && field.options.length === 0 && !placeSearch && !isSearchCombo(field)
      ? { ...field, options: await readComboOptions(page, field.id, field.label) }
      : field;
  };

  const fillOne = async (target: ScannedField, resolved: Resolution | undefined): Promise<void> => {
    const field = target;
    const required = target.required || Boolean(force?.(target));
    const res = required ? resolved : optionalResolution(resolved);
    if (!required && res?.kind === "skip" && resolved?.kind !== "skip") {
      sources.set(field.id, "not filled");
      input.ctx.log?.(`  left blank: ${target.label.slice(0, 70)}`);
      return;
    }
    if (!res || res.kind === "classify") {
      sources.set(field.id, "not filled");
      return;
    }
    if (res.kind === "ask") {
      const unreadable = await recordAsk(input.taskId, res, input.ctx);
      if (unreadable) {
        parked ??= unreadable;
        sources.set(field.id, "not filled");
        input.ctx.log?.(`  park: ${unreadable}`);
        return;
      }
      sources.set(field.id, "asked you");
      asked += 1;
      input.ctx.log?.(`  ask: ${(res.fact?.question ?? res.field.label).slice(0, 80)} (${res.reason})`);
      return;
    }
    if (res.kind === "park") {
      parked ??= res.reason;
      sources.set(field.id, "not filled");
      input.ctx.log?.(`  park: ${res.reason}`);
      return;
    }
    if (res.kind === "skip") {
      skipped.add(field.id);
      return;
    }
    if (res.kind === "ineligible") {
      ineligible ??= res.reason;
      sources.set(field.id, "not filled");
      input.ctx.log?.(`  ineligible: ${res.reason}`);
      return;
    }

    // School and degree from the resume record: try each search, take only an unambiguous row.
    const search = res.source === "heuristic" && res.action.type === "literal" ? blockSearch(target.label) : null;
    const choose: OptionChooser = search
      ? async (query, _wanted, options) => {
          const pick = search.choose(query, options);
          if (!pick) input.ctx.log?.(`  no school row for ${JSON.stringify(query)}: ${options.slice(0, 6).join(" | ").slice(0, 160) || "(none)"}`);
          return pick;
        }
      : async (query, wanted, options) => {
          const choice = await chooseOption({ label: target.label, query, wanted, options, ctx: input.ctx });
          if (choice) input.ctx.log?.(`  picked [${choice.source}] ${choice.option.slice(0, 60)}`);
          return choice?.option ?? null;
        };
    let ok = await applyAction(page, target, res.action, profile, choose, search?.searches, Boolean(force) || leftover.has(target.id));
    const placeKey = mapLabelToProfileKey(target);
    // A react-select school or city can report a pick then drop it; type the record as text instead.
    if (ok && (search || PLACE_KEYS.has(placeKey ?? ""))) {
      const now = await scanFields(page, input.root).catch(() => []);
      if (now.find((f) => f.id === target.id)?.empty) ok = false;
    }
    // A list with no fitting row may still take the name as typed; the audit parks it if the box drops it.
    if (!ok && search) {
      ok = await applyAction(page, { ...target, control: "text" }, res.action, profile);
      if (ok) {
        const now = await scanFields(page, input.root).catch(() => []);
        if (now.find((f) => f.id === target.id)?.empty) ok = false;
      }
    }
    if (!ok && PLACE_KEYS.has(placeKey ?? "") && target.control === "combobox") {
      const city = profile.city || profile.location.split(",")[0]?.trim();
      if (city) ok = await applyAction(page, { ...target, control: "text" }, { type: "literal", value: city }, profile);
    }
    if (!ok && search && required) {
      parked ??= `No row fits the record on file for: ${target.label.slice(0, 80)}`;
      sources.set(field.id, "not filled");
      input.ctx.log?.(`  park: ${target.label.slice(0, 80)} (no fitting row in the search results)`);
      return;
    }
    sources.set(field.id, ok ? sourceName(res.source) : "not filled");
    if (ok) intents.set(field.id, { field: target, action: res.action, source: res.source, grounds: res.grounds ?? [] });
    input.ctx.log?.(
      `  ${ok ? "filled" : "fill failed"} [${res.source}] ${target.label.slice(0, 70)}${
        ok ? "" : ` (${target.control} ${target.options.slice(0, 6).join("|") || "no options"})`
      }`,
    );
    await jitter(250, 700);
  };

  const fillBatch = async (batch: ScannedField[]): Promise<void> => {
    const ready: ScannedField[] = [];
    for (const field of batch) {
      tried.add(field.id);
      if (field.control !== "file") ready.push(await withOptions(field));
    }
    const resolved = await resolveFields(ready, input.ctx);
    for (const field of ready) await fillOne(field, resolved.get(field.id));
  };

  await fillBatch(targets);
  // A dropdown the extension typed into can read as filled, then clear on blur (react-select);
  // an answer can also reveal a follow-up question. The same id must be tried again when it dropped.
  const later = await scanFields(page, input.root);
  const cleared = later.filter((f) => f.empty && f.required && !tried.has(f.id));
  const dropped = later.filter((f) => f.empty && f.required && tried.has(f.id) && !skipped.has(f.id));
  if (cleared.length > 0) await fillBatch(cleared);
  if (dropped.length > 0) {
    input.ctx.log?.(`  retry emptied: ${dropped.map((f) => f.label.slice(0, 40)).join("; ")}`);
    await fillBatch(dropped);
  }
  let after = cleared.length > 0 || dropped.length > 0 ? await scanFields(page, input.root) : later;
  const stillStale = after.filter((f) => staleShownValue(f, f.shown || "", profile));
  if (stillStale.length > 0) {
    input.ctx.log?.(`  leftover overwrite: ${stillStale.map((f) => f.label.slice(0, 40)).join("; ")}`);
    await fillBatch(stillStale);
    after = await scanFields(page, input.root);
  }
  const unresolved = after
    .filter((f) => f.empty && f.required && f.control !== "file" && !skipped.has(f.id))
    .map((f) => f.label || f.control);
  return {
    asked,
    parked,
    ineligible,
    unresolved,
    fileAsk: after.some((f) => f.control === "file" && f.empty && f.required) ? fileAsk : null,
    notUnderstood: await unreadRequired(page, input.root).catch(() => []),
  };
}

const CHOICE_CONTROLS = new Set(["radio", "checkbox", "select", "combobox"]);

/** Question names in "Missing entry for required field: X" errors; "" where the form names none. */
function missingNames(errors: string[]): string[] {
  return errors
    .filter((e) => MISSING_ANSWER_RE.test(e))
    .map((e) => (/required field:?\s*(.*)$/i.exec(e)?.[1] ?? "").replace(/[*✱]/g, "").trim());
}

function sameQuestion(label: string, name: string): boolean {
  const a = label.toLowerCase().replace(/[*✱]/g, "").replace(/\s+/g, " ").trim();
  const b = name.toLowerCase().replace(/…$/, "").trim();
  return Boolean(a && b) && (a.includes(b) || b.includes(a));
}

/**
 * After the form rejected the submit for missing answers: fills exactly the questions it named
 * (or, when it named none, the empty choice questions it did not mark required), once.
 * Returns false when nothing on the page matches, so the job parks instead.
 */
async function refillMissing(
  page: Page,
  input: AtsTaskInput,
  sources: Map<string, string>,
  intents: Map<string, FillIntent>,
  errors: string[],
): Promise<boolean> {
  const names = missingNames(errors);
  if (names.length === 0) return false;
  const named = names.filter(Boolean);
  const unnamed = names.some((n) => !n);
  const fields = await scanFields(page, input.root);
  const wanted = (f: ScannedField) =>
    named.some((n) => sameQuestion(f.label, n)) || (unnamed && f.empty && (f.required || CHOICE_CONTROLS.has(f.control)));
  const matches = fields.filter(wanted);
  if (matches.length === 0) return false;
  input.ctx.log?.(`  form said answers are missing; filling again: ${short(matches.map((f) => f.label))}`);

  const isPhone = (f: ScannedField) => mapLabelToProfileKey(f) === "phone";
  const phone = internationalNumber(input.ctx.profile.phone ?? "", input.ctx.profile.country);
  for (const f of matches.filter(isPhone)) {
    if (!phone) continue;
    const action = { type: "literal" as const, value: phone };
    if (await applyAction(page, f, action, input.ctx.profile, undefined, undefined, true)) {
      intents.set(f.id, { field: f, action, source: "heuristic", grounds: [] });
      sources.set(f.id, "profile");
    }
  }
  await fillStep(page, input, input.ctx.profile, sources, intents, (f) => wanted(f) && !isPhone(f));
  return true;
}

/** Records what each question shows now; later steps add to earlier ones. */
async function captureReview(
  page: Page,
  input: AtsTaskInput,
  sources: Map<string, string>,
  review: Map<string, ReviewAnswer>,
): Promise<void> {
  const answers = await readAnswers(page, input.root).catch(() => []);
  for (const a of answers) {
    if (!a.value && !a.required) continue;
    const source = sources.get(a.id) ?? (a.value ? "prefilled" : "not filled");
    review.set(a.id, { label: a.label || "(no label)", value: a.value, source });
  }
  input.review.splice(0, input.review.length, ...review.values());
}

/** Puts the resume back when the form cleared its file input. */
async function reattachResume(page: Page, input: AtsTaskInput): Promise<void> {
  const fields = await scanFields(page, input.root).catch(() => []);
  if (await uploadResume(page, fields, input.resumePath)) {
    input.ctx.log?.("  resume was cleared; attached it again");
    await delay(1_500);
  }
}

/**
 * After the first Submit click: waits for confirmation, typing an emailed security code or
 * waiting out a captcha as the form needs. Forms that submit themselves after the captcha
 * (see `AtsQuirks.submitsAfterCaptcha`) are never clicked again.
 */
async function waitForOutcome(page: Page, input: AtsTaskInput): Promise<TaskOutcome> {
  let deadline = Date.now() + CONFIRM_WAIT_MS;
  let captchaSeen = false;
  let quietUntil = 0;
  let retries = 0;
  let lastErrors: string[] = [];
  const mailSince = new Date(Date.now() - MAIL_SKEW_MS);
  let codeSentAt = 0;
  while (Date.now() < deadline) {
    await delay(1_500);
    const state = await pageState(page, input.root).catch(() => null);
    if (!state) continue;
    if (state.confirmation) return SUBMITTED;
    if (state.securityCodeIds.length > 0 && !state.captcha && isGreenhouseSecurityPage(page, input)) {
      if (codeSentAt === 0) {
        const blocked = await enterSecurityCode(page, input, state.securityCodeIds, mailSince);
        if (blocked) return blocked;
        codeSentAt = Date.now();
        deadline = codeSentAt + AFTER_CODE_MS + CONFIRM_WAIT_MS;
      } else if (Date.now() - codeSentAt > AFTER_CODE_MS) {
        return park("security_code", SECURITY_CODE_REASONS.rejected);
      }
      continue;
    }
    if (state.captcha) {
      const blocked = await handleCaptcha(page, input);
      if (blocked) return blocked;
      captchaSeen = true;
      quietUntil = Date.now() + AFTER_CAPTCHA_MS;
      deadline = quietUntil + CONFIRM_WAIT_MS;
      continue;
    }
    lastErrors = state.errors;
    const missing = lastErrors.filter((e) => MISSING_ANSWER_RE.test(e));
    if (missing.length > 0 && !captchaSeen) {
      await recordUnclearPage(page, input);
      return park("missing_answer", `Form says a required answer is missing: ${short(missing)}`);
    }
    if (captchaSeen && atsQuirks(input.ctx.vendor, page.url()).submitsAfterCaptcha) {
      const verifyError = lastErrors.some((e) => VERIFY_ERROR_RE.test(e));
      if (verifyError) {
        await recordUnclearPage(page, input);
        return park("form_rejected", `Form rejected the submit: ${short(lastErrors)}`);
      }
      if (retries === 0 && Date.now() >= quietUntil) {
        retries = 1;
        input.ctx.log?.("  captcha cleared; waiting for the form to finish its own submit");
      }
      continue;
    }
    if (!captchaSeen || Date.now() < quietUntil || !state.submitId) continue;

    const verifyError = lastErrors.some((e) => VERIFY_ERROR_RE.test(e));
    if (!(retries === 0 || (retries === 1 && verifyError))) continue;
    retries += 1;
    await reattachResume(page, input);
    const fresh = await pageState(page, input.root).catch(() => null);
    if (fresh?.confirmation) return SUBMITTED;
    if (!fresh?.submitId) continue;
    input.ctx.log?.(`  form still open after the captcha; clicking Submit (${retries})`);
    await jitter(800, 1_500);
    await clickStamped(page, fresh.submitId);
    quietUntil = Date.now() + AFTER_CAPTCHA_MS;
    deadline = quietUntil + CONFIRM_WAIT_MS;
  }
  await recordUnclearPage(page, input);
  if (lastErrors.length > 0) {
    return park("form_rejected", `Form rejected the submit: ${short(lastErrors)}`);
  }
  if (
    await submittedByEmail({
      since: mailSince,
      company: input.ctx.company,
      jobTitle: input.ctx.jobTitle,
      timeoutMs: SECURITY_CODE_WAIT_MS,
      log: input.ctx.log,
    })
  ) {
    return SUBMITTED;
  }
  return park("no_confirmation", "Submitted but no confirmation page or submission email seen");
}

/** One Greenhouse / Lever / Ashby / Workable / generic application, start to finish. */
export async function runAtsTask(lease: Lease, input: AtsTaskInput): Promise<TaskOutcome> {
  const profile = input.ctx.profile;
  const page = await lease.newPage();
  const entry = applicationEntryUrl(input.url, input.ctx.vendor, input.ctx.company);
  let res = await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (res && res.status() === 404 && entry !== input.url) {
    res = await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  if (res && (res.status() === 404 || res.status() === 410)) return fail("closed", "Posting is closed (page not found)");
  await settle(page);
  if (isLinkedInUrl(page.url())) return park("linkedin", "Redirected to LinkedIn");
  if (postingGone(input.url, page.url(), input.ctx.vendor)) return fail("closed", "Posting is closed (sent back to the job board)");

  const workday = isWorkdayUrl(page.url());
  if (workday) {
    const blocked = await reachWorkdayForm(page, entry, { root: input.root, email: profile.email, log: input.ctx.log });
    if (blocked) return blocked;
  }

  const icims = isIcimsUrl(page.url()) || isIcimsUrl(entry);
  if (icims) {
    const shell = await pageState(page, input.root);
    if (shell.icimsFrame && !page.frame({ name: "icims_content_iframe" })) {
      await page.goto(shell.icimsFrame, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await settle(page);
    }
    const blocked = await reachIcimsForm(page, page.url().includes("icims.com") ? page.url() : entry, {
      root: input.root,
      email: profile.email,
      log: input.ctx.log,
    });
    if (blocked) return blocked;
  }

  const reached = await reachForm(page, input.root);
  if ("status" in reached) return reached;
  const formPage = reached.page;
  if (reached.state.loginWall && !icims) return park("account_required", "The job site wants its own account login to apply");
  if (reached.state.closed && !reached.state.hasForm) return fail("closed", "Posting is closed");
  await dismissCookieBanner(formPage);

  const filled = await runExtensionFill(formPage, input.root, input.extensionProfile);
  input.ctx.log?.(`  extension filled ${filled} field(s)`);
  await dismissCookieBanner(formPage);
  await delay(600);

  const sources = new Map<string, string>();
  const review = new Map<string, ReviewAnswer>();
  const intents = new Map<string, FillIntent>();
  let refilled = false;
  const maxSteps = workday ? WORKDAY_MAX_STEPS : MAX_STEPS;
  for (let step = 0; step < maxSteps; step++) {
    const { asked, parked, ineligible, unresolved, fileAsk, notUnderstood } = await fillStep(formPage, input, profile, sources, intents);
    await captureReview(formPage, input, sources, review);
    if (ineligible) return fail("ineligible", ineligible);
    if (notUnderstood.length > 0) {
      await recordUnclearPage(formPage, input);
      return park("not_understood", `Form not understood, required question not read: ${short(notUnderstood)}`);
    }

    if (unresolved.length > 0) {
      if (asked > 0) {
        return needsAnswer(`${asked} question${asked === 1 ? " needs" : "s need"} your answer`);
      }
      if (parked) return park("cannot_answer", parked);
      return park("cannot_answer", `Could not fill: ${short(unresolved)}`);
    }
    if (fileAsk) {
      const reason = /cover|anschreiben|motivation/i.test(fileAsk) ? "Cover letter file required" : `Asks for a file upload: ${short([fileAsk])}`;
      return park("file_required", reason);
    }

    let state = await pageState(formPage, input.root);
    if (state.captcha && input.keepOpen) {
      return park("captcha", "Captcha on the form; filled up to it and left open");
    }
    if (state.captcha && !input.dryRun) {
      const blocked = await handleCaptcha(formPage, input);
      if (blocked) return blocked;
      state = await pageState(formPage, input.root);
    }
    if (state.loginWall && !icims) return park("account_required", "The job site wants its own account login to apply");
    // Workday paints "Save and Continue" several seconds after the progress bar, and greys it out while the last field validates.
    const waitForNav = workday ? 16 : 6;
    for (let i = 0; i < waitForNav && !state.submitId && !state.nextId; i++) {
      await delay(1_500);
      state = await pageState(formPage, input.root);
    }

    if (state.submitId || state.nextId) {
      let shown = await readAnswers(formPage, input.root).catch(() => []);
      const fields = await scanFields(formPage, input.root).catch(() => []);
      const staleIds = new Set(
        fields
          .filter((f) => {
            const value = shown.find((s) => s.id === f.id)?.value || f.shown || "";
            return staleShownValue(f, value, profile);
          })
          .map((f) => f.id),
      );
      if (staleIds.size > 0) {
        input.ctx.log?.(
          `  leftover overwrite: ${fields.filter((f) => staleIds.has(f.id)).map((f) => f.label.slice(0, 40)).join("; ")}`,
        );
        await fillStep(formPage, input, profile, sources, intents, (f) => staleIds.has(f.id));
        shown = await readAnswers(formPage, input.root).catch(() => []);
      }
      const problems = auditPage({ intents, shown, facts: input.ctx.facts ?? emptyFactSheet(), profile });
      if (problems.length > 0) {
        for (const p of problems) input.ctx.log?.(`  audit: ${p}`);
        await recordUnclearPage(formPage, input);
        return park("audit_failed", `Pre-submit check failed: ${short(problems)}`);
      }
    }

    if (state.submitId) {
      const conflicts = await findContradictions(
        [...review.values()].map((r) => ({ label: r.label, value: r.value })),
        input.ctx.facts ?? emptyFactSheet(),
        input.ctx.job,
      );
      if (conflicts === null) input.ctx.log?.("  contradiction check unavailable; deterministic checks passed");
      else if (conflicts.length > 0) {
        for (const c of conflicts) input.ctx.log?.(`  audit: ${c}`);
        return park("contradiction", `Answers contradict each other: ${short(conflicts)}`);
      }
      if (input.dryRun) return ready("Dry run: every required field filled and checked, ready to submit");
      if (state.securityCodeIds.length > 0 && isGreenhouseSecurityPage(formPage, input)) {
        const blocked = await enterSecurityCode(formPage, input, state.securityCodeIds, new Date(Date.now() - MAIL_SKEW_MS));
        if (blocked) return blocked;
        state = await pageState(formPage, input.root);
        if (state.confirmation) return SUBMITTED;
      }
      await jitter(1_000, 2_500);
      await dismissPrivacyNotice(formPage);
      if (state.submitId) await clickStamped(formPage, state.submitId);
      const outcome = await waitForOutcome(formPage, input);
      if (!refilled && outcome.status === "NEEDS_YOU" && outcome.code === "missing_answer") {
        refilled = true;
        const errors = (await pageState(formPage, input.root).catch(() => null))?.errors ?? [];
        // Back through fill, audit and the contradiction check before the second submit.
        if (await refillMissing(formPage, input, sources, intents, errors)) continue;
      }
      return outcome;
    }
    if (state.nextId) {
      await clickStamped(formPage, state.nextId);
      await settle(formPage);
      continue;
    }
    return park("no_submit", "No submit button found");
  }
  return park("too_many_steps", `More than ${maxSteps - 1} form steps`);
}
