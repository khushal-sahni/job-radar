import type { Locator, Page } from "playwright";
import type { Lease } from "@/lib/browser/manager";
import { NAUKRI_CHALLENGE_RE, NAUKRI_HEADER_LOGIN } from "@/lib/browser/naukri-session";
import { SUBMITTED, fail, needsAnswer, park, ready, type TaskOutcome } from "./outcome";
import { delay, jitter, settle } from "./browser-fill";
import { matchOption } from "./profile-map";
import { cleanOptionsForLabel, naukriQuestion } from "./options";
import type { ResolveContext } from "./context";
import { recordAsk, resolveFields, valueForAction } from "./resolve";
import { sourceName, type ReviewAnswer } from "./review-sample";
import type { FieldDescriptor } from "./types";

/**
 * Naukri apply in the Naukri Chrome, whose login `ensureNaukriSession` keeps. Naukri applies with the
 * profile already on Naukri; some roles open a question sidebar (the chatbot drawer) after
 * Apply. Every question there is answered with the same resolver as ATS forms and sent with
 * the drawer's own Save. Leaving the drawer unanswered files the apply as "Incomplete info",
 * so nothing outside it is clicked while it is open. Anything unrecognized parks the task.
 */

const SEL = {
  apply: "#apply-button, button:has-text('Apply'):not(:has-text('company site')):not(:has-text('attempted'))",
  companySite: "#company-site-button, button:has-text('Apply on company site')",
  alreadyApplied: "#already-applied, button:has-text('Applied')",
  /** TopTier pages disable the button this way once "Apply on company site" was clicked. */
  applyAttempted: "button:has-text('Apply attempted')",
  headerLogin: NAUKRI_HEADER_LOGIN,
  loginToApply:
    "#login-apply-button, #reg-apply-button, button:has-text('Login to apply'), button:has-text('Register to apply'), a:has-text('Login to apply'), a:has-text('Register to apply')",
  drawer: [
    ".chatbot_Drawer:not(.chatbot_Hidden)",
    "#chatbot-container:has(input, textarea, [contenteditable='true'])",
    ".naukri-drawer:not(:has(.benefits-drawer)):has(input:not([type='hidden']), textarea, [contenteditable='true'])",
  ].join(", "),
  botMessage: ".botMsg, [class*='botMsg']",
  chip: "[class*='chatbot_Chip'], [class*='chip']:not([class*='chipMsg'])",
  textBox: "[contenteditable='true'], textarea, input[type='text'], input:not([type])",
  suggestion: "[class*='suggestor'] li, [class*='suggestor'] [role='option'], [class*='Suggestor'] li",
  send: ".sendMsg, button:has-text('Save'), button:has-text('Submit')",
};

const SUCCESS_RE = /\b(you have successfully applied|successfully applied|application (sent|submitted))\b/i;
const INCOMPLETE_RE = /\bincomplete info/i;
const MAX_CHAT_STEPS = 15;
const DRAWER_WAIT_MS = 30_000;
const STEP_WAIT_MS = 12_000;
const CONFIRM_WAIT_MS = 8_000;

export const NAUKRI_LOGIN_REASON = "Naukri login needed: use Log in to Naukri in the apply panel";
const LOGIN_PROMPT_RE = /\b(login|register) to apply\b/i;

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

/** True when any match is visible, so a hidden duplicate earlier in the DOM does not hide it. */
async function anyVisible(page: Page, selector: string): Promise<boolean> {
  const count = await page.locator(selector).filter({ visible: true }).count().catch(() => 0);
  return count > 0;
}

function drawer(page: Page): Locator {
  return page.locator(SEL.drawer).filter({ visible: true }).last();
}

async function drawerOpen(page: Page): Promise<boolean> {
  return anyVisible(page, SEL.drawer);
}

/** Applied, with no question sidebar still open. */
async function confirmed(page: Page): Promise<boolean> {
  if (await drawerOpen(page)) return false;
  if (await anyVisible(page, SEL.alreadyApplied)) return true;
  return SUCCESS_RE.test(await bodyText(page));
}

async function readQuestion(page: Page): Promise<string> {
  const texts = await drawer(page)
    .locator(SEL.botMessage)
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))
    .catch(() => [] as string[]);
  return naukriQuestion(texts[texts.length - 1] ?? "") ?? "";
}

/** The question in the latest bot bubble; waits briefly when that bubble is only a greeting. */
async function lastBotQuestion(page: Page): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const question = await readQuestion(page);
    if (question) return question;
    await delay(1_000);
  }
  return "";
}

