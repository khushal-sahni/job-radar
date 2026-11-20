(function () {
  const ns = (window.JobRadarLi = window.JobRadarLi || {});

  function norm(v) {
    return String(v || "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function detectSurface() {
    const path = location.pathname;
    if (path.startsWith("/jobs/view/")) return "detail";
    if (!path.includes("/jobs")) return null;
    if (listColumn() && detailColumn()) return "split";
    if (detailColumn()) return "split";
    return "list";
  }

  function listColumn() {
    const exact =
      document.querySelector(".scaffold-layout__list") ||
      document.querySelector(".jobs-search-results-list") ||
      document.querySelector(".jobs-search__results-list");
    if (exact) return exact;

    let best = null;
    let bestCount = 0;
    document
      .querySelectorAll("[class*='scaffold-layout__list'], [class*='jobs-search-results']")
      .forEach((el) => {
        const cls = el.className?.toString?.() || "";
        if (/item|detail/i.test(cls)) return;
        const n = uniqueJobIdsIn(el).size;
        if (n > bestCount) {
          best = el;
          bestCount = n;
        }
      });
    return bestCount >= 2 ? best : null;
  }

  function detailColumn() {
    return (
      document.querySelector(".scaffold-layout__detail") ||
      document.querySelector("[class*='scaffold-layout__detail']") ||
      document.querySelector(".jobs-search__job-details") ||
      document.querySelector("[class*='jobs-search__job-details']") ||
      document.querySelector(".jobs-search-two-pane__job-details") ||
      document.querySelector(".job-details-jobs-unified-top-card")?.closest(
        "section, aside, [class*='detail']",
      ) ||
      null
    );
  }

  function isOurUi(el) {
    return Boolean(
      el?.closest?.(
        "#job-radar-hud, #job-radar-detail-panel, #job-radar-detail-banner, [data-job-radar-badge]",
      ),
    );
  }

  function isInDetailColumn(el) {
    const col = detailColumn();
    if (col && el && col.contains(el)) return true;
    if (el?.closest?.(".job-view-layout, .jobs-details__main-content")) return true;
    return false;
  }

  function jobIdFromHref(href) {
    const raw = String(href || "");
    return (
      raw.match(/\/jobs\/view\/(?:[\w-]+-)?(\d+)/)?.[1] ||
      raw.match(/currentJobId=(\d+)/)?.[1] ||
      ""
    );
  }

  function jobIdFromEl(el) {
    if (!el || el.nodeType !== 1) return "";
    const attr =
      el.getAttribute("data-occludable-job-id") ||
      el.getAttribute("data-job-id") ||
      "";
    if (/^\d{5,}$/.test(attr)) return attr;
    const urn = el.getAttribute("data-entity-urn") || "";
    const fromUrn = urn.match(/jobPosting[:/](\d+)/)?.[1];
    if (fromUrn) return fromUrn;
    const href =
      el.getAttribute("href") ||
      el.querySelector?.('a[href*="/jobs/view/"]')?.getAttribute("href") ||
      el.querySelector?.('a[href*="currentJobId="]')?.getAttribute("href") ||
      "";
    return jobIdFromHref(href);
  }

  function addJobId(ids, value) {
    const id = String(value || "").trim();
    if (/^\d{5,}$/.test(id)) ids.add(id);
  }

  function uniqueJobIdsIn(el) {
    const ids = new Set();
    if (!el || el.nodeType !== 1) return ids;
    addJobId(ids, jobIdFromEl(el));
    el.querySelectorAll(
      "[data-occludable-job-id], [data-job-id], [data-entity-urn*='jobPosting'], a[href*='/jobs/view/'], a[href*='currentJobId=']",
    ).forEach((node) => addJobId(ids, jobIdFromEl(node)));
    return ids;
  }

  function nearestCardRoot(start) {
    const tagged = start.closest?.(
      "[data-occludable-job-id], [data-job-id], [data-entity-urn*='jobPosting']",
    );
    if (tagged && !isInDetailColumn(tagged)) return tagged;

    let node = start;
    for (let i = 0; i < 12 && node && node !== document.body; i++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body) return node;
      if (uniqueJobIdsIn(parent).size > 1) return node;
      node = parent;
    }
    return start.closest("li, article") || start;
  }

  function isJunkLine(text) {
    const t = String(text || "").toLowerCase().trim();
    if (t.length < 2) return true;
    return /^(show all|see all|apply|save|dismiss|promoted|easy apply|viewed|new|beta|see more|show more|\.{0,3}\s*more)$/.test(
      t,
    ) || /you'd be a top applicant|actively reviewing|be an early applicant|easy apply/.test(t);
  }

  function firstTitleLine(text) {
    return (
      String(text || "")
        .split("\n")
        .map((s) => s.trim())
        .find((l) => l.length > 2 && !isJunkLine(l)) || ""
    );
  }

  function parseJobCard(el) {
    if (!el) return null;
    const link =
      (el.matches?.("a[href*='/jobs/view/'], a[href*='currentJobId=']") && el) ||
      el.querySelector?.("a[href*='/jobs/view/']") ||
      el.querySelector?.("a[href*='currentJobId=']");
    const id = jobIdFromEl(el) || jobIdFromEl(link);
    const href = link?.getAttribute("href") || "";
    const lines = String(el.innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter((l) => l && !isJunkLine(l));
    if (!id && lines.length === 0) return null;

    const title =
      firstTitleLine(link?.innerText) ||
      firstTitleLine(el.querySelector?.("strong, h3, h2, a")?.innerText) ||
      lines[0] ||
      "";
    const company =
      lines.find(
        (l) =>
          l !== title &&
          !/remote|hybrid|on-?site|promoted|ago|applicant|actively|india|germany|japan|bengaluru|bangalore/i.test(
            l,
          ),
      ) || "";
    const location =
      lines.find((l) =>
        /bengaluru|bangalore|hyderabad|mumbai|delhi|gurugram|pune|india|germany|berlin|japan|tokyo|remote|hybrid|on-?site/i.test(
          l,
        ),
      ) || "";
    const blob = lines.join(" ");
    const workplaceType = /remote/i.test(blob)
      ? "Remote"
      : /hybrid/i.test(blob)
        ? "Hybrid"
        : /on-?site/i.test(blob)
          ? "On-site"
          : "";

    if (!title && !id) return null;
    return {
      id: id || `h-${title.slice(0, 40)}-${company.slice(0, 20)}`,
      title,
      company,
      location,
      workplaceType,
      snippet: lines.slice(0, 6).join(" · "),
      url: href ? new URL(href, window.location.origin).toString() : "",
      source: "card",
    };
  }

  function collectCards(scope) {
    const seen = new Set();
    const cards = [];

    function consider(el) {
      if (!el || isOurUi(el) || isInDetailColumn(el)) return;
      const card = nearestCardRoot(el);
      if (!card || isInDetailColumn(card) || isOurUi(card)) return;
      if (uniqueJobIdsIn(card).size > 1) return;
      const job = parseJobCard(card);
      if (!job || !job.title || isJunkLine(job.title)) return;
      if (seen.has(job.id)) return;
      seen.add(job.id);
      cards.push({ el: card, job });
    }

    scope
      .querySelectorAll("[data-occludable-job-id], [data-job-id]")
      .forEach(consider);
    scope.querySelectorAll("[data-entity-urn*='jobPosting']").forEach(consider);
    scope
      .querySelectorAll("a[href*='/jobs/view/'], a[href*='currentJobId=']")
      .forEach(consider);
    return cards;
  }

  function findCardElements(root) {
    const scoped = listColumn();
    const primary = collectCards(scoped || root || document);
    if (primary.length > 1) return primary;
    const fallback = collectCards(root || document);
    return fallback.length > primary.length ? fallback : primary;
  }

  function parseDetailPane() {
    const root =
      detailColumn() ||
      document.querySelector(".job-details-jobs-unified-top-card") ||
      document.querySelector(".job-view-layout") ||
      document.querySelector(".jobs-details__main-content");
    if (!root) return null;

    const title = norm(
      root.querySelector("h1")?.textContent ||
        root.querySelector("[class*='job-title']")?.textContent,
    );
    const company = norm(
      root.querySelector("[class*='company-name']")?.textContent ||
        root.querySelector("a[href*='/company/']")?.textContent,
    );
    const metaText = norm(
      root.querySelector("[class*='primary-description'], [class*='tertiary-description'], [class*='bullet']")
        ?.innerText || "",
    );
    const location = metaText.split("·")[0]?.trim() || "";

    const descRoot =
      root.querySelector("#job-details") ||
      root.querySelector(".jobs-description__content") ||
      root.querySelector(".jobs-box__html-content") ||
      root.querySelector(".jobs-description-content__text") ||
      root.querySelector("[class*='jobs-description']") ||
      root.querySelector(".show-more-less-html__markup") ||
      root.querySelector("article");
    const description = norm(descRoot?.innerText || "");
    const href = window.location.href;
    const id = jobIdFromHref(href) || jobIdFromEl(root);

    if (!title && !description) return null;
    const fullText = `${title}\n${company}\n${location}\n${description}`;
    return {
      id: id || "detail",
      title,
      company,
      location,
      workplaceType: /remote/i.test(fullText)
        ? "Remote"
        : /hybrid/i.test(fullText)
          ? "Hybrid"
          : /on-?site/i.test(fullText)
            ? "On-site"
            : "",
      description,
      snippet: description.slice(0, 400),
      url: href,
      source: "detail",
    };
  }

  function isSeeMoreLabel(text) {
    const t = norm(text).toLowerCase();
    if (!t || t.length > 48) return false;
    if (/see more jobs|more jobs|similar|show all|see all|view more jobs/.test(t)) {
      return false;
    }
    return (
      t === "more" ||
      t === "see more" ||
      t === "show more" ||
      t === "see more description" ||
      /^\.{0,3}\s*more$/.test(t) ||
      /^[.…]{1,3}\s*more$/.test(t) ||
      /click to see more/.test(t) ||
      /see more about/.test(t)
    );
  }

  function findSeeMoreControl() {
    const pane = detailColumn();
    if (!pane) return null;
    const desc =
      pane.querySelector("#job-details") ||
      pane.querySelector(".jobs-description") ||
      pane.querySelector("[class*='jobs-description']") ||
      pane.querySelector("[class*='show-more-less']") ||
      pane;

    const nodes = desc.querySelectorAll(
      "button, [role='button'], a.show-more-less-html__button, .show-more-less-html__button",
    );
    for (const el of nodes) {
      if (el.getAttribute("aria-expanded") === "true") continue;
      if (el.getAttribute("data-jr-expanded") === "1") continue;
      const cls = el.className?.toString?.() || "";
      const label = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`;
      if (
        isSeeMoreLabel(label) ||
        /show-more-less-html__button--more|see-more/i.test(cls)
      ) {
        return el;
      }
    }
    for (const el of desc.querySelectorAll("span, p")) {
      const t = norm(el.innerText);
      if (t.length < 16 && isSeeMoreLabel(t)) {
        const host = el.closest("button, [role='button'], a") || el;
        if (host.getAttribute("aria-expanded") === "true") continue;
        if (host.getAttribute("data-jr-expanded") === "1") continue;
        return host;
      }
    }
    return null;
  }

  async function naturalExpand(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight;
    if (visible === false) {
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      await sleep(280 + Math.random() * 180);
    }
    el.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }),
    );
    await sleep(90 + Math.random() * 160);
    el.click();
    el.setAttribute("data-jr-expanded", "1");
    return true;
  }

  function findDetailBadgeTarget() {
    return (
      document.querySelector(".job-details-jobs-unified-top-card") ||
      document.querySelector(".jobs-unified-top-card") ||
      document.querySelector("h1")?.parentElement ||
      null
    );
  }

  ns.parser = {
    detectSurface,
    listColumn,
    detailColumn,
    parseJobCard,
    findCardElements,
    parseDetailPane,
    jobIdFromEl,
    jobIdFromHref,
    findSeeMoreControl,
    naturalExpand,
    findDetailBadgeTarget,
  };
})();
