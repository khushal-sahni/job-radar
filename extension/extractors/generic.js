window.JobRadar = window.JobRadar || {};

(function (JR) {
  const { fillText, fillFileInput } = JR.fill;

  async function fillGeneric(profile) {
    let filled = 0;
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");

    document.querySelectorAll("input, textarea").forEach((el) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      if (el instanceof HTMLInputElement && ["hidden", "password", "submit", "button", "file"].includes(el.type)) {
        return;
      }

      const haystack = [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
        el.closest("label")?.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (/first.?name|given/.test(haystack) && fillText(el, profile.firstName)) filled += 1;
      else if (/last.?name|family|surname/.test(haystack) && fillText(el, profile.lastName)) filled += 1;
      else if (/full.?name|^name$/.test(haystack) && fillText(el, fullName)) filled += 1;
      else if (/email/.test(haystack) && fillText(el, profile.email)) filled += 1;
      else if (/phone|mobile|tel/.test(haystack) && fillText(el, profile.phone)) filled += 1;
      else if (/linkedin/.test(haystack) && fillText(el, profile.linkedInUrl)) filled += 1;
      else if (/github/.test(haystack) && fillText(el, profile.githubUrl)) filled += 1;
      else if (/portfolio|website|personal/.test(haystack) && fillText(el, profile.portfolioUrl)) filled += 1;
      else if (/company|employer/.test(haystack) && fillText(el, profile.currentCompany)) filled += 1;
      else if (/notice/.test(haystack) && fillText(el, profile.noticePeriod)) filled += 1;
      // Only an expected-pay box takes the expected figure; current pay is filled from facts by the runner.
      else if (/expect|desired/.test(haystack) && /salary|ctc|compensation/.test(haystack) && fillText(el, profile.expectedCtc)) filled += 1;
      else if (/cover|summary|about|additional/.test(haystack) && fillText(el, profile.resumeSummary)) filled += 1;
    });

    const fileInputs = document.querySelectorAll("input[type='file']");
    for (const input of fileInputs) {
      const ctx = `${input.name} ${input.id} ${input.closest("label")?.textContent ?? ""}`.toLowerCase();
      if (ctx.includes("resume") || ctx.includes("cv") || fileInputs.length === 1) {
        if (
          await fillFileInput(
            input,
            profile.resumePdfBase64,
            profile.resumeFilename ?? "resume.pdf",
          )
        ) {
          filled += 1;
          break;
        }
      }
    }

    return filled;
  }

  JR.extractors = JR.extractors || {};
  JR.extractors.generic = fillGeneric;
})(window.JobRadar);
