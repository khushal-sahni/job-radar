window.JobRadar = window.JobRadar || {};

(function (JR) {
  const { fillText, fillFileInput } = JR.fill;

  function query(selector) {
    return document.querySelector(selector);
  }

  async function waitForLeverForm(maxMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (document.querySelector(".application-form, form.postings-form, input[name='name']")) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async function fillLever(profile) {
    await waitForLeverForm();

    let filled = 0;
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");

    const mappings = [
      ["input[name='name']", fullName],
      ["input[name='email']", profile.email],
      ["input[name='phone']", profile.phone],
      // Location is a suggestion list: typing then blurring clears it. The runner picks a row.
      ["input[name='org']", profile.currentCompany],
      ["input[name='urls[LinkedIn]']", profile.linkedInUrl],
      ["input[name='urls[GitHub]']", profile.githubUrl],
      ["input[name='urls[Portfolio]']", profile.portfolioUrl],
      ["input[name='urls[Website]']", profile.portfolioUrl],
      ["textarea[name='comments']", profile.resumeSummary],
      ["textarea", profile.resumeSummary],
    ];

    for (const [selector, value] of mappings) {
      const el = query(selector);
      if (el && fillText(el, value)) filled += 1;
    }

    const resumeInput = query("input[type='file'][name='resume'], input[type='file']");
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

    // Lever custom cards — fill inputs inside application section by placeholder/label
    document.querySelectorAll(".application-question input, .application-question textarea").forEach((el) => {
      const label = el.closest(".application-question")?.textContent?.toLowerCase() ?? "";
      if (label.includes("linkedin") && fillText(el, profile.linkedInUrl)) filled += 1;
      if (label.includes("github") && fillText(el, profile.githubUrl)) filled += 1;
      if (label.includes("portfolio") && fillText(el, profile.portfolioUrl)) filled += 1;
      // Notice is often a listed choice; typing "0" there is rejected. Standing picks the option.
      if (label.includes("salary") && /expect|desired/.test(label) && fillText(el, profile.expectedCtc)) filled += 1;
    });

    return filled;
  }

  JR.extractors = JR.extractors || {};
  JR.extractors.lever = fillLever;
})(window.JobRadar);
