window.JobRadar = window.JobRadar || {};

(function (JR) {
  function isGreenhouseEmbed() {
    if (/[?&]gh_jid=/.test(location.search)) return true;
    if (document.getElementById("application_form") || document.getElementById("first_name")) {
      return true;
    }
    if (document.querySelector('iframe[src*="greenhouse.io"]')) return true;
    if (document.querySelector('a[href*="greenhouse.io"], a[href*="gh_jid="]')) {
      return true;
    }
    if (document.querySelector('[class*="greenhouse"], [id*="greenhouse"]')) {
      return true;
    }
    return false;
  }

  function detectPlatform() {
    const host = location.hostname;
    if (host.includes("greenhouse.io") || isGreenhouseEmbed()) return "greenhouse";
    if (host.includes("lever.co")) return "lever";
    if (host.includes("workable.com")) return "workable";
    if (host.includes("ashbyhq.com")) return "ashby";
    return "generic";
  }

  function hasGreenhouseForm() {
    return Boolean(
      document.querySelector("#application_form, form[action*='applications']") ||
        document.getElementById("first_name") ||
        document.querySelector("input[name='job_application[first_name]']") ||
        document.querySelector("input[type='file']"),
    );
  }

  function hasApplicationForm() {
    const platform = detectPlatform();
    if (platform === "greenhouse") {
      return hasGreenhouseForm();
    }
    if (platform === "lever") {
      return Boolean(document.querySelector(".application-form, form.postings-form"));
    }
    if (platform === "workable") {
      return Boolean(document.querySelector("[data-ui='application-form'], form"));
    }
    if (platform === "ashby") {
      return Boolean(document.querySelector("form, [class*='Application']"));
    }
    return Boolean(
      document.querySelector("form input[type='email'], form input[name*='email']"),
    );
  }

  JR.detect = { detectPlatform, hasApplicationForm, isGreenhouseEmbed };
})(window.JobRadar);
