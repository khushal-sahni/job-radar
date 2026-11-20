import fs from "node:fs";
import path from "node:path";
import type { Frame, Page } from "playwright";

/** iCIMS (and similar) keep the real form in `#icims_content_iframe`; locators on the shell miss it. */
export function formView(page: Page): Page | Frame {
  return page.frame({ name: "icims_content_iframe" }) ?? page;
}
import { bridgeSource } from "./bridge-source";
import { sectionLabel } from "./form-sections";
import { cleanOptionsForLabel } from "./options";
import { localCountryNames } from "./countries";
import { mapLabelToProfileKey, matchOption } from "./profile-map";
import { valueForAction } from "./resolve";
import type { FieldControl, FieldDescriptor, ProfileValues, RecipeAction } from "./types";

export interface ScannedField extends FieldDescriptor {
  empty: boolean;
  resumeLike?: boolean;
  /** What the control shows now, including a react-select chip. */
  shown?: string;
}

export interface PageState {
  captcha: boolean;
  confirmation: boolean;
  closed: boolean;
  loginWall: boolean;
  errors: string[];
  /** The emailed security-code input, or its row of one-character boxes; empty when not shown. */
  securityCodeIds: string[];
  submitId: string | null;
  nextId: string | null;
  hasForm: boolean;
  greenhouseFrame: string | null;
  /** iCIMS branded shell embeds the real portal in this iframe. */
  icimsFrame: string | null;
  applyLinkId: string | null;
}

const EXTENSION_SCRIPTS = [
  "fill.js",
  "extractors/generic.js",
  "extractors/greenhouse.js",
  "extractors/lever.js",
  "extractors/workable.js",
  "extractors/ashby.js",
  "extractors/index.js",
];

let cachedSources: { extension: string; bridge: string } | null = null;

function scriptSources(root: string): { extension: string; bridge: string } {
  if (cachedSources) return cachedSources;
  const extension = EXTENSION_SCRIPTS.map((f) =>
    fs.readFileSync(path.join(root, "extension", f), "utf-8"),
  ).join("\n;\n");
  cachedSources = { extension, bridge: bridgeSource(root) };
  return cachedSources;
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function jitter(min: number, max: number): Promise<void> {
  return delay(min + Math.random() * (max - min));
}

/** Waits for the page to stop loading, without failing on long-polling sites. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await delay(800);
}

/** page.evaluate runs through DevTools, so site CSP does not block the injected scripts. */
export async function ensureBridge(page: Page, root: string): Promise<void> {
  const target = formView(page);
  const has = await target.evaluate(() => Boolean((window as unknown as { JobRadarApply?: unknown }).JobRadarApply)).catch(() => false);
  if (!has) await target.evaluate(scriptSources(root).bridge);
}

export async function runExtensionFill(
  page: Page,
  root: string,
  profile: Record<string, unknown>,
): Promise<number> {
  const target = formView(page);
  await target.evaluate(scriptSources(root).extension);
  return target
    .evaluate(async (p) => {
      const JR = (window as unknown as {
        JobRadar: {
          detect: { detectPlatform: () => string };
          extractors: Record<string, (profile: unknown) => Promise<number>>;
        };
      }).JobRadar;
      const platform = JR.detect.detectPlatform();
      const fill = JR.extractors[platform] ?? JR.extractors.generic;
      return fill(p);
    }, profile)
    .catch(() => 0);
}

export async function scanFields(page: Page, root: string): Promise<ScannedField[]> {
  await ensureBridge(page, root);
  const fields = (await formView(page).evaluate(() =>
    (window as unknown as { JobRadarApply: { scan: () => unknown } }).JobRadarApply.scan(),
  )) as Array<ScannedField & { section?: string }>;
  return fields.map(({ section, ...f }) => {
    const label = sectionLabel(f.label, section);
    return { ...f, label, options: cleanOptionsForLabel(label, f.options) };
  });
}

export interface PageAnswer {
  id: string;
  label: string;
  required: boolean;
  value: string;
  control: FieldControl;
  options: string[];
  freeText: boolean;
  /** Radio and checkbox groups: exactly the choices that are on. */
  checked: string[] | null;
}

/** Every scanned control with the value it shows now. */
export async function readAnswers(page: Page, root: string): Promise<PageAnswer[]> {
  await ensureBridge(page, root);
  return formView(page).evaluate(() =>
    (window as unknown as { JobRadarApply: { answers: () => unknown } }).JobRadarApply.answers(),
  ) as Promise<PageAnswer[]>;
}

/** Values on already-stamped controls. Does not scan again — a second scan remounts Greenhouse radios. */
export async function readStampedValues(page: Page): Promise<Map<string, string>> {
  const rows = await formView(page).evaluate(() => {
    const out: Array<{ id: string; value: string }> = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-jr-id]")) {
      const id = el.dataset.jrId;
      if (!id) continue;
      const input = el as HTMLInputElement;
      const chip = el.closest("[class*='field'], [class*='control'], label")?.querySelector("[class*='single-value'], [class*='singleValue'], [class*='selected']");
      const value = String(input.value || chip?.textContent || (el.isContentEditable ? el.textContent : "") || "").trim();
      if (value) out.push({ id, value });
    }
    return out;
  });
  return new Map(rows.map((r) => [r.id, r.value]));
}

