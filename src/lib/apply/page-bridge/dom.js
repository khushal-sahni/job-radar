/* Part of the page bridge (see browser-fill.ts `bridgeSource`); shares one scope with the other parts. */
/* Shared DOM helpers: visibility, labels, question text, choice groups, sections. */

const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "password", "search"]);
const FREE_TEXT_RE = /\b(why|describe|tell us|explain|what makes|share|about (yourself|you)|motivat|interest(ed)? in|cover letter|anything else|additional)\b/i;
const CONFIRM_RE =
  /\b(thank(s| you)( so much| very much)? for (applying|your application|your interest|submitting your application)|application (has been |was )?(already )?(submitted|received|sent|complete)|we('ve|’ve| have) (successfully )?received your application|successfully (applied|submitted)|you have applied|application submitted)\b/i;
const CLOSED_RE =
  /\b(job not found|the job you requested was not found|job posting you're looking for might have closed|no longer (accepting|available|open)|job (is )?(not|no longer) available|position has been filled|this job has expired|posting (has )?(closed|expired)|page (you were looking for )?(not found|doesn't exist))\b/i;
const LOGIN_RE = /\b(sign in to apply|log ?in to apply|create an account to apply|login to continue)\b/i;
const SUBMIT_RE = /^(submit( your)?( application)?|send application|submit & apply|finish|complete application)$/i;
// Weaker: posting pages also have an "Apply" button that only scrolls to the form (Greenhouse job boards).
const APPLY_SUBMIT_RE = /^(apply|apply now)$/i;
const NEXT_RE = /^(next|continue|save (and|&) continue|proceed|next step)$/i;

let seq = 0;

/** Fallback copy inside inline SVG icons (Workable) that textContent picks up. */
const SVG_FALLBACK_RE = /SVGs? (are )?not supported by this browser\.?/gi;
/** Lever's internal input names ("cards[uuid][field0]", "surveysResponses[uuid][responses][field1]"): never a question. */
const INTERNAL_NAME_RE = /^(cards|surveysResponses)\[/;

function text(el) {
  return (el?.textContent ?? "").replace(SVG_FALLBACK_RE, " ").replace(/\s+/g, " ").trim();
}

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.closest("[aria-hidden='true'], [hidden], [inert]")) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const absLeft = rect.left + window.scrollX;
  const absTop = rect.top + window.scrollY;
  if (absLeft < -500 || absTop < -500) return false;
  if (style.clipPath === "inset(100%)" || style.clip === "rect(0px, 0px, 0px, 0px)") return false;
  return true;
}

/** Radios/checkboxes are often visually hidden behind a styled label. */
function isChoiceVisible(input) {
  if (isVisible(input)) return true;
  if (input.closest("[aria-hidden='true'], [hidden], [inert]")) return false;
  const label = labelElementFor(input);
  return Boolean(label && isVisible(label));
}

function labelElementFor(el) {
  if (el.id) {
    const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor) return byFor;
  }
  return el.closest("label");
}

function stamp(el) {
  if (!el.dataset.jrId) el.dataset.jrId = `jr${++seq}`;
  return el.dataset.jrId;
}

function container(el) {
  return (
    el.closest(
      "fieldset, .application-question, .field, .form-group, [class*='field'], [class*='Field'], [class*='question'], [class*='Question'], [role='group'], [role='radiogroup'], li",
    ) ?? el.parentElement
  );
}

const HEADING_SEL = "legend, label, [class*='label'], [class*='Label'], [class*='question-text'], [class*='question-title'], [class*='title']";
const CONTROL_SEL = "input:not([type='hidden']), textarea, select, [role='combobox']";

