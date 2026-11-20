/* Part of the page bridge (see browser-fill.ts `bridgeSource`); shares one scope with the other parts. */
/* What each scanned control shows right now, for the pre-submit audit. */

function checkedOptions(field) {
  return [...document.querySelectorAll(`[data-jr-group="${field.id}"]`)]
    .filter((el) => (el.tagName === "INPUT" ? el.checked : isPressed(el)))
    .map((el) => el.dataset.jrOpt);
}

function currentValue(field) {
  if (field.control === "radio" || field.control === "checkbox") return checkedOptions(field).join(", ");
  if (field.control === "file") return field.empty ? "" : "attached";
  const el = document.querySelector(`[data-jr-id="${field.id}"]`);
  if (!el) return "";
  if (el.tagName === "SELECT") return field.empty ? "" : text(el.options[el.selectedIndex]);
  if (el.isContentEditable) return text(el);
  if (isWorkdayChoice(el)) return workdayChosen(el);
  const value = String(el.value || "").trim();
  // Only a dropdown shows its pick outside the input; a text box's nearest "container" can be the whole form.
  if (value || field.control !== "combobox") return value;
  return chosenText(el);
}

function answers() {
  return scan().map((f) => ({
    id: f.id,
    label: f.label,
    required: f.required,
    value: currentValue(f),
    control: f.control,
    options: f.options,
    freeText: f.freeText,
    checked: f.control === "radio" || f.control === "checkbox" ? checkedOptions(f) : null,
  }));
}
