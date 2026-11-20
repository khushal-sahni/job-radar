/* Part of the page bridge (see browser-fill.ts `bridgeSource`); shares one scope with the other parts. */
/* Finds unfilled controls and stamps them with data-jr-id; reports required questions it cannot see. */

/**
 * Required question headings with no scanned control near them. Call after scan() has
 * stamped controls. A non-empty list means the form has a question we cannot see.
 */
function unreadRequired() {
  const out = new Set();
  for (const h of document.querySelectorAll(HEADING_SEL)) {
    if (!isVisible(h) || h.querySelector(CONTROL_SEL) || h.closest("[role='alert']")) continue;
    if (!isRequiredHeading(h)) continue;
    const t = text(h).replace(/[*✱]/g, "").trim();
    if (!t || t.length > 300) continue;
    if (hasAttachedFile(h) || isSectionTitle(h, t)) continue;
    const forId = h.getAttribute("for");
    const target = forId ? document.getElementById(forId) : null;
    if (target && (target.dataset.jrId || target.dataset.jrGroup || target.querySelector("[data-jr-id], [data-jr-group]"))) continue;
    // Covered when the nearest box holding a scanned control is this question's alone.
    let covered = false;
    for (let box = h.parentElement, i = 0; box && box !== document.body && i < 4; box = box.parentElement, i++) {
      const stamped = [...box.querySelectorAll("[data-jr-id], [data-jr-group]")];
      if (stamped.length === 0) continue;
      const required = new Set(
        [...box.querySelectorAll(HEADING_SEL)]
          .filter((x) => isVisible(x) && !x.querySelector(CONTROL_SEL) && isRequiredHeading(x))
          .map((x) => text(x).replace(/[*✱]/g, "").trim())
          .filter(Boolean),
      );
      covered = [...required].filter((r) => !t.includes(r) && !r.includes(t)).length === 0;
      break;
    }
    if (!covered) out.add(t.slice(0, 160));
  }
  return [...out];
}

