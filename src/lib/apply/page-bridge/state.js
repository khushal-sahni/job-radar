/* Part of the page bridge (see browser-fill.ts `bridgeSource`); shares one scope with the other parts. */
/* Page state: form present, confirmation, closed, captcha, security code, submit / next buttons, errors. */

const SECURITY_CODE_RE = /\b(security[ _-]?(code|input)|verification[ _-]?code|one[ -]time (pass)?code|confirm your identity)\b/i;

function isSecurityCodeInput(el) {
  if (el.tagName !== "INPUT") return false;
  if (el.getAttribute("autocomplete") === "one-time-code") return true;
  const hint = `${questionText(el, true)} ${el.name} ${el.id} ${el.getAttribute("placeholder") || ""}`;
  if (SECURITY_CODE_RE.test(hint)) return true;
  // Rows of one-character boxes usually carry no label of their own; read the visible text around them.
  if (maxLengthOf(el) !== 1) return false;
  let box = el.parentElement;
  for (let i = 0; box && i < 3; i++, box = box.parentElement) {
    if (SECURITY_CODE_RE.test((box.innerText || "").slice(0, 400))) return true;
  }
  return false;
}

/** Stamped ids of the emailed-code input: one field, or a row of one-character boxes in order. */
function securityCodeInputs() {
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => isVisible(el) && !el.disabled && /^(text|tel|number|)$/.test((el.getAttribute("type") || "").toLowerCase()),
  );
  const first = inputs.find(isSecurityCodeInput);
  if (!first) return [];
  if (maxLengthOf(first) !== 1) return [stamp(first)];
  const row = inputs.filter((el) => maxLengthOf(el) === 1 && el.parentElement?.parentElement === first.parentElement?.parentElement);
  return row.map(stamp);
}

function visibleFrame(selector) {
  return [...document.querySelectorAll(selector)].some((f) => {
    if (f.closest(".grecaptcha-badge")) return false;
    const r = f.getBoundingClientRect();
    return isVisible(f) && r.width >= 60 && r.height >= 60;
  });
}

function findButton(re) {
  // Career sites (BCG Phenom) use a plain <a>Apply</a> with no button class.
  const candidates = [
    ...document.querySelectorAll("button, input[type='submit'], [role='button'], a[class*='button'], a[class*='btn']"),
    ...document.querySelectorAll("a"),
  ];
  const seen = new Set();
  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    const label = (el.tagName === "INPUT" ? el.value : text(el)) || el.getAttribute("aria-label") || "";
    if (re.test(label.trim())) return stamp(el);
  }
  return null;
}

function byAutomationId(name) {
  for (const el of document.querySelectorAll(`[data-automation-id='${name}']`)) {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    if (isVisible(el)) return stamp(el);
    const filter = el.parentElement?.querySelector("[data-automation-id='click_filter']");
    if (filter && isVisible(filter)) return stamp(el);
  }
  return null;
}

function pageText() {
  let t = document.body?.innerText ?? "";
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      const doc = frame.contentDocument;
      if (doc?.body) t += `\n${doc.body.innerText ?? ""}`;
    } catch {
      // Cross-origin widget (Phenom thank-you, cookie banners).
    }
  }
  return t;
}

function state() {
  const body = pageText();
  const errors = [...document.querySelectorAll("[role='alert'], [class*='error'], [class*='Error'], [aria-invalid='true']")]
    .filter(isVisible)
    .map((el) => {
      if (el.getAttribute("aria-invalid") === "true") return questionText(el, true) + ": invalid";
      const t = text(el);
      // "Missing entry for required field:" names its question only through layout.
      if (!/:\s*$/.test(t)) return t;
      // Ashby links the error to its field; the link text can be empty.
      let linkedQuestion = "";
      try {
        const link = el.querySelector("a[href^='#']");
        const linked = link && document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1)));
        if (linked) {
          const control = linked.matches(CONTROL_SEL) ? linked : linked.querySelector(CONTROL_SEL) || linked;
          linkedQuestion = questionText(control, true) || text(linked.querySelector("label"));
        }
      } catch {
        linkedQuestion = "";
      }
      if (linkedQuestion) return `${t} ${linkedQuestion}`;
      const box = container(el);
      const control = box && box.querySelector(CONTROL_SEL);
      const question = (control && questionText(control, true)) || (box && headingBefore(box, el)) || "";
      return question ? `${t} ${question}` : t;
    })
    .filter((t) => t && t.length < 200);

  const submitTyped = [...document.querySelectorAll("form button[type='submit'], form input[type='submit']")].find(
    (el) => isVisible(el) && !el.disabled,
  );

  const nextId = findButton(NEXT_RE) ?? byAutomationId("pageFooterNextButton");
  const submitId =
    findButton(SUBMIT_RE) ??
    (submitTyped ? stamp(submitTyped) : null) ??
    findButton(APPLY_SUBMIT_RE) ??
    byAutomationId("pageFooterSubmitButton");

  return {
    captcha:
      visibleFrame("iframe[src*='recaptcha'][src*='anchor'], iframe[src*='recaptcha'][src*='bframe']") ||
      visibleFrame("iframe[src*='hcaptcha.com']") ||
      visibleFrame("iframe[src*='challenges.cloudflare.com']") ||
      [...document.querySelectorAll(".cf-turnstile, .h-captcha, .g-recaptcha:not(.grecaptcha-badge)")].some(
        (el) => isVisible(el) && el.getBoundingClientRect().height >= 40,
      ),
    confirmation: CONFIRM_RE.test(body) || /\/(thank|confirmation|success|submitted|already-received)/i.test(location.pathname),
    closed: CLOSED_RE.test(body.slice(0, 4000)),
    // Create-login password boxes on an iCIMS candidate profile are part of the application, not a wall.
    loginWall:
      LOGIN_RE.test(body) ||
      ([...document.querySelectorAll("input[type='password']")].some(isVisible) &&
        !document.querySelector(
          "#cp_form_submit_i, input[name='PersonProfileFields.Password'], [data-automation-id='applyFlowPage']",
        )),
    errors: [...new Set(errors)].slice(0, 8),
    securityCodeIds: securityCodeInputs(),
    // Workday's "Next" is a type=submit button; it moves the wizard on and sends nothing.
    submitId: submitId === nextId ? null : submitId,
    nextId,
    hasForm: Boolean(
      document.querySelector(
        "#application_form, form[action*='applications'], .application-form, form.postings-form, [data-ui='application-form'], form input[type='email'], form input[name*='email'], input[type='file'], [data-automation-id='applyFlowPage'], #cp_form_submit_i, #enterEmailForm, input[name='PersonProfileFields.FirstName']",
      ),
    ),
    greenhouseFrame:
      document.querySelector("iframe#grnhse_iframe, iframe[src*='greenhouse.io/embed'], iframe[src*='job_app']")?.src ?? null,
    icimsFrame:
      document.querySelector("iframe#icims_content_iframe, iframe[name='icims_content_iframe']")?.src ?? null,
    applyLinkId:
      findButton(/^(apply|apply now|apply for this (job|position|role)|i'm interested)$/i) ??
      // Career sites word it their own way ("Apply for this job online", "Apply here"); never a job-board sign-in.
      findButton(/^(?=.{0,40}$)(?!.*\b(linkedin|indeed|seek|xing|google|applied)\b).*\bapply\b/i),
  };
}

/** What a scanned control shows right now, as text. */