/** Required question headings the scan found no control for. Run right after scanFields. */
export async function unreadRequired(page: Page, root: string): Promise<string[]> {
  await ensureBridge(page, root);
  return formView(page).evaluate(() =>
    (window as unknown as { JobRadarApply: { unreadRequired: () => unknown } }).JobRadarApply.unreadRequired(),
  ) as Promise<string[]>;
}

export async function pageState(page: Page, root: string): Promise<PageState> {
  await ensureBridge(page, root);
  return formView(page).evaluate(() =>
    (window as unknown as { JobRadarApply: { state: () => unknown } }).JobRadarApply.state(),
  ) as Promise<PageState>;
}

function byId(page: Page, id: string) {
  return formView(page).locator(`[data-jr-id="${id}"]`).first();
}

export async function clickStamped(page: Page, id: string): Promise<void> {
  await byId(page, id).click({ timeout: 10_000 });
}

const OPTION_SELECTOR =
  "[role='option'], [class*='select__option'], .select2-results__option, .active-result, .chosen-results li, .selectBox-dropdown-menu li, .selectBox-options li, .k-list-item, li[data-option-array-index], .pac-item, .dropdown-location";

/**
 * Stamps the open dropdown's options with data-jr-choice and returns their text.
 * Only the listbox this combobox controls, else options inside its own field, so another open
 * menu (the phone-country list) is never read as this one. Google Places menus are portaled
 * to the page root, so `.pac-item` is the one page-wide fallback.
 */
async function markOpenOptions(page: Page, comboId: string): Promise<string[]> {
  return formView(page).evaluate(
    ({ comboId, selector }) => {
      document.querySelectorAll("[data-jr-choice]").forEach((el) => el.removeAttribute("data-jr-choice"));
      const combo = document.querySelector(`[data-jr-id="${comboId}"]`);
      const listId = combo?.getAttribute("aria-controls") || combo?.getAttribute("aria-owns");
      const list = listId ? document.getElementById(listId) : null;
      const field =
        combo?.closest(
          "fieldset, .application-question, .form-group, [class*='field'], [class*='Field'], [class*='question'], [class*='Question']",
        ) ?? null;
      const root: ParentNode | null = list ?? field;
      let pool = root ? [...root.querySelectorAll(selector)] : [];
      // select2 / Chosen / iCIMS portal the live list to body; in-field copies do not receive the click.
      const portaled = document.querySelector(
        ".select2-dropdown, .select2-container--open .select2-results, .chosen-container-active .chosen-drop, [role='listbox']:not([aria-hidden='true'])",
      );
      if (portaled) {
        const fromPortal = [...portaled.querySelectorAll(selector)];
        if (fromPortal.length > 0) pool = fromPortal;
      }
      // Workday portals its menu into one active list container.
      if (pool.length === 0) pool = [...document.querySelectorAll("[data-automation-id='activeListContainer'] [role='option']")];
      if (pool.length === 0 && combo?.tagName === "BUTTON") pool = [...document.querySelectorAll("[role='listbox'] [role='option']")];
      if (pool.length === 0) pool = [...document.querySelectorAll(".pac-item")];
      const visible = pool.filter((el) => {
        if (el.closest("[data-automation-id='selectedItemList']")) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      });
      const usable = visible
        .map((el) => ({ el, text: (el.textContent ?? "").replace(/\s+/g, " ").trim() }))
        .filter(({ text }) => text && !/^(no options|loading)/i.test(text));
      usable.forEach(({ el }, i) => el.setAttribute("data-jr-choice", String(i)));
      return usable.map(({ text }) => text);
    },
    { comboId, selector: OPTION_SELECTOR },
  );
}

