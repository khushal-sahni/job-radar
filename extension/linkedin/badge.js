(function () {
  const ns = (window.JobRadarLi = window.JobRadarLi || {});
  const BADGE_ATTR = "data-job-radar-badge";

  function chipClass(state) {
    if (state === "pass") return "jr-chip jr-chip-pass";
    if (state === "fail") return "jr-chip jr-chip-fail";
    return "jr-chip jr-chip-unk";
  }

  function summaryText(result) {
    return result.excluded
      ? "Excluded"
      : `${result.score}% · ${result.fits}/${result.total}`;
  }

  function ensureHost(cardEl) {
    let host = cardEl.querySelector(`[${BADGE_ATTR}]`);
    if (host) return host;
    const pos = window.getComputedStyle(cardEl).position;
    if (pos === "static") cardEl.style.position = "relative";
    host = document.createElement("div");
    host.setAttribute(BADGE_ATTR, "1");
    host.className = "jr-badge";
    cardEl.appendChild(host);
    return host;
  }

  function tooltipFor(result) {
    return [
      result.excludeReason,
      ...(result.reasons || []),
      result.matchedSkills?.length ? `Matched: ${result.matchedSkills.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function chipsHtml(result) {
    return (result.chips || [])
      .slice(0, 4)
      .map(
        (c) =>
          `<span class="${chipClass(c.state)}">${escapeHtml(c.label)}</span>`,
      )
      .join("");
  }

  function renderBadge(cardEl, result) {
    if (!cardEl || !result) return;
    const host = ensureHost(cardEl);
    const level = result.level || "yellow";
    const summary = summaryText(result);
    cardEl.setAttribute("data-jr-level", level);
    host.innerHTML = `
      <span class="jr-score jr-score-${level}" title="${escapeAttr(tooltipFor(result))}">${escapeHtml(summary)}</span>
      ${chipsHtml(result)}
    `;
    if (result.excluded) {
      cardEl.style.opacity = "0.72";
    } else {
      cardEl.style.opacity = "";
      cardEl.style.filter = "";
    }
  }

  function renderDetailBanner(result) {
    if (!result) return;
    const title = document.querySelector(
      ".job-details-jobs-unified-top-card h1, .jobs-unified-top-card h1, .scaffold-layout__detail h1, h1",
    );
    let bar = document.getElementById("job-radar-detail-banner");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "job-radar-detail-banner";
    }
    bar.className = `jr-banner jr-banner-${result.level || "yellow"}`;
    const summary = result.excluded
      ? `Excluded — ${result.excludeReason || "rule filter"}`
      : `Match ${result.score}% · ${result.fits}/${result.total} prefs`;
    const reasons = (result.reasons || [])
      .slice(0, 3)
      .map((r) => `<div class="jr-reason">${escapeHtml(r)}</div>`)
      .join("");
    bar.innerHTML = `
      <div class="jr-banner-row">
        <span class="jr-score jr-score-${result.level || "yellow"}">${escapeHtml(summary)}</span>
        ${chipsHtml(result)}
      </div>
      ${result.matchedSkills?.length ? `<div class="jr-skills">Skills: ${escapeHtml(result.matchedSkills.join(", "))}</div>` : ""}
      ${reasons}
    `;
    if (title?.parentElement) {
      if (bar.parentElement !== title.parentElement) {
        title.insertAdjacentElement("afterend", bar);
      }
    } else {
      renderDetailPanel(result);
    }
  }

  function renderDetailPanel(result) {
    if (!result) return;
    let panel = document.getElementById("job-radar-detail-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "job-radar-detail-panel";
      document.documentElement.appendChild(panel);
    }
    const summary = result.excluded
      ? `Excluded — ${result.excludeReason || "rule filter"}`
      : `Match ${result.score}% · ${result.fits}/${result.total} prefs`;
    const reasons = (result.reasons || [])
      .slice(0, 4)
      .map((r) => `<div class="jr-reason">${escapeHtml(r)}</div>`)
      .join("");
    panel.className = `jr-panel jr-banner-${result.level || "yellow"}`;
    panel.innerHTML = `
      <div class="jr-banner-row">
        <span class="jr-score jr-score-${result.level || "yellow"}">${escapeHtml(summary)}</span>
      </div>
      ${result.matchedSkills?.length ? `<div class="jr-skills">Skills: ${escapeHtml(result.matchedSkills.join(", "))}</div>` : ""}
      <div class="jr-banner-row">${chipsHtml(result)}</div>
      ${reasons}
      <div class="jr-brand">Job Radar</div>
    `;
  }

  function clearBadges(root) {
    const scope = root || document;
    scope.querySelectorAll(`[${BADGE_ATTR}]`).forEach((n) => n.remove());
    scope.querySelectorAll("[data-jr-level]").forEach((n) => {
      n.removeAttribute("data-jr-level");
      n.style.opacity = "";
      n.style.filter = "";
    });
    document.getElementById("job-radar-detail-panel")?.remove();
    document.getElementById("job-radar-detail-banner")?.remove();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function injectStyles() {
    if (document.getElementById("job-radar-badge-css")) return;
    const style = document.createElement("style");
    style.id = "job-radar-badge-css";
    style.textContent = `
      .jr-badge {
        position: absolute !important;
        top: 8px !important;
        right: 36px !important;
        z-index: 40 !important;
        display: flex !important;
        flex-wrap: wrap !important;
        justify-content: flex-end !important;
        gap: 4px !important;
        max-width: min(260px, calc(100% - 48px)) !important;
        pointer-events: none !important;
        font-family: -apple-system, system-ui, sans-serif !important;
        line-height: 1.2 !important;
      }
      .jr-score {
        display: inline-flex !important;
        align-items: center !important;
        padding: 3px 9px !important;
        border-radius: 999px !important;
        font-size: 12px !important;
        font-weight: 750 !important;
        letter-spacing: .01em !important;
        color: #fff !important;
        box-shadow: 0 1px 3px rgba(0,0,0,.28) !important;
        white-space: nowrap !important;
      }
      .jr-score-green { background: #047857 !important; }
      .jr-score-yellow { background: #c2410c !important; }
      .jr-score-red { background: #b91c1c !important; }
      .jr-chip {
        display: inline-flex !important;
        align-items: center !important;
        padding: 2px 7px !important;
        border-radius: 999px !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        border: 1px solid !important;
        box-shadow: 0 1px 2px rgba(0,0,0,.12) !important;
        white-space: nowrap !important;
      }
      .jr-chip-pass { color: #065f46 !important; background: #d1fae5 !important; border-color: #059669 !important; }
      .jr-chip-fail { color: #7f1d1d !important; background: #fecaca !important; border-color: #dc2626 !important; }
      .jr-chip-unk { color: #18181b !important; background: #f4f4f5 !important; border-color: #71717a !important; }
      #job-radar-detail-banner, .jr-banner {
        display: block !important;
        margin: 10px 0 12px !important;
        padding: 10px 12px !important;
        border-radius: 10px !important;
        border: 1px solid #d4d4d8 !important;
        background: #fff !important;
        font: 13px/1.4 -apple-system, system-ui, sans-serif !important;
        color: #18181b !important;
        box-shadow: 0 1px 4px rgba(0,0,0,.08) !important;
      }
      .jr-banner-green { background: #ecfdf5 !important; border-color: #059669 !important; }
      .jr-banner-yellow { background: #fff7ed !important; border-color: #c2410c !important; }
      .jr-banner-red { background: #fef2f2 !important; border-color: #b91c1c !important; }
      .jr-banner-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .jr-skills { margin-top: 6px; font-size: 12px; color: #3f3f46; }
      .jr-reason { margin-top: 3px; font-size: 12px; color: #52525b; }
      .jr-panel {
        position: fixed !important;
        top: 76px !important;
        right: 20px !important;
        z-index: 2147483001 !important;
        max-width: 320px !important;
        padding: 12px 14px !important;
        border-radius: 12px !important;
        background: #fff !important;
        color: #18181b !important;
        border: 1px solid #d4d4d8 !important;
        box-shadow: 0 8px 30px rgba(0,0,0,.18) !important;
        font: 13px/1.45 -apple-system, system-ui, sans-serif !important;
      }
      .jr-brand { margin-top: 8px; font-size: 10px; color: #71717a; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  ns.badge = {
    renderBadge,
    renderDetailBanner,
    renderDetailPanel,
    clearBadges,
    injectStyles,
    BADGE_ATTR,
  };
})();
