window.JobRadar = window.JobRadar || {};

(function (JR) {
  const {
    fillById,
    fillByName,
    fillByLabel,
    fillFileInput,
    fillSelect,
    findLabelInput,
    parseCountryFromLocation,
  } = JR.fill;

  async function fillGreenhouse(profile) {
    let filled = 0;
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
    const country = parseCountryFromLocation(profile.location);

    const textAttempts = [
      () => fillById("first_name", profile.firstName),
      () => fillByName("job_application[first_name]", profile.firstName),
      () => fillById("last_name", profile.lastName),
      () => fillByName("job_application[last_name]", profile.lastName),
      () => fillByLabel("preferred name", fullName),
      () => fillById("preferred_name", fullName),
      () => fillByName("job_application[preferred_name]", fullName),
      () => fillById("email", profile.email),
      () => fillByName("job_application[email]", profile.email),
      () => fillById("phone", profile.phone),
      () => fillByName("job_application[phone]", profile.phone),
      () => fillByLabel("linkedin", profile.linkedInUrl),
      () => fillByLabel("github", profile.githubUrl),
      () => fillByLabel("website", profile.portfolioUrl),
      () => fillByLabel("portfolio", profile.portfolioUrl),
      () => fillByLabel("current company", profile.currentCompany),
      () => fillByLabel("cover letter", profile.resumeSummary),
      () => fillByLabel("additional information", profile.resumeSummary),
    ];

    for (const attempt of textAttempts) {
      if (attempt()) filled += 1;
    }

    // Country: native <select> only. Greenhouse's react-select country and location search boxes
    // ignore typing from page script; the apply runner fills those with real keystrokes.
    if (country) {
      const labelled = findLabelInput("country");
      if (fillSelect(document.getElementById("country"), country)) filled += 1;
      else if (fillSelect(document.querySelector("select[name*='country']"), country)) filled += 1;
      else if (labelled instanceof HTMLSelectElement && fillSelect(labelled, country)) filled += 1;
    }

    const fileInputs = document.querySelectorAll("input[type='file']");
    for (const input of fileInputs) {
      const label =
        input.closest("label")?.textContent?.toLowerCase() ??
        input.getAttribute("aria-label")?.toLowerCase() ??
        "";
      if (
        label.includes("resume") ||
        label.includes("cv") ||
        input.id?.includes("resume")
      ) {
        if (
          await fillFileInput(
            input,
            profile.resumePdfBase64,
            profile.resumeFilename ?? "resume.pdf",
          )
        ) {
          filled += 1;
        }
      }
    }

    const customFields = [
      ["linkedin profile", profile.linkedInUrl],
      ["github", profile.githubUrl],
      ["portfolio", profile.portfolioUrl],
      ["notice period", profile.noticePeriod],
      ["expected ctc", profile.expectedCtc],
      ["expected salary", profile.expectedCtc],
    ];

    for (const [label, value] of customFields) {
      if (fillByLabel(label, value)) filled += 1;
    }

    return filled;
  }

  JR.extractors = JR.extractors || {};
  JR.extractors.greenhouse = fillGreenhouse;
})(window.JobRadar);