/** The last heading before `el` inside `box` that is not itself wrapped around a control. */
function headingBefore(box, el) {
  const headings = [...box.querySelectorAll(HEADING_SEL)].filter(
    (h) =>
      h !== el &&
      !h.contains(el) &&
      !h.querySelector(CONTROL_SEL) &&
      text(h) &&
      h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return headings.length > 0 ? text(headings[headings.length - 1]) : "";
}

const UNIT_RE = /^(in )?(lakhs?|lpa|inr|usd|eur|jpy|rupees?)$/i;

function nearbyUnit(el) {
  const box = el.parentElement;
  if (!box) return "";
  for (const node of box.childNodes) {
    const t = text(node).replace(/\s+/g, " ").trim();
    if (UNIT_RE.test(t)) return t;
  }
  return "";
}

function withUnit(el, label) {
  const unit = nearbyUnit(el);
  return unit && label && !UNIT_RE.test(label) ? `${label} (${unit})` : label;
}

function questionText(el, ownLabel) {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const t = labelledBy
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .filter(Boolean)
      .join(" ");
    if (t) return withUnit(el, t);
  }
  if (ownLabel) {
    const label = labelElementFor(el);
    // Lever wraps the suggestion list ("No location found", "Loading") inside the same label.
    const caption = label?.querySelector(".application-label");
    const t = text(caption || label);
    if (t) return withUnit(el, t);
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return withUnit(el, aria.trim());

  // Widen from the control's own wrapper until a heading shows up, but never into a box
  // holding another question's control (Lever cards keep the label one level above the field).
  let box = container(el);
  for (let i = 0; box && box !== document.body && i < 4; i++) {
    const t = headingBefore(box, el);
    if (t) return withUnit(el, t);
    const parent = box.parentElement && container(box.parentElement);
    if (!parent || parent === box) break;
    const others = [...parent.querySelectorAll(CONTROL_SEL)].filter((c) => c !== el && !box.contains(c) && isVisible(c));
    if (others.length > 0) break;
    box = parent;
  }
  // Lever card and survey questions keep their text in the card's label, above every choice.
  const card = text(el.closest(".application-question")?.querySelector(".application-label, .text"));
  if (card) return withUnit(el, card);
  const name = (el.getAttribute("name") || "").trim();
  return withUnit(el, (el.getAttribute("placeholder") || (INTERNAL_NAME_RE.test(name) ? "" : name)).trim());
}

/** Distinct question headings in a box: text that is not one of the choices and wraps no control. */
function questionHeadings(box, choiceTexts) {
  const seen = new Set();
  for (const h of box.querySelectorAll(HEADING_SEL)) {
    const t = text(h).replace(/[*✱]/g, "").trim();
    if (!t || h.querySelector(CONTROL_SEL) || choiceTexts.has(t.toLowerCase())) continue;
    if ([...seen].some((s) => s.includes(t) || t.includes(s))) continue;
    seen.add(t);
  }
  return [...seen];
}

function optionText(input) {
  return text(labelElementFor(input)) || input.value || "";
}

/**
 * All inputs of one choice question. Grouping by `name` alone splits Ashby checkbox lists
 * (one name per option) into separate questions, so the question's own box decides: a
 * fieldset / ARIA group with at most one heading, else a shared name, else the nearest
 * ancestor holding several choices, exactly one heading, and nothing else to fill.
 */
function choiceGroup(el, type) {
  const sameType = (box) => [...box.querySelectorAll(`input[type="${type}"]`)];
  const texts = (inputs) => new Set(inputs.map((i) => optionText(i).toLowerCase()).filter(Boolean));

  const explicit = el.closest("fieldset, [role='group'], [role='radiogroup']");
  if (explicit) {
    const inputs = sameType(explicit);
    if (questionHeadings(explicit, texts(inputs)).length <= 1) return inputs;
  }
  if (el.name) {
    const named = [...document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)];
    if (named.length > 1) return named;
  }
  for (let box = el.parentElement, i = 0; box && box !== document.body && i < 6; box = box.parentElement, i++) {
    if ([...box.querySelectorAll(CONTROL_SEL)].some((c) => c.type !== type)) break;
    const inputs = sameType(box);
    if (inputs.length < 2) continue;
    if (questionHeadings(box, texts(inputs)).length === 1) return inputs;
    break;
  }
  return [el];
}