/** Waits for search suggestions to load and settle (same list on two reads), up to ~3.5s. */
async function waitForOptions(page: Page, comboId: string): Promise<string[]> {
  let last: string[] = [];
  for (let i = 0; i < 12; i++) {
    await delay(300);
    const texts = await markOpenOptions(page, comboId);
    if (texts.length > 0 && texts.join("\u0001") === last.join("\u0001")) return texts;
    last = texts;
  }
  return last;
}

/** Picks one of the visible options; null means leave the field empty. */
export type OptionChooser = (query: string, wanted: string, options: string[]) => Promise<string | null>;

/** Opens a custom dropdown just long enough to read its own options. */
export async function readComboOptions(page: Page, id: string, label: string): Promise<string[]> {
  const loc = byId(page, id);
  try {
    await loc.click({ timeout: 5_000 });
    await delay(400);
    const options = await markOpenOptions(page, id);
    await page.keyboard.press("Escape").catch(() => undefined);
    await formView(page).locator("body").click({ position: { x: 8, y: 8 }, timeout: 1_000 }).catch(() => undefined);
    return cleanOptionsForLabel(label, [...new Set(options)]).slice(0, 60);
  } catch {
    return [];
  }
}

async function isOn(input: ReturnType<Page["locator"]>): Promise<boolean> {
  return input
    .evaluate((el) =>
      el.tagName === "INPUT"
        ? (el as HTMLInputElement).checked
        : el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-checked") === "true",
    )
    .catch(() => false);
}

/**
 * Puts one choice of a stamped group into the wanted state and reports whether it got there.
 * `rewrite` is for a form that already shows the right choice and still rejected it: Ashby saves
 * the click, so tap the other option and then this one again.
 */
async function setChoice(page: Page, groupId: string, option: string, on: boolean, rewrite = false): Promise<boolean> {
  const inputs = formView(page).locator(`[data-jr-group="${groupId}"]`);
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if ((await input.getAttribute("data-jr-opt")) !== option) continue;
    const already = (await isOn(input)) === on;
    if (already && !rewrite) return true;
    if (!(await input.evaluate((el) => el.tagName === "INPUT"))) {
      if (already) {
        for (let j = 0; j < count; j++) {
          if (j === i) continue;
          await inputs.nth(j).click({ timeout: 5_000 });
          break;
        }
      }
      await input.click({ timeout: 5_000 });
      return (await isOn(input)) === on;
    }
    try {
      if (already && on) await input.uncheck({ force: true, timeout: 5_000 });
      if (on) await input.check({ force: true, timeout: 5_000 });
      else await input.uncheck({ force: true, timeout: 5_000 });
    } catch {
      await input.evaluate((el) => {
        const id = (el as HTMLInputElement).id;
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
        ((label as HTMLElement | null) ?? (el as HTMLElement)).click();
      });
    }
    return (await isOn(input)) === on;
  }
  return false;
}

function checkChoice(page: Page, groupId: string, option: string, rewrite = false): Promise<boolean> {
  return setChoice(page, groupId, option, true, rewrite);
}

/**
 * Ashby keeps the answer from the change it hears, not from the text left in the box.
 * One fill can show the value while ApiSetFormValue never runs; clearing and writing
 * it again is the sequence that made the server accept the country field.
 */
async function writeText(loc: ReturnType<Page["locator"]>, text: string): Promise<void> {
  await loc.fill(text, { timeout: 5_000, force: true });
  await loc.fill("", { timeout: 5_000, force: true });
  await loc.fill(text, { timeout: 5_000, force: true });
  await loc.blur().catch(() => undefined);
}