function scan() {
  const fields = [];
  const seenGroups = new Set();

  const controls = document.querySelectorAll(
    "input, textarea, select, [role='combobox'], [contenteditable='true'][role='textbox'], button[aria-haspopup='listbox']",
  );
  for (const el of controls) {
    if (el.disabled || el.readOnly && !(el.getAttribute("role") === "combobox")) continue;
    if (el.closest("[data-automation-id='dateInputWrapper']")) continue;
    if (el.tagName === "BUTTON" && !isWorkdayChoice(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && SKIP_INPUT_TYPES.has(type)) continue;
    if (tag === "input" && isSecurityCodeInput(el)) continue;

    if (type === "radio" || type === "checkbox") {
      if (seenGroups.has(el)) continue;
      const group = choiceGroup(el, type);
      group.forEach((input) => seenGroups.add(input));
      const visibleGroup = group.filter(isChoiceVisible);
      if (visibleGroup.length === 0) continue;

      let box = visibleGroup.length > 1 ? container(visibleGroup[0]) : container(el);
      while (box && box.parentElement && !visibleGroup.every((input) => box.contains(input))) {
        box = container(box.parentElement);
      }
      const options = visibleGroup.map((input) => {
        input.dataset.jrOpt = text(labelElementFor(input)) || input.value;
        return input.dataset.jrOpt;
      });
      const single = type === "checkbox" && visibleGroup.length === 1;
      const choiceTexts = new Set(options.map((o) => o.toLowerCase()));
      let label = "";
      if (box) {
        const heading = [
          ...box.querySelectorAll("legend, [class*='label'], [class*='Label'], [class*='question'], [class*='title']"),
        ].find((h) => {
          const t = text(h);
          return t && !choiceTexts.has(t.toLowerCase()) && !visibleGroup.some((input) => h.contains(input));
        });
        label = text(heading);
      }
      if (!label && single) label = options[0];
      // Workday puts "I currently work here" under the From date; the checkbox's own words are the question.
      if (single && /^(from|to|start|end)$/i.test(label.replace(/[*✱]/g, "").trim()) && /currently work here/i.test(options[0] || "")) {
        label = options[0];
      }
      if (!label) label = questionText(visibleGroup[0], false);
      const id = stamp(visibleGroup[0]);
      visibleGroup.forEach((input) => (input.dataset.jrGroup = id));
      const checked = visibleGroup.filter((i) => i.checked).map((i) => i.dataset.jrOpt);
      fields.push({
        id,
        label,
        control: type,
        multi: type === "checkbox" && visibleGroup.length > 1,
        options,
        required: visibleGroup.some((i) => i.required || i.getAttribute("aria-required") === "true") || isRequired(visibleGroup[0], label, box),
        maxLength: null,
        freeText: false,
        empty: checked.length === 0,
        shown: checked.join(", "),
        section: sectionOf(visibleGroup[0]),
      });
      continue;
    }

    if (type === "file") {
      const box = container(el);
      // Greenhouse labels the input itself "Attach"; the question is the upload group's title.
      const group = el.closest("[role='group'][aria-labelledby]");
      const groupTitle = group ? text(document.getElementById(group.getAttribute("aria-labelledby"))).replace(/[*✱]/g, "").trim() : "";
      const label = groupTitle || questionText(el, true) || text(box);
      fields.push({
        id: stamp(el),
        label,
        control: "file",
        options: [],
        required: isRequired(el, label, box),
        maxLength: null,
        freeText: false,
        empty: !(el.files && el.files.length > 0) && !/\.(pdf|docx?)\b/i.test(text(box)),
        resumeLike: /resume|cv|curriculum|lebenslauf/i.test(`${label} ${el.name} ${el.id}`),
      });
      continue;
    }

    if (!isVisible(el)) continue;
    const box = container(el);
    // A Workday list button's aria-label carries its value ("Country India Required"); the field's label does not.
    const workdayLabel = isWorkdayChoice(el) ? text(el.closest("[data-automation-id^='formField']").querySelector("label")) : "";
    const label = workdayLabel || questionText(el, true);
    // Lever's location box looks like text, but a typed value is wiped on blur unless a suggestion was chosen.
    const isCombo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list" || isWorkdayChoice(el) || el.classList.contains("location-input");
    const control = tag === "select" ? "select" : tag === "textarea" ? "textarea" : isCombo ? "combobox" : el.isContentEditable ? "textarea" : "text";
    const options =
      tag === "select"
        ? [...el.options]
            .filter((o) => o.text.trim() && !/^(select|choose|--|please select)|make a selection/i.test(o.text.trim()))
            .map((o) => o.text.trim())
        : [];
    let empty;
    if (tag === "select") empty = el.value === "" || el.selectedIndex < 0 || !options.includes(el.options[el.selectedIndex]?.text.trim());
    else if (el.isContentEditable) empty = !text(el);
    else empty = !String(el.value || "").trim() && !(isCombo && hasChosenValue(el));
    const maxLength = maxLengthOf(el);

    const shown = tag === "select" && !empty ? text(el.options[el.selectedIndex]) : String(el.value || "").trim() || chosenText(el);
    fields.push({
      id: stamp(el),
      label,
      control,
      options,
      required: isRequired(el, label, box),
      maxLength,
      freeText: control === "textarea" || (control === "text" && ((maxLength ?? 0) > 200 || FREE_TEXT_RE.test(label))),
      empty,
      shown,
      section: sectionOf(el),
    });
  }
  fields.push(...workdayDates());
  fields.push(...buttonChoiceGroups());
  return fields;
}

/** A Workday date (MM/YYYY or YYYY) is spinbutton inputs inside one wrapper. One field, labeled from the form row. */
function workdayDates() {
  const out = [];
  for (const wrapper of document.querySelectorAll("[data-automation-id='dateInputWrapper']")) {
    if (!isVisible(wrapper)) continue;
    const month = wrapper.querySelector("input[data-automation-id='dateSectionMonth-input']");
    const year = wrapper.querySelector("input[data-automation-id='dateSectionYear-input']");
    if (!year) continue;
    const row = wrapper.closest("[data-automation-id^='formField']");
    const label = text(row?.querySelector("legend label, label")) || questionText(wrapper, false);
    if (!label) continue;
    const day = wrapper.querySelector("input[data-automation-id='dateSectionDay-input']");
    const blank = (el) => !el.value.trim() || /^(dd|mm|yyyy)$/i.test(el.getAttribute("aria-valuetext") ?? "");
    out.push({
      id: stamp(wrapper),
      label,
      control: "text",
      options: [],
      required: isRequired(wrapper, label, row || wrapper),
      maxLength: null,
      freeText: false,
      empty: (day != null && blank(day)) || (month != null && blank(month)) || blank(year),
      section: sectionOf(wrapper),
    });
  }
  return out;
}

/** Yes/No drawn as toggle buttons (Ashby) or ARIA radios; any real input behind them is hidden. */
function buttonChoiceGroups() {
  const groups = new Map();
  for (const btn of document.querySelectorAll("button[aria-pressed], [role='radio']:not(input)")) {
    if (!isVisible(btn) || !btn.parentElement) continue;
    const key = btn.closest("[role='radiogroup']") ?? btn.parentElement;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(btn);
  }
  const out = [];
  for (const [parent, buttons] of groups) {
    if (buttons.length < 2) continue;
    const box = container(parent);
    if (box && box.querySelector("input[data-jr-group]")) continue;
    const label = questionText(parent, false);
    if (!label) continue;
    const id = stamp(buttons[0]);
    const options = buttons.map((btn) => {
      btn.dataset.jrGroup = id;
      btn.dataset.jrOpt = text(btn) || btn.getAttribute("aria-label") || "";
      return btn.dataset.jrOpt;
    });
    out.push({
      id,
      label,
      control: "radio",
      options,
      required: isRequired(buttons[0], label, box),
      maxLength: null,
      freeText: false,
      empty: !buttons.some(isPressed),
      section: sectionOf(buttons[0]),
    });
  }
  return out;
}