/** After a send: waits until the drawer asks something new or closes. */
async function waitForNextStep(page: Page, previous: string): Promise<void> {
  const deadline = Date.now() + STEP_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(800);
    if (!(await drawerOpen(page))) return;
    const question = await readQuestion(page);
    if (question && question !== previous) return;
  }
}

/**
 * Choices for the latest bot question: radios, checkboxes, or chips inside the open drawer
 * that come after the last bot bubble. Skill tags elsewhere on the job page never count.
 */
type ChoiceKind = "radio" | "checkbox" | "chip";

interface ChatOptions {
  kind: ChoiceKind;
  labels: string[];
  /** Position of each label among the drawer's controls of that kind, for clicking. */
  indexes: number[];
}

function choiceLocator(page: Page, kind: ChoiceKind): Locator {
  if (kind === "chip") return drawer(page).locator(SEL.chip);
  return drawer(page).locator(`input[type='${kind}']`);
}

async function chatOptions(page: Page): Promise<ChatOptions | null> {
  const read = (kind: ChoiceKind) =>
    choiceLocator(page, kind)
      .evaluateAll(
        (els, { kind, botSelector }) => {
          return els.map((el, index) => {
            const scope = el.closest(".chatbot_Drawer, #chatbot-container, .naukri-drawer") ?? document;
            const bots = scope.querySelectorAll(botSelector);
            const lastBot = bots[bots.length - 1];
            const after = !lastBot || Boolean(lastBot.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
            let text: string;
            if (kind === "chip") {
              text = (el.textContent ?? "").trim();
            } else {
              const id = (el as HTMLInputElement).id;
              const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
              text = (label?.textContent ?? (el as HTMLInputElement).value ?? "").trim();
            }
            return { index, text, after };
          });
        },
        { kind, botSelector: SEL.botMessage },
      )
      .catch(() => [] as Array<{ index: number; text: string; after: boolean }>);

  for (const kind of ["radio", "checkbox", "chip"] as const) {
    const items = (await read(kind)).filter((i) => i.after && i.text);
    if (items.length > 0) return { kind, labels: items.map((i) => i.text), indexes: items.map((i) => i.index) };
  }
  return null;
}

async function clickChoice(page: Page, options: ChatOptions, choice: string): Promise<boolean> {
  const index = options.labels.findIndex((l) => l.toLowerCase() === choice.toLowerCase());
  if (index < 0) return false;
  const target = choiceLocator(page, options.kind).nth(options.indexes[index]);
  if (options.kind === "chip") {
    await target.click();
    return true;
  }
  // Naukri hides the real input off-screen behind a styled label.
  const id = await target.getAttribute("id");
  const label = id
    ? drawer(page).locator(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`)
    : target.locator("xpath=ancestor::label");
  if (await label.first().isVisible().catch(() => false)) await label.first().click();
  else await target.check({ force: true });
  return target.isChecked().catch(() => true);
}

/** Types into the drawer's input; picks the matching suggestion when the input offers a list. */
async function typeAnswer(page: Page, answer: string): Promise<boolean> {
  const box = drawer(page).locator(SEL.textBox).filter({ visible: true }).last();
  if (!(await box.isVisible().catch(() => false))) return false;
  await box.click();
  await page.keyboard.insertText(answer);
  await delay(900);
  const suggestions = drawer(page).locator(SEL.suggestion).filter({ visible: true });
  const count = await suggestions.count().catch(() => 0);
  if (count > 0) {
    const texts = await suggestions.allTextContents().catch(() => [] as string[]);
    const pick = matchOption(answer, texts.map((t) => t.trim()));
    if (pick) await suggestions.nth(texts.findIndex((t) => t.trim() === pick)).click();
  }
  return true;
}

/** The drawer's own send control only; the job page has its own "Save" behind the overlay. */
async function clickSend(page: Page): Promise<boolean> {
  const send = drawer(page).locator(SEL.send).filter({ visible: true }).last();
  if (!(await send.isVisible().catch(() => false))) return false;
  await send.click({ timeout: 5_000 }).catch(() => undefined);
  return true;
}

/** The job page shows the Applied badge once Naukri has the application; the live page often does not update. */
async function appliedOnReload(page: Page, url: string): Promise<boolean> {
  if (await drawerOpen(page)) return false;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await settle(page);
  return anyVisible(page, SEL.alreadyApplied);
}

async function afterDrawerClosed(page: Page, url: string): Promise<TaskOutcome> {
  const deadline = Date.now() + CONFIRM_WAIT_MS;
  while (Date.now() < deadline) {
    if (await confirmed(page)) return SUBMITTED;
    if (await drawerOpen(page)) return park("no_confirmation", "Naukri reopened the questionnaire");
    await delay(1_500);
  }
  const incomplete = INCOMPLETE_RE.test(await bodyText(page));
  if (await appliedOnReload(page, url)) return SUBMITTED;
  if (incomplete) return park("no_confirmation", "Naukri marked the apply Incomplete info");
  return park("no_confirmation", "Naukri questionnaire closed without a confirmation");
}

async function answerChatbot(
  page: Page,
  taskId: string,
  url: string,
  ctx: ResolveContext,
  review: ReviewAnswer[],
): Promise<TaskOutcome> {
  let lastQuestion = "";
  for (let step = 0; step < MAX_CHAT_STEPS; step++) {
    if (!(await drawerOpen(page))) return afterDrawerClosed(page, url);

    const question = await lastBotQuestion(page);
    if (!(await drawerOpen(page))) return afterDrawerClosed(page, url);
    if (!question) return park("not_understood", "Naukri questionnaire has a question we could not read");
    if (question === lastQuestion) {
      return park("cannot_answer", `Naukri did not accept the answer to: ${question.slice(0, 80)}`);
    }
    lastQuestion = question;

    const found = await chatOptions(page);
    const options = found && cleanOptionsForLabel(question, found.labels).length > 0 ? found : null;
    const field: FieldDescriptor = {
      id: "naukri-chat",
      label: question,
      control: options ? (options.kind === "checkbox" ? "checkbox" : "radio") : "text",
      options: options?.labels ?? [],
      required: true,
      maxLength: null,
      freeText: !options,
    };

    const res = (await resolveFields([field], ctx)).get(field.id);
    if (!res) return park("cannot_answer", `Naukri question not resolved: ${question.slice(0, 80)}`);
    if (res.kind === "classify") return park("not_understood", `Naukri question not understood: ${question.slice(0, 80)}`);
    if (res.kind === "ask") {
      const unreadable = await recordAsk(taskId, res, ctx);
      if (unreadable) return park("cannot_answer", unreadable);
      review.push({ label: question, value: "", source: "asked you" });
      return needsAnswer("Naukri questionnaire needs your answer");
    }
    if (res.kind === "park") return park("cannot_answer", res.reason);
    if (res.kind === "ineligible") return fail("ineligible", res.reason);
    if (res.kind === "skip") return park("cannot_answer", `Naukri question could not be skipped: ${question.slice(0, 80)}`);

    const value = valueForAction(res.action, ctx.profile);
    const answers = (Array.isArray(value) ? value : [value]).filter((v): v is string => Boolean(v));
    if (answers.length === 0) return park("cannot_answer", `No answer for: ${question.slice(0, 80)}`);

    if (options) {
      const picks = options.kind === "checkbox" ? answers : answers.slice(0, 1);
      for (const pick of picks) {
        if (!(await clickChoice(page, options, pick))) {
          return park("cannot_answer", `Option not found for: ${question.slice(0, 80)}`);
        }
        await jitter(200, 500);
      }
    } else if (!(await typeAnswer(page, answers[0]))) {
      return park("not_understood", `Naukri question has no input: ${question.slice(0, 80)}`);
    }
    ctx.log?.(`  naukri answered [${res.source}] ${question.slice(0, 70)}`);
    review.push({ label: question, value: answers.join(", "), source: sourceName(res.source) });
    await jitter(400, 900);

    // Chips usually send themselves; only press Save when the question is still waiting.
    const still = (await drawerOpen(page)) && (await readQuestion(page)) === question;
    if (still && !(await clickSend(page)) && options?.kind !== "chip") {
      return park("not_understood", `Naukri questionnaire has no Save button: ${question.slice(0, 80)}`);
    }
    await waitForNextStep(page, question);
  }
  return park("not_understood", "Naukri questionnaire ran longer than expected");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Where "Apply on company site" leads. The button opens the employer page in a new tab (or this
 * one) through Naukri's redirect; the tab is closed once its final URL is known.
 */
async function companySiteUrl(page: Page): Promise<string | null> {
  const before = page.url();
  const popup = page.waitForEvent("popup", { timeout: 10_000 }).catch(() => null);
  await page.locator(SEL.companySite).filter({ visible: true }).first().click();
  const opened = await popup;
  const target = opened ?? page;
  await target.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  // Naukri and some employers bounce through tracking redirects first.
  for (let i = 0; i < 10 && /naukri\.com|about:blank/.test(target.url()); i++) await delay(1_000);
  const url = target.url();
  if (opened) await opened.close().catch(() => undefined);
  else if (url !== before) await page.goBack().catch(() => undefined);
  return /^https?:/.test(url) && !/naukri\.com/.test(url) ? url : null;
}

/** The employer link from Naukri's own job API, read as the job page loads it. */
function watchApplyRedirect(page: Page): () => string | null {
  let redirect: string | null = null;
  page.on("response", (res) => {
    if (!/\/jobapi\/v\d+\/job\/\d+(\?|$)/.test(res.url())) return;
    res
      .text()
      .then((body) => {
        const raw = /"applyRedirectUrl"\s*:\s*"([^"]+)"/.exec(body)?.[1];
        const url = raw ? (JSON.parse(`"${raw}"`) as string) : "";
        if (/^https?:/.test(url)) redirect = url;
      })
      .catch(() => undefined);
  });
  return () => redirect;
}

export async function runNaukriTask(
  lease: Lease,
  input: {
    taskId: string;
    url: string;
    ctx: ResolveContext;
    dryRun: boolean;
    review: ReviewAnswer[];
    /** Look run: open the job in its own tab and leave it; Apply can send at once, so it is never clicked. */
    keepOpen?: boolean;
    /** Applies on the employer's site when Naukri only offers "Apply on company site". */
    onCompanySite?: (url: string) => Promise<TaskOutcome>;
  },
): Promise<TaskOutcome> {
  const page = await lease.newPage();
  const applyRedirect = watchApplyRedirect(page);
  await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(page);

  const text = await bodyText(page);
  if (NAUKRI_CHALLENGE_RE.test(text.slice(0, 3000))) return park("challenge", "Naukri showed a challenge page");
  if (!/job-listings/.test(page.url()) || /job (has )?expired|no longer (available|accepting)/i.test(text)) {
    return fail("closed", "Posting is gone (Naukri redirected away from the job)");
  }
  if (await anyVisible(page, SEL.alreadyApplied)) {
    // Naukri shows Applied once "Apply on company site" was clicked; only the employer site knows.
    const redirect = applyRedirect();
    if (redirect && input.onCompanySite && !/naukri\.com/.test(redirect)) return input.onCompanySite(redirect);
    return SUBMITTED;
  }
  if (await anyVisible(page, SEL.applyAttempted)) {
    const redirect = applyRedirect();
    if (redirect && input.onCompanySite && !/naukri\.com/.test(redirect)) return input.onCompanySite(redirect);
    return park("company_site", redirect ? `Naukri sends this one to the company site: ${hostOf(redirect)}` : "Naukri marked this Apply attempted; finish it on the company site");
  }
  const loginNeeded = park("login_required", NAUKRI_LOGIN_REASON);
  if (
    (await anyVisible(page, SEL.loginToApply)) ||
    (await anyVisible(page, SEL.headerLogin)) ||
    LOGIN_PROMPT_RE.test(text)
  ) {
    return loginNeeded;
  }
  const hasApply = await anyVisible(page, SEL.apply);
  if (!hasApply && (await anyVisible(page, SEL.companySite))) {
    const target = await companySiteUrl(page);
    if (!target) return park("company_site", "Naukri sends this one to the company site (link did not open)");
    if (!input.onCompanySite) return park("company_site", `Naukri sends this one to the company site: ${hostOf(target)}`);
    return input.onCompanySite(target);
  }
  if (!hasApply) return park("no_form", "No Naukri Apply button found");

  if (input.keepOpen) {
    return park("left_open", "Opened on Naukri; Apply sends at once, so it was left for you to click");
  }
  if (input.dryRun) return ready("Dry run: Naukri Apply button found");

  await jitter(1_000, 2_500);
  await page.locator(SEL.apply).filter({ visible: true }).first().click();

  // The questionnaire bundle loads on first use, so the drawer can take a while to appear.
  const deadline = Date.now() + DRAWER_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(1_500);
    if (await drawerOpen(page)) return answerChatbot(page, input.taskId, input.url, input.ctx, input.review);
    if (await confirmed(page)) return SUBMITTED;
  }
  const incomplete = INCOMPLETE_RE.test(await bodyText(page));
  if (await appliedOnReload(page, input.url)) return SUBMITTED;
  if (incomplete) return park("no_confirmation", "Naukri marked the apply Incomplete info");
  return park("no_confirmation", "Clicked Apply on Naukri but saw no confirmation");
}