type WorkdayKind = "button" | "prompt";

async function workdayKind(loc: ReturnType<Page["locator"]>): Promise<WorkdayKind | null> {
  return loc
    .evaluate((el) => {
      if (!el.closest("[data-automation-id^='formField']")) return null;
      if (el.tagName === "BUTTON" && el.getAttribute("aria-haspopup") === "listbox") return "button";
      return el.getAttribute("data-uxi-widget-type") === "selectinput" ? "prompt" : null;
    })
    .catch(() => null) as Promise<WorkdayKind | null>;
}

async function workdayPicked(page: Page, id: string, kind: WorkdayKind): Promise<boolean> {
  return byId(page, id)
    .evaluate((el, kind) => {
      if (kind === "button") return !/^\s*(select one)?\s*$/i.test(el.textContent ?? "");
      const field = el.closest("[data-automation-id^='formField']");
      return Boolean(field?.querySelector("[data-automation-id='selectedItem']"));
    }, kind)
    .catch(() => false);
}

/**
 * Workday list buttons open a menu to click. Prompt boxes search on Enter and may open a menu
 * of categories ("Website" → the company's site), so a pick that does not stick goes one level down.
 */
async function fillWorkdayChoice(
  page: Page,
  id: string,
  kind: WorkdayKind,
  wanted: string,
  profile: ProfileValues,
  choose?: OptionChooser,
): Promise<boolean> {
  const loc = byId(page, id);
  const pick = async (query: string, texts: string[]) =>
    choose ? await choose(query, wanted, texts) : matchOption(wanted, texts, profile.country);
  const queries = kind === "button" ? [wanted] : [...new Set([wanted, wanted.split(",")[0].trim(), ""])];
  for (const query of queries) {
    await loc.click({ timeout: 5_000 });
    if (kind === "prompt") {
      await loc.fill("");
      if (query) {
        await loc.pressSequentially(query.slice(0, 40), { delay: 40 });
        await page.keyboard.press("Enter");
      }
    }
    for (let level = 0; level < 3; level++) {
      const texts = await waitForOptions(page, id);
      let option = texts.length > 0 ? await pick(query || wanted, texts) : null;
      // A submenu under the category already picked: any entry keeps that answer.
      if (!option && level > 0) option = texts.find((t) => /naukri/i.test(t)) ?? texts.find((t) => /^other\b/i.test(t)) ?? texts[0] ?? null;
      const index = option ? texts.indexOf(option) : -1;
      if (index < 0) break;
      await formView(page).locator(`[data-jr-choice="${index}"]`).first().click({ timeout: 5_000 });
      await delay(800);
      if (await workdayPicked(page, id, kind)) {
        await page.keyboard.press("Escape").catch(() => undefined);
        return true;
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  return false;
}

const WIDGET_PLACEHOLDER_RE = /^(select|please select|choose|select one|make a selection)|make a selection/i;

type JrPage = {
  associatedSelect?: (node: Element) => HTMLSelectElement | null;
  associatedSelectOptions?: (node: Element) => string[];
  commitAssociatedSelect?: (node: Element, label: string) => boolean;
};

/** Commit a Select2 / Chosen combobox through the hidden native <select> it is bound to. */
async function fillAssociatedSelect(
  loc: ReturnType<typeof byId>,
  wanted: string,
  profile: ProfileValues,
  choose?: OptionChooser,
): Promise<boolean> {
  const live = await loc
    .evaluate((el) => {
      const api = (window as unknown as { JobRadarApply?: JrPage }).JobRadarApply;
      return api?.associatedSelectOptions?.(el) ?? [];
    })
    .catch(() => [] as string[]);
  if (live.length === 0) return false;
  const pick = choose ? await choose(wanted, wanted, live) : matchOption(wanted, live, profile.country);
  if (!pick) return false;
  return loc
    .evaluate((el, label) => {
      const api = (window as unknown as { JobRadarApply?: JrPage }).JobRadarApply;
      return Boolean(api?.commitAssociatedSelect?.(el, label));
    }, pick)
    .catch(() => false);
}

/** True when a combobox already shows a committed choice (typed value, chip, Chosen/select2 label). */
async function comboHasValue(loc: ReturnType<typeof byId>): Promise<boolean> {
  return loc
    .evaluate((el, placeholderSrc) => {
      const placeholder = new RegExp(placeholderSrc, "i");
      const empty = (t: string) => {
        const s = t.replace(/\s+/g, " ").trim();
        return !s || placeholder.test(s);
      };
      const typed = ((el as HTMLInputElement).value || "").trim();
      if (typed && !empty(typed)) return true;
      const api = (window as unknown as { JobRadarApply?: JrPage }).JobRadarApply;
      const associated = api?.associatedSelect?.(el) ?? null;
      if (associated instanceof HTMLSelectElement) {
        const shown = associated.options[associated.selectedIndex]?.text ?? "";
        if (!empty(shown) && associated.value) return true;
      }
      const rendered = document.querySelector(
        ".select2-container--open .select2-selection__rendered, .select2-container--above .select2-selection__rendered, .chosen-container-active .chosen-single span",
      );
      if (rendered && !empty((rendered.textContent || "").trim())) return true;
      let box: HTMLElement | null = el.parentElement;
      for (let depth = 0; box && depth < 6; depth++, box = box.parentElement) {
        const chip = box.querySelector(
          "[class*='single-value'], [class*='singleValue'], .chosen-single, .select2-selection__rendered, .selectBox-label",
        );
        const text = (chip?.textContent || "").replace(/\s+/g, " ").trim();
        if (text && !empty(text)) return true;
      }
      return false;
    }, WIDGET_PLACEHOLDER_RE.source)
    .catch(() => false);
}

/** Click a closed dropdown open and pick the matching row, without typing. */
async function pickOpenCombo(
  page: Page,
  id: string,
  wanted: string,
  profile: ProfileValues,
  choose?: OptionChooser,
): Promise<boolean> {
  const loc = byId(page, id);
  try {
    await loc.click({ timeout: 3_000 }).catch(() => loc.click({ force: true, timeout: 3_000 }));
    await delay(300);
    const texts = await markOpenOptions(page, id);
    if (texts.length === 0) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }
    const pick = choose ? await choose(wanted, wanted, texts) : matchOption(wanted, texts, profile.country);
    const index = pick ? texts.indexOf(pick) : -1;
    if (index < 0) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return false;
    }
    const committed = await loc.evaluate((el, label) => {
      const api = (window as unknown as { JobRadarApply?: JrPage }).JobRadarApply;
      return Boolean(api?.commitAssociatedSelect?.(el, label));
    }, pick);
    const choice = formView(page).locator(`[data-jr-choice="${index}"]`).first();
    await choice.dispatchEvent("mousedown").catch(() => undefined);
    await choice.click({ timeout: 3_000 }).catch(() => undefined);
    await delay(250);
    if (committed || (await comboHasValue(loc))) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return true;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return comboHasValue(loc);
  } catch {
    return false;
  }
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Types into a Workday date wrapper: DD/MM/YYYY, MM/YYYY, a full ISO date, or YYYY alone. */
async function fillWorkdayDate(wrapper: ReturnType<typeof byId>, value: string): Promise<boolean> {
  const raw = value.trim();
  const iso = ISO_DATE_RE.exec(raw);
  const dmy = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
  const my = raw.match(/^(?:(\d{1,2})\s*[/\-.]\s*)?(\d{4})$/);
  const dayBox = wrapper.locator("input[data-automation-id='dateSectionDay-input']").first();
  const monthBox = wrapper.locator("input[data-automation-id='dateSectionMonth-input']").first();
  const yearBox = wrapper.locator("input[data-automation-id='dateSectionYear-input']").first();
  const hasDay = (await dayBox.count()) > 0;
  const hasMonth = (await monthBox.count()) > 0;
  const parts: [typeof yearBox, string][] = [];
  if (iso) {
    if (hasDay) parts.push([dayBox, iso[3]]);
    if (hasMonth) parts.push([monthBox, iso[2]]);
    parts.push([yearBox, iso[1]]);
  } else if (dmy) {
    if (hasDay) parts.push([dayBox, dmy[1].padStart(2, "0")]);
    if (hasMonth) parts.push([monthBox, dmy[2].padStart(2, "0")]);
    parts.push([yearBox, dmy[3]]);
  } else if (my) {
    if (hasMonth && !my[1]) return false;
    if (hasMonth) parts.push([monthBox, my[1].padStart(2, "0")]);
    parts.push([yearBox, my[2]]);
  } else {
    return false;
  }
  await wrapper.scrollIntoViewIfNeeded().catch(() => undefined);
  for (const [box, digits] of parts) {
    // The spinbutton sits under a painted display div, so a click never lands on it.
    await box.focus({ timeout: 3_000 });
    await box.press("Backspace").catch(() => undefined);
    await box.pressSequentially(digits, { delay: 40 });
  }
  await yearBox.press("Tab").catch(() => undefined);
  return (await yearBox.inputValue().catch(() => "")) === parts[parts.length - 1][1];
}

/** Types or picks the resolved value into one stamped control. */
export async function applyAction(
  page: Page,
  field: ScannedField,
  action: RecipeAction,
  profile: ProfileValues,
  choose?: OptionChooser,
  /** Search terms to try in order instead of the value itself (school names). */
  searches?: readonly string[],
  /** Write the value again even when the control already shows it. Used after Ashby says it is missing. */
  rewrite = false,
): Promise<boolean> {
  const value = valueForAction(action, profile);
  if (value == null) return false;
  const loc = byId(page, field.id);

  try {
    switch (field.control) {
      case "text":
      case "textarea": {
        let text = Array.isArray(value) ? value.join(", ") : value;
        const dateKind = await loc.evaluate(
          (el) => {
            if (el.getAttribute("data-automation-id") === "dateInputWrapper") return "workday";
            if (el instanceof HTMLInputElement && el.type === "date") return "native";
            return el.closest(".react-datepicker-wrapper") ? "picker" : null;
          },
          undefined,
          { timeout: 5_000 },
        );
        if (dateKind === "workday") return fillWorkdayDate(loc, text);
        const iso = ISO_DATE_RE.exec(text.trim());
        if (dateKind === "native" && !iso) return false;
        // react-datepicker parses MM/DD/YYYY by default and clears text it cannot read.
        if (dateKind === "picker" && iso) text = `${iso[2]}/${iso[3]}/${iso[1]}`;
        const editable = await loc.evaluate((el) => (el as HTMLElement).isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA");
        if (editable) {
          await loc.click();
          await page.keyboard.insertText(text);
        } else {
          await writeText(loc, text);
          // A calendar left open covers the fields below it until dismissed.
          if (dateKind === "picker") await page.keyboard.press("Escape").catch(() => undefined);
        }
        return true;
      }
      case "select": {
        const wanted = Array.isArray(value) ? value[0] : value;
        const live = await loc
          .evaluate((el) =>
            el instanceof HTMLSelectElement
              ? [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|--|please select)/i.test(t))
              : [],
          )
          .catch(() => [] as string[]);
        const option = matchOption(wanted, field.options.length > 0 ? field.options : live) ?? matchOption(wanted, live);
        if (!option) return false;
        try {
          await loc.selectOption({ label: option }, { timeout: 2_000, force: true });
          return true;
        } catch {
          const ok = await loc.evaluate((el, label) => {
            const sel = el instanceof HTMLSelectElement ? el : el.querySelector("select");
            if (!sel) return false;
            const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
            const want = norm(label);
            const opt = [...sel.options].find((o) => norm(o.text) === want || norm(o.value) === want);
            if (!opt) return false;
            sel.value = opt.value;
            opt.selected = true;
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            const jq = (window as unknown as { jQuery?: (el: Element) => { trigger: (ev: string) => void } }).jQuery;
            jq?.(sel).trigger("change");
            return sel.value === opt.value || sel.options[sel.selectedIndex]?.text.trim() === opt.text.trim();
          }, option);
          if (ok) return true;
          await loc.click({ timeout: 3_000 }).catch(() => undefined);
          const texts = await waitForOptions(page, field.id);
          const pick = matchOption(option, texts) ?? option;
          const index = texts.indexOf(pick);
          if (index < 0) return false;
          await formView(page).locator(`[data-jr-choice="${index}"]`).first().click({ timeout: 3_000 });
          return true;
        }
      }
      case "radio": {
        const option = matchOption(Array.isArray(value) ? value[0] : value, field.options);
        return option ? checkChoice(page, field.id, option, rewrite) : false;
      }
      case "checkbox": {
        // A lone consent box whose option text the scan missed: check the stamped input.
        if (field.options.length === 0) {
          const group = formView(page).locator(`[data-jr-group="${field.id}"]`);
          const target = (await group.count()) > 0 ? group.first() : loc;
          try {
            await target.check({ force: true, timeout: 5_000 });
          } catch {
            await target.click({ timeout: 5_000 });
          }
          return true;
        }
        // The group ends up with exactly these choices: prefills and earlier picks are unchecked.
        const values = Array.isArray(value) ? value : [value];
        const wanted = values.map((v) => matchOption(v, field.options));
        if (wanted.some((o) => !o)) return false;
        let ok = true;
        for (const option of field.options) {
          ok = (await setChoice(page, field.id, option, wanted.includes(option), rewrite)) && ok;
        }
        return ok;
      }
      case "combobox": {
        const wanted = Array.isArray(value) ? value[0] : value;
        const workday = await workdayKind(loc);
        if (workday) return await fillWorkdayChoice(page, field.id, workday, wanted, profile, choose);
        // iCIMS Select2 / Chosen: the visible combobox is bound to a hidden native <select>.
        if (await fillAssociatedSelect(loc, wanted, profile, choose)) return true;
        // Closed lists (Chosen / select2 / iCIMS): click opens the rows; typing into a non-input throws.
        const closed = await pickOpenCombo(page, field.id, wanted, profile, choose);
        if (closed) return true;
        const hasNative = await loc
          .evaluate((el) => Boolean((window as unknown as { JobRadarApply?: JrPage }).JobRadarApply?.associatedSelect?.(el)))
          .catch(() => false);
        // Typing into a Select2 search box does not commit the native select; skip the slow retry.
        if (hasNative) return comboHasValue(loc);
        const canType = await loc.evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement).catch(() => false);
        if (!canType) return false;
        // Place search boxes (Greenhouse "Location (City)") find nothing for "Gurugram, India" but do for "Gurugram".
        const placeKey = mapLabelToProfileKey(field);
        const isPlace =
          (action.type === "profile" && (action.key === "location" || action.key === "city")) ||
          placeKey === "location" ||
          placeKey === "city";
        const first = (isPlace ? wanted.split(",")[0].trim() : wanted).slice(0, 40);
        // "Berlin, Germany" may find nothing where "Berlin" lists it; the full value still picks the row.
        const head = !isPlace && wanted.includes(",") ? [wanted.split(",")[0].trim().slice(0, 40)] : [];
        // Country-only place boxes (Ashby "Location": country of residence) find nothing for a city.
        const countryFallback = action.type === "profile" && action.key === "location" && profile.country ? [profile.country] : [];
        // German-language forms list "Indien +91"; typing "India" there finds nothing.
        const queries = [...new Set([first, ...head, ...countryFallback, ...localCountryNames(wanted), ...countryFallback.flatMap(localCountryNames)])];
        for (const query of searches ?? queries) {
          // A react-select placeholder can sit over the input and take the click; it opens the same control.
          await loc.click({ timeout: 3_000 }).catch(() => loc.click({ force: true, timeout: 3_000 }));
          await loc.fill("");
          await loc.pressSequentially(query, { delay: 40 });
          const texts = await waitForOptions(page, field.id);
          const pick = choose ? await choose(query, wanted, texts) : matchOption(wanted, texts, profile.country);
          const index = pick ? texts.indexOf(pick) : -1;
          if (index < 0) continue;
          const choice = formView(page).locator(`[data-jr-choice="${index}"]`).first();
          // Lever commits the place on mousedown, then blur wipes the box if the list is still open.
          await choice.dispatchEvent("mousedown");
          await choice.click({ timeout: 5_000 }).catch(() => undefined);
          const leverPlaceOk = await loc.evaluate((el) => {
            if (!el.classList.contains("location-input")) return true;
            const typed = ((el as HTMLInputElement).value || "").trim();
            const selected = (document.querySelector("#selected-location") as HTMLInputElement | null)?.value.trim() ?? "";
            return Boolean(typed && selected);
          });
          if (!leverPlaceOk || !(await comboHasValue(loc))) continue;
          // Greenhouse school typeaheads drop the chip unless Enter commits the pick.
          if (searches?.length) await page.keyboard.press("Enter").catch(() => undefined);
          // Lever's resume parser skips a field only after a change event. Without one, it writes the résumé place back.
          await loc.evaluate((el) => {
            if (!el.classList.contains("location-input")) return;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
          return true;
        }
        await page.keyboard.press("Escape").catch(() => undefined);
        if (searches?.length) {
          for (const query of searches) {
            await loc.click({ timeout: 3_000 }).catch(() => loc.click({ force: true, timeout: 3_000 }));
            await loc.fill("");
            await loc.pressSequentially(query, { delay: 40 });
            const texts = await waitForOptions(page, field.id);
            const pick = choose ? await choose(query, wanted, texts) : texts[0] ?? null;
            if (!pick) continue;
            const index = texts.indexOf(pick);
            if (index >= 0) {
              const choice = formView(page).locator(`[data-jr-choice="${index}"]`).first();
              await choice.dispatchEvent("mousedown");
              await choice.click({ timeout: 5_000 }).catch(() => undefined);
            } else {
              await loc.press("ArrowDown");
              await loc.press("Enter");
            }
            const committed = await loc.evaluate((el) => {
              const typed = ((el as HTMLInputElement).value || "").trim();
              if (typed) return true;
              let box = el.parentElement;
              for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
                const chip = box.querySelector("[class*='single-value'], [class*='singleValue']");
                if ((chip?.textContent || "").trim()) return true;
              }
              return false;
            });
            if (committed) return true;
          }
        }
        const isLeverPlace = await loc.evaluate((el) => el.classList.contains("location-input"));
        if (isLeverPlace) {
          const city = (profile.city || profile.location || "").split(",")[0].trim();
          if (!city) return false;
          await loc.click({ timeout: 3_000 }).catch(() => loc.click({ force: true, timeout: 3_000 }));
          await loc.fill("");
          await loc.pressSequentially(city, { delay: 40 });
          const texts = await waitForOptions(page, field.id);
          if (texts.length > 0) {
            const choice = formView(page).locator(`[data-jr-choice="0"]`).first();
            await choice.dispatchEvent("mousedown");
            await choice.click({ timeout: 5_000 }).catch(() => undefined);
          } else {
            await loc.press("ArrowDown");
            await loc.press("Enter");
          }
          await loc.evaluate((el) => {
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
          return loc.evaluate((el) => Boolean((el as HTMLInputElement).value.trim()));
        }
        return false;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** One character per box when the boxes match the code length; otherwise the whole code into the first box. */
export async function fillSecurityCode(page: Page, ids: string[], code: string): Promise<boolean> {
  try {
    if (ids.length > 1 && ids.length === code.length) {
      for (const [i, id] of ids.entries()) {
        await byId(page, id).fill(code[i]);
        await delay(60);
      }
    } else {
      await byId(page, ids[0]).fill(code);
    }
    return true;
  } catch {
    return false;
  }
}

export async function uploadResume(
  page: Page,
  fields: ScannedField[],
  resumePath: string | null,
): Promise<boolean> {
  if (!resumePath) return false;
  // Ashby-style "Autofill from resume" inputs re-render the form and wipe typed values.
  const files = fields.filter((f) => f.control === "file" && !/autofill|parse/i.test(f.label));
  const target =
    files.find((f) => f.empty && f.resumeLike && f.required) ??
    files.find((f) => f.empty && f.resumeLike) ??
    (files.length === 1 && files[0].empty ? files[0] : undefined);
  if (!target) return false;
  try {
    // Sent as bytes: given a path, Chrome reads the file itself and can hang on macOS folder access.
    const file = { name: path.basename(resumePath), mimeType: "application/pdf", buffer: fs.readFileSync(resumePath) };
    await byId(page, target.id).setInputFiles(file);
    return true;
  } catch {
    return false;
  }
}