/** A visible question heading the form marks as required: *, ✱, a required class, or a CSS "*". */
function isRequiredHeading(h) {
  if (/[*✱]\s*$/.test(text(h))) return true;
  if (/\brequired\b|_required_/i.test(typeof h.className === "string" ? h.className : "")) return true;
  if (h.querySelector(".required, [class*='required'], [class*='Required']")) return true;
  const pseudo = `${getComputedStyle(h, "::after").content} ${getComputedStyle(h, "::before").content}`;
  return /[*✱]/.test(pseudo);
}

const SECTION_TITLE_RE = /\b(education|employment|work experience|work history)\b/i;
const ATTACHED_FILE_RE = /\w\.(pdf|docx?|odt|rtf|txt)\b/i;

/** A block title ("Education History") with its own scanned questions after it. */
function isSectionTitle(h, t) {
  if (!SECTION_TITLE_RE.test(t)) return false;
  for (let box = h.parentElement, i = 0; box && box !== document.body && i < 3; box = box.parentElement, i++) {
    const after = [...box.querySelectorAll("[data-jr-id]")].filter((c) => h.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (after.length >= 2) return true;
  }
  return false;
}

/** An upload box that already shows its file; Greenhouse removes the file input once one is attached. */
function hasAttachedFile(h) {
  const box = h.parentElement?.closest("[role='group'], [class*='file-upload'], [class*='upload']") || h.parentElement;
  return Boolean(box && ATTACHED_FILE_RE.test(text(box)));
}

const SECTION_HEADING_RE = /^(education|employment|employment history|work experience)$/i;
const HEADING_SELECTOR = ":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > [class*='section-header'], :scope > [class*='heading']";

function sectionFrom(value) {
  if (/educat/i.test(value)) return "education";
  if (/employ|work experience/i.test(value)) return "employment";
  return "";
}

/** "education" or "employment" for controls inside those repeating blocks (Greenhouse educations[] / employments[]). */
function sectionOf(el) {
  const hint = `${el.getAttribute("name") || ""} ${el.id || ""}`;
  if (/educat/i.test(hint)) return "education";
  if (/employ/i.test(hint)) return "employment";
  for (let box = el.parentElement, i = 0; box && box !== document.body && i < 10; box = box.parentElement, i++) {
    const cls = typeof box.className === "string" ? box.className : "";
    const byClass = /educat/i.test(`${box.id} ${cls}`) ? "education" : /employ/i.test(`${box.id} ${cls}`) ? "employment" : "";
    if (byClass) return byClass;
    // The last section heading before the control, so a form holding both blocks labels each correctly.
    const headings = [...box.querySelectorAll(HEADING_SELECTOR)].filter(
      (h) => SECTION_HEADING_RE.test(text(h).replace(/[*:]/g, "").trim()) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (headings.length > 0) return sectionFrom(text(headings[headings.length - 1]));
  }
  return "";
}

function isRequired(el, label, box) {
  if (el.required || el.getAttribute("aria-required") === "true") return true;
  if (/[*✱]|\(required\)/i.test(label)) return true;
  if (box && box.querySelector("[aria-required='true'], [required]")) return true;
  if (box && box.querySelector("[class*='required'], [class*='Required']")) {
    return !/optional/i.test(text(box));
  }
  return false;
}

/** Workday list buttons ("Select One" until picked) and prompt search boxes (picks shown as chips). */
function isWorkdayChoice(el) {
  if (!el.closest("[data-automation-id^='formField']")) return false;
  return (el.tagName === "BUTTON" && el.getAttribute("aria-haspopup") === "listbox") || el.getAttribute("data-uxi-widget-type") === "selectinput";
}

/** What a Workday list button or prompt box shows as picked, or "". */
function workdayChosen(el) {
  if (el.tagName === "BUTTON") {
    const t = text(el);
    return /^select one$/i.test(t) ? "" : t;
  }
  const field = el.closest("[data-automation-id^='formField']");
  return [...(field?.querySelectorAll("[data-automation-id='selectedItem']") ?? [])].map(text).filter(Boolean).join(", ");
}

const SELECT_PLACEHOLDER_RE = /^(select|please select|choose|select one|make a selection)|make a selection/i;

/**
 * Hidden native <select> a Select2 / Chosen widget is bound to. The combobox is the visible
 * control; the select sits as a sibling of `.select2-container` / `.chosen-container`.
 */
function associatedSelect(el) {
  if (!el || !(el instanceof Element)) return null;
  if (el instanceof HTMLSelectElement) return el;
  for (const sib of [el.previousElementSibling, el.nextElementSibling]) {
    if (sib instanceof HTMLSelectElement) return sib;
  }
  const container = el.closest(".select2-container, .chosen-container, .iCIMS_InfoData");
  if (container) {
    for (const sib of [container.previousElementSibling, container.nextElementSibling]) {
      if (sib instanceof HTMLSelectElement) return sib;
    }
    const parentSel = [...(container.parentElement?.children ?? [])].find((c) => c instanceof HTMLSelectElement);
    if (parentSel) return parentSel;
    const inner = container.querySelector("select");
    if (inner instanceof HTMLSelectElement) return inner;
  }
  const wrap = el.closest("label, .form-group, .iCIMS_TableRow, td, [class*='field'], [class*='Field']");
  const fromWrap = wrap?.querySelector("select");
  return fromWrap instanceof HTMLSelectElement ? fromWrap : null;
}

function selectShown(sel) {
  if (!(sel instanceof HTMLSelectElement) || sel.selectedIndex < 0) return "";
  const t = text(sel.options[sel.selectedIndex]);
  if (!t || SELECT_PLACEHOLDER_RE.test(t)) return "";
  return t;
}

function associatedSelectOptions(el) {
  const sel = associatedSelect(el);
  if (!sel) return [];
  return [...sel.options].map((o) => o.text.trim()).filter((t) => t && !SELECT_PLACEHOLDER_RE.test(t));
}

function commitAssociatedSelect(el, label) {
  const sel = associatedSelect(el);
  if (!sel) return false;
  const want = String(label || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  let opt = null;
  for (const o of sel.options) {
    const nt = o.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    const nv = o.value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (nt === want || nv === want) {
      opt = o;
      break;
    }
  }
  if (!opt) return false;
  sel.value = opt.value;
  opt.selected = true;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  if (window.jQuery) window.jQuery(sel).val(opt.value).trigger("change");
  if (el instanceof HTMLElement && el.getAttribute("role") === "combobox" && el.childElementCount === 0) {
    el.textContent = opt.text;
  }
  return sel.value === opt.value;
}

/** The picks a custom dropdown shows ("Man", or "A, B" for a multi-select); "" when none. */
function chosenText(el) {
  const fromSelect = selectShown(associatedSelect(el));
  if (fromSelect) return fromSelect;
  const widget = text(el.closest(".select2-container, .chosen-container")?.querySelector(".select2-selection__rendered, .chosen-single span, .chosen-single"));
  if (widget && !SELECT_PLACEHOLDER_RE.test(widget)) return widget;
  // The chosen chip sits beside the input's own wrapper, a few levels up; stop before the next question.
  let box = el.parentElement;
  for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
    if (box.querySelectorAll("input[role='combobox'], select").length > 1) return "";
    const single = text(box.querySelector("[class*='single-value'], [class*='singleValue']"));
    if (single) return single;
    const multi = [...box.querySelectorAll("[class*='multi-value__label'], [class*='multiValue'] [class*='label'], [class*='multi-value']")]
      .map(text)
      .filter(Boolean);
    if (multi.length > 0) return [...new Set(multi)].join(", ");
  }
  return "";
}

function hasChosenValue(el) {
  if (isWorkdayChoice(el)) return Boolean(workdayChosen(el));
  return Boolean(chosenText(el));
}

function maxLengthOf(el) {
  const n = Number(el.getAttribute("maxlength"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isPressed(el) {
  return el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-checked") === "true";
}
