window.JobRadar = window.JobRadar || {};

(function (JR) {
  const { fillText, fillFileInput } = JR.fill;

  async function fillAshby(profile) {
    let filled = 0;

    const fieldMap = [
      { match: /first.?name/i, value: profile.firstName },
      { match: /last.?name/i, value: profile.lastName },
      { match: /email/i, value: profile.email },
      { match: /phone/i, value: profile.phone },
      { match: /linkedin/i, value: profile.linkedInUrl },
      { match: /github/i, value: profile.githubUrl },
      { match: /portfolio|website/i, value: profile.portfolioUrl },
      { match: /company/i, value: profile.currentCompany },
      { match: /cover|additional|why/i, value: profile.resumeSummary },
    ];

    document.querySelectorAll("input, textarea").forEach((el) => {
      if (el instanceof HTMLInputElement && ["hidden", "file", "submit"].includes(el.type)) {
        return;
      }

      const haystack = [
        el.getAttribute("name"),
        el.getAttribute("id"),
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.closest("label")?.textContent,
      ]
        .filter(Boolean)
        .join(" ");

      for (const { match, value } of fieldMap) {
        if (match.test(haystack) && fillText(el, value)) {
          filled += 1;
          break;
        }
      }
    });

    // "Autofill from resume" is a separate file input; uploading there re-renders the form.
    const resumeInput =
      document.querySelector("input[type='file'][id*='resume' i], input[type='file'][name*='resume' i]") ??
      [...document.querySelectorAll("input[type='file']")].pop();
    if (
      resumeInput &&
      (await fillFileInput(
        resumeInput,
        profile.resumePdfBase64,
        profile.resumeFilename ?? "resume.pdf",
      ))
    ) {
      filled += 1;
    }

    return filled;
  }

  JR.extractors = JR.extractors || {};
  JR.extractors.ashby = fillAshby;
})(window.JobRadar);
