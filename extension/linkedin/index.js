(function () {
  const ns = (window.JobRadarLi = window.JobRadarLi || {});
  if (window !== window.top) return;
  if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return;
  if (!location.pathname.includes("/jobs")) return;

  const scored = new Map();
  const expandedIds = new Set();
  let ctx = null;
  let runner = null;
  let mo = null;
  let enabled = false;
  let lastUrl = location.href;
  let clickBound = false;
  let clickTimer = 0;
  let expandTimer = 0;
  let expandInFlight = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setHud(text, kind) {
    let el = document.getElementById("job-radar-hud");
    if (!el) {
      el = document.createElement("div");
      el.id = "job-radar-hud";
      el.style.cssText = `
        position: fixed; bottom: 16px; right: 16px; z-index: 2147483646;
        max-width: 280px; padding: 10px 12px; border-radius: 10px;
        font: 12px/1.4 system-ui, sans-serif; color: #ecfdf5;
        background: #064e3b; border: 1px solid #34d399;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
      `;
      (document.body || document.documentElement).appendChild(el);
    }
    if (kind === "off") {
      el.style.background = "#27272a";
      el.style.borderColor = "#71717a";
      el.style.color = "#fafafa";
    } else if (kind === "warn") {
      el.style.background = "#713f12";
      el.style.borderColor = "#fbbf24";
      el.style.color = "#fef3c7";
    } else {
      el.style.background = "#064e3b";
      el.style.borderColor = "#34d399";
      el.style.color = "#ecfdf5";
    }
    el.textContent = text;
  }

  function send(type) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error ?? "Request failed"));
          return;
        }
        resolve(response);
      });
    });
  }

  async function loadContext() {
    const stored = await chrome.storage.local.get([
      "prefs",
      "rules",
      "resumeSkills",
      "linkedinScanEnabled",
    ]);
    enabled = stored.linkedinScanEnabled === true;
    ctx = {
      prefs: stored.prefs || {
        yearsOfExperience: 4,
        excludeTitleKeywords: ["staff"],
        avoidIfExclusiveLanguages: ["java"],
      },
      rules: stored.rules || [],
      skills: stored.resumeSkills || [],
    };
    if (!stored.prefs) {
      try {
        const res = await send("SYNC_SCANNER_CONTEXT");
        ctx = {
          prefs: res.prefs,
          rules: res.rules || [],
          skills: res.resumeSkills || [],
        };
      } catch {
        // defaults still score
      }
    }
  }

  function scoreAndPaint(el, job) {
    const result = ns.scorer.scoreJob(job, ctx);
    scored.set(job.id, { job, result, hasDetail: job.source === "detail" });
    if (el) ns.badge.renderBadge(el, result);
    return result;
  }

  function attachExisting(el, job) {
    const prev = scored.get(job.id);
    if (!prev) return false;
    ns.badge.renderBadge(el, prev.result);
    return true;
  }

  async function onVisible({ el }) {
    if (!enabled) return;
    const job = ns.parser.parseJobCard(el);
    if (!job) return;
    if (attachExisting(el, job)) return;
    scoreAndPaint(el, job);
  }

  function applyDetailResult(detail, result) {
    ns.badge.renderDetailBanner(result);
    const cards = ns.parser.findCardElements(document);
    const target =
      cards.find((c) => c.job.id === detail.id) ||
      cards.find(
        (c) =>
          c.job.title &&
          detail.title &&
          c.job.title.toLowerCase() === detail.title.toLowerCase(),
      );
    if (target?.el) ns.badge.renderBadge(target.el, result);
  }

  function upgradeFromDetailPane() {
    if (!enabled) return;
    const detail = ns.parser.parseDetailPane();
    if (!detail?.title && !detail?.description) return;
    const result = ns.scorer.scoreJob(detail, ctx);
    scored.set(detail.id, { job: detail, result, hasDetail: true });
    applyDetailResult(detail, result);
    setHud(
      `Job Radar: ${scored.size} scored · ${ns.parser.findCardElements(document).length} cards · detail ${result.score}%`,
      "on",
    );
  }

  function scheduleExpandAndUpgrade() {
    if (!enabled) return;
    clearTimeout(expandTimer);
    expandTimer = setTimeout(() => {
      void expandThenUpgrade();
    }, 850 + Math.floor(Math.random() * 650));
  }

  async function expandThenUpgrade() {
    if (!enabled || expandInFlight) return;
    const detail = ns.parser.parseDetailPane();
    const jobId = detail?.id || ns.parser.jobIdFromHref(location.href);
    if (jobId && expandedIds.has(jobId)) {
      upgradeFromDetailPane();
      return;
    }

    const btn = ns.parser.findSeeMoreControl();
    if (btn) {
      expandInFlight = true;
      try {
        await ns.parser.naturalExpand(btn);
        if (jobId) expandedIds.add(jobId);
        await sleep(420 + Math.random() * 380);
      } catch {
        // still score whatever is visible
      } finally {
        expandInFlight = false;
      }
    } else if (jobId) {
      expandedIds.add(jobId);
    }
    upgradeFromDetailPane();
  }

  function paintVisibleNow() {
    ns.badge.injectStyles();
    const surface = ns.parser.detectSurface();
    if (surface === "detail") {
      scheduleExpandAndUpgrade();
      return [];
    }

    const cards = ns.parser.findCardElements(document);
    if (!enabled) {
      setHud(
        "Job Radar: scan is OFF. Click the puzzle-piece extension icon → enable “Scan LinkedIn jobs”.",
        "off",
      );
      return cards;
    }
    if (cards.length === 0) {
      setHud(
        "Job Radar is on but found 0 job cards. Scroll the list or reload this tab.",
        "warn",
      );
      scheduleExpandAndUpgrade();
      return cards;
    }

    let pendingCount = 0;
    for (const { el, job } of cards) {
      if (attachExisting(el, job)) continue;
      if (pendingCount < 5) {
        scoreAndPaint(el, job);
        pendingCount += 1;
      }
    }
    setHud(`Job Radar: ${scored.size} scored · ${cards.length} cards on page`, "on");
    return cards;
  }

  function bindClicks() {
    if (clickBound) return;
    clickBound = true;
    document.addEventListener(
      "click",
      (event) => {
        if (event.target?.closest?.("#job-radar-hud, #job-radar-detail-banner, [data-job-radar-badge]")) {
          return;
        }
        clearTimeout(clickTimer);
        clickTimer = setTimeout(scheduleExpandAndUpgrade, 500);
      },
      true,
    );
  }

  function start() {
    ns.badge.injectStyles();
    const surface = ns.parser.detectSurface();

    if (surface === "detail") {
      scheduleExpandAndUpgrade();
      [1200, 2400].forEach((ms) => setTimeout(scheduleExpandAndUpgrade, ms));
      mo?.disconnect();
      let debounce;
      mo = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            scheduleExpandAndUpgrade();
          }
        }, 300);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      bindClicks();
      return;
    }

    if (runner) {
      runner.observeRoot();
    } else {
      runner = ns.observer.createObserver({ onVisible });
      runner.start();
    }
    paintVisibleNow();
    [400, 1200, 2600].forEach((ms) => setTimeout(paintVisibleNow, ms));
    scheduleExpandAndUpgrade();

    mo?.disconnect();
    let debounce;
    mo = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (nodes.length === 0) return m.type === "childList";
        return nodes.some((n) => {
          if (n.nodeType !== 1) return true;
          const el = n;
          return !(
            el.id === "job-radar-hud" ||
            el.id === "job-radar-badge-css" ||
            el.id === "job-radar-detail-banner" ||
            el.id === "job-radar-detail-panel" ||
            el.getAttribute?.("data-job-radar-badge") ||
            el.closest?.(
              "#job-radar-hud, #job-radar-detail-banner, [data-job-radar-badge]",
            )
          );
        });
      });
      if (!relevant) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          scheduleExpandAndUpgrade();
        }
        runner?.observeRoot();
        paintVisibleNow();
      }, 280);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    bindClicks();
  }

  function stop() {
    runner?.stop();
    runner = null;
    mo?.disconnect();
    mo = null;
    clearTimeout(expandTimer);
    ns.badge.clearBadges();
    scored.clear();
    setHud(
      "Job Radar: scan is OFF. Click the puzzle-piece extension icon → enable “Scan LinkedIn jobs”.",
      "off",
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.linkedinScanEnabled) {
      enabled = changes.linkedinScanEnabled.newValue === true;
      if (enabled) {
        void loadContext().then(start);
      } else {
        stop();
      }
    }
    if (changes.prefs || changes.rules || changes.resumeSkills) {
      ctx = {
        prefs: changes.prefs?.newValue || ctx?.prefs,
        rules: changes.rules?.newValue || ctx?.rules,
        skills: changes.resumeSkills?.newValue || ctx?.skills,
      };
      if (enabled) paintVisibleNow();
    }
  });

  void loadContext().then(() => {
    if (enabled) start();
    else {
      setHud(
        "Job Radar: scan is OFF. Click the puzzle-piece extension icon → enable “Scan LinkedIn jobs”.",
        "off",
      );
    }
  });
})();
