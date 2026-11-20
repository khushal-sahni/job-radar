window.JobRadar = window.JobRadar || {};

(function (JR) {
  const { fillText, fillFileInput } = JR.fill;

  async function fillWorkable(profile) {
    let filled = 0;
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");

    const selectors = [
      ["input[name='name'], input[data-ui='candidate-name']", fullName],
      ["input[name='email'], input[type='email']", profile.email],
      ["input[name='phone'], input[type='tel']", profile.phone],
      ["input[name='linkedin'], input[placeholder*='LinkedIn' i]", profile.linkedInUrl],
      ["textarea[name='cover_letter'], textarea[placeholder*='cover' i]", profile.resumeSummary],
    ];

    for (const [selector, value] of selectors) {
      const el = document.querySelector(selector);
      if (el && fillText(el, value)) filled += 1;
    }

    const resumeInput = document.querySelector("input[type='file']");
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

    document.querySelectorAll("label").forEach((label) => {
      const text = label.textContent?.toLowerCase() ?? "";
      const input = label.querySelector("input, textarea") ??
        (label.getAttribute("for")
          ? document.getElementById(label.getAttribute("for"))
          : null);

      if (!input) return;
      if (text.includes("github") && fillText(input, profile.githubUrl)) filled += 1;
      if (text.includes("portfolio") && fillText(input, profile.portfolioUrl)) filled += 1;
      if (text.includes("company") && fillText(input, profile.currentCompany)) filled += 1;
    });

    return filled;
  }

  JR.extractors = JR.extractors || {};
  JR.extractors.workable = fillWorkable;
})(window.JobRadar);
