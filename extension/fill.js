/**
 * React-safe form fill utilities
 */
window.JobRadar = window.JobRadar || {};

(function (JR) {
  const SKIP_TYPES = new Set([
    "password",
    "hidden",
    "submit",
    "button",
    "reset",
    "image",
  ]);

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function setNativeValue(element, value) {
    if (!element) return false;

    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = descriptor?.set;

    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function highlight(element) {
    if (!element) return;
    const prev = element.style.outline;
    element.style.outline = "2px solid #34d399";
    element.style.outlineOffset = "2px";
    setTimeout(() => {
      element.style.outline = prev;
      element.style.outlineOffset = "";
    }, 1200);
  }

  function findById(id) {
    return document.getElementById(id);
  }

  function findByName(name) {
    return document.querySelector(`[name="${CSS.escape(name)}"]`);
  }

  function findLabelInput(labelText) {
    const normalized = labelText.toLowerCase();
    const labels = document.querySelectorAll("label");

    for (const label of labels) {
      const text = label.textContent?.trim().toLowerCase() ?? "";
      if (!text.includes(normalized)) continue;

      const forId = label.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }

      const input = label.querySelector("input, textarea, select");
      if (input) return input;

      const sibling = label.parentElement?.querySelector(
        "input, textarea, select, [role='combobox'], [role='listbox']",
      );
      if (sibling) return sibling;

      const field = label.closest(".field, .form-group, [class*='field']");
      if (field) {
        const inner = field.querySelector("input, textarea, select, [role='combobox']");
        if (inner) return inner;
      }
    }

    return null;
  }

  function parseCountryFromLocation(location) {
    if (!location) return "";
    const parts = location.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? "";
  }

  // Same ranking as matchOption in src/lib/apply/profile-map.ts (this file is injected, so it can't import it). Keep them in step.
  const PLACE_ALIASES = {
    gurgaon: "gurugram",
    bangalore: "bengaluru",
    bombay: "mumbai",
    calcutta: "kolkata",
    madras: "chennai",
    indien: "india",
    deutschland: "germany",
    vereinigte: "united",
    staaten: "states",
  };

  function optionWords(text) {
    return String(text ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => PLACE_ALIASES[w] ?? w);
  }

  function optionScore(wanted, option, country) {
    const words = optionWords(option);
    if (words.length === 0) return 0;
    let score = 0;
    if (words.join(" ") === wanted.join(" ")) score = 100;
    else if (wanted.every((w) => words.includes(w))) score = 50 + (words[0] === wanted[0] ? 10 : 0);
    else if (words.every((w) => wanted.includes(w))) score = 30;
    if (score === 0) return 0;
    const last = optionWords(String(option).split(",").pop());
    if (country.length > 0 && last.join(" ") === country.join(" ")) score += 20;
    return score;
  }

  /** Index of the one best option by whole words, or -1 on no match or a tie (the runner decides ties). */
  function bestOptionIndex(value, texts, preferCountry) {
    const wanted = optionWords(value);
    if (wanted.length === 0) return -1;
    const country = preferCountry ? optionWords(preferCountry) : [];
    let best = -1;
    let bestScore = 0;
    let tied = false;
    texts.forEach((text, i) => {
      const score = optionScore(wanted, text, country);
      if (score === 0 || score < bestScore) return;
      if (score === bestScore && best >= 0) {
        if (optionWords(text).join(" ") !== optionWords(texts[best]).join(" ")) tied = true;
        return;
      }
      best = i;
      bestScore = score;
      tied = false;
    });
    return tied ? -1 : best;
  }

  const OPTION_SELECTOR = "[role='option'], .select__option, [class*='select__option']";

  /** Options of the menu this control opened (aria-controls), else inside its own field; Places menus are page-wide. */
  function openOptions(control) {
    const listId = control.getAttribute("aria-controls") || control.getAttribute("aria-owns");
    const list = listId ? document.getElementById(listId) : null;
    const field = control.closest(".select__container, .field, .form-group, [class*='field'], [class*='Field']");
    const root = list ?? field;
    let pool = root ? [...root.querySelectorAll(OPTION_SELECTOR)] : [];
    if (pool.length === 0) pool = [...document.querySelectorAll(".pac-item")];
    return pool.filter((el) => {
      const text = el.textContent?.trim() ?? "";
      const r = el.getBoundingClientRect();
      return text && r.width > 0 && r.height > 0 && !/^(no options|loading)/i.test(text);
    });
  }

  /** Waits for suggestions to load and settle (same list twice), up to ~3s. */
  async function waitForOpenOptions(control) {
    let last = "";
    let options = [];
    for (let i = 0; i < 10; i++) {
      await delay(300);
      options = openOptions(control);
      const key = options.map((o) => o.textContent.trim()).join("\u0001");
      if (options.length > 0 && key === last) return options;
      last = key;
    }
    return options;
  }

  /** Types like a keyboard: input events only. setNativeValue's blur would close the menu before it opens. */
  async function typeInto(input, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const set = (v) => (setter ? setter.call(input, v) : (input.value = v));
    input.focus();
    input.click();
    set("");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    let typed = "";
    for (const char of text) {
      typed += char;
      set(typed);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
      await delay(35);
    }
  }

  function clickOption(opt) {
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opt.click();
  }

  /** Clicks the unique best option; on no match or a tie, clears the box so the runner sees it empty. */
  async function pickFromOpenMenu(control, wanted, preferCountry) {
    const options = await waitForOpenOptions(control);
    const index = bestOptionIndex(wanted, options.map((o) => o.textContent.trim()), preferCountry);
    if (index < 0) {
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, keyCode: 27 }));
      if (control instanceof HTMLInputElement) setNativeValue(control, "");
      return false;
    }
    clickOption(options[index]);
    await delay(100);
    highlight(control);
    return true;
  }

  /** Hidden or off-screen text inputs are usually bot traps. */
  function isHiddenTrap(element) {
    if (element.closest("[aria-hidden='true'], [hidden]")) return true;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return true;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return true;
    return rect.left + window.scrollX < -500 || rect.top + window.scrollY < -500;
  }

  function fillText(element, value) {
    if (!element || value == null || value === "") return false;
    if (element instanceof HTMLInputElement && SKIP_TYPES.has(element.type)) {
      return false;
    }
    if (isHiddenTrap(element)) return false;
    const ok = setNativeValue(element, String(value));
    if (ok) highlight(element);
    return ok;
  }

  function fillById(id, value) {
    return fillText(findById(id), value);
  }

  function fillByName(name, value) {
    return fillText(findByName(name), value);
  }

  function fillByLabel(label, value) {
    return fillText(findLabelInput(label), value);
  }

  function fillSelect(element, searchText) {
    if (!(element instanceof HTMLSelectElement) || !searchText) return false;
    const options = [...element.options].filter((o) => o.value !== "");
    const index = bestOptionIndex(searchText, options.map((o) => o.text));
    if (index < 0) return false;
    element.value = options[index].value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    highlight(element);
    return true;
  }

  async function fillSelectByLabel(label, value) {
    const el = findLabelInput(label);
    if (el instanceof HTMLSelectElement) {
      return fillSelect(el, value);
    }
    return fillCustomDropdown(el, value);
  }

  /** Country-style dropdown: type the name to filter, then click the unique whole-word match. */
  async function fillCustomDropdown(trigger, searchText) {
    if (!trigger || !searchText) return false;
    if (trigger instanceof HTMLInputElement) await typeInto(trigger, searchText);
    else {
      trigger.focus();
      trigger.click();
    }
    return pickFromOpenMenu(trigger, searchText);
  }

  /** Place search: type just the city ("Gurugram, India" finds nothing; "Gurugram" does), then pick by whole words. */
  async function fillAutocomplete(input, value) {
    if (!input || !value) return false;
    const city = value.split(",")[0].trim();
    await typeInto(input, city);
    return pickFromOpenMenu(input, value, parseCountryFromLocation(value));
  }

  async function fillAutocompleteByLabel(label, value) {
    const el = findLabelInput(label);
    if (!el) return false;
    return fillAutocomplete(el, value);
  }

  async function fillFileInput(element, base64, filename) {
    if (!element || !(element instanceof HTMLInputElement) || element.type !== "file") {
      return false;
    }
    if (!base64 || !filename) return false;

    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], filename, { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      element.files = dt.files;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      highlight(element);
      return true;
    } catch {
      return false;
    }
  }

  async function selectReactOption(input, optionText) {
    if (!input || !optionText) return false;
    await typeInto(input, optionText);
    return pickFromOpenMenu(input, optionText);
  }

  JR.fill = {
    setNativeValue,
    highlight,
    fillText,
    fillById,
    fillByName,
    fillByLabel,
    fillSelect,
    fillSelectByLabel,
    fillAutocomplete,
    fillAutocompleteByLabel,
    fillCustomDropdown,
    fillFileInput,
    selectReactOption,
    parseCountryFromLocation,
    findById,
    findByName,
    findLabelInput,
    delay,
  };
})(window.JobRadar);
