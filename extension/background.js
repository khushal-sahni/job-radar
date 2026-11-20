const DEFAULT_API_BASE = "http://localhost:3001";
const FALLBACK_PORTS = [3001, 3000, 3002];

const BADGE_CLEAR_MS = 8000;

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "apply-to-page" && command !== "fill-page") return;
  void applyToTab(tab, { fill: command === "fill-page" }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message.type === "GET_PROFILE") {
    fetchProfile(message.apiBase)
      .then((profile) => sendResponse({ ok: true, profile }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_PREFS") {
    fetchPrefs(message.apiBase)
      .then((prefs) => sendResponse({ ok: true, prefs }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_RULES") {
    fetchRules(message.apiBase)
      .then((rules) => sendResponse({ ok: true, rules }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "SYNC_PROFILE") {
    syncProfileToStorage(message.apiBase)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "SYNC_SCANNER_CONTEXT") {
    syncScannerContext(message.apiBase)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "DETECT_API") {
    resolveApiBase(message.apiBase)
      .then((apiBase) => sendResponse({ ok: true, apiBase }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "APPLY_TO_TAB" || message.type === "FILL_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      applyToTab(tabs[0], { fill: message.type === "FILL_TAB" })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }
});

function showBadge(tabId, text, color, title) {
  if (tabId == null) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setTitle({ tabId, title: `Job Radar: ${title}` });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setTitle({ tabId, title: "Job Radar" });
  }, BADGE_CLEAR_MS);
}

/**
 * Sends the tab's URL to Job Radar, which applies in its own Chrome with the same runner as
 * Apply now. With `fill` it fills the form there and leaves it open without submitting.
 * Nothing is typed into this tab.
 */
async function applyToTab(tab, { fill = false } = {}) {
  const tabId = tab?.id;
  const url = tab?.url;
  try {
    if (!url || !/^https?:/.test(url)) throw new Error("This tab is not a job page");
    showBadge(tabId, "…", "#52525b", "sending");
    const apiBase = await resolveApiBase();
    const res = await fetch(`${apiBase}/api/apply/from-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, fill }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Job Radar API error (${res.status})`);
    if (data.started) {
      const company = data.company ?? "this job";
      const message = fill
        ? `Filling ${company} in the Job Radar Chrome; it will not be submitted`
        : `Applying to ${company} in the Job Radar Chrome`;
      showBadge(tabId, "GO", "#10b981", message);
      return { started: true, message };
    }
    const message = data.reason ?? "Not started";
    showBadge(tabId, data.queued ? "Q" : "!", data.queued ? "#0ea5e9" : "#f59e0b", message);
    return { started: false, message };
  } catch (err) {
    showBadge(tabId, "!", "#ef4444", err.message);
    throw err;
  }
}

async function getStoredApiBase() {
  const stored = await chrome.storage.local.get(["apiBase"]);
  return stored.apiBase ?? DEFAULT_API_BASE;
}

async function checkHealth(apiBase) {
  const res = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return false;
  const data = await res.json();
  return data?.app === "job-radar";
}

async function resolveApiBase(preferred) {
  const stored = preferred ?? (await getStoredApiBase());
  const candidates = [
    stored,
    DEFAULT_API_BASE,
    ...FALLBACK_PORTS.map((port) => `http://localhost:${port}`),
  ];

  const seen = new Set();
  for (const base of candidates) {
    const normalized = base.replace(/\/$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    try {
      if (await checkHealth(normalized)) {
        await chrome.storage.local.set({ apiBase: normalized });
        return normalized;
      }
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `Job Radar not found. Start it with "npm run dev" and set the API URL in the extension popup (tried ${[...seen].join(", ")}). Port 3000 may be used by another app.`,
  );
}

async function fetchJson(apiBase, path) {
  const res = await fetch(`${apiBase}${path}`);
  if (!res.ok) {
    throw new Error(`Job Radar API error (${res.status}) at ${apiBase}${path}`);
  }
  return res.json();
}

async function fetchPrefs(preferredBase) {
  const apiBase = await resolveApiBase(preferredBase);
  const prefs = await fetchJson(apiBase, "/api/preferences");
  await chrome.storage.local.set({ prefs, prefsSyncedAt: Date.now(), apiBase });
  return prefs;
}

async function fetchRules(preferredBase) {
  const apiBase = await resolveApiBase(preferredBase);
  const data = await fetchJson(apiBase, "/api/rules");
  const rules = data.rules ?? [];
  await chrome.storage.local.set({ rules, rulesSyncedAt: Date.now(), apiBase });
  return rules;
}

async function fetchResumeSkills(preferredBase) {
  const apiBase = await resolveApiBase(preferredBase);
  const data = await fetchJson(apiBase, "/api/resume");
  const resumeSkills = data.resume?.skills ?? [];
  await chrome.storage.local.set({
    resumeSkills,
    resumeRoles: data.resume?.roles ?? [],
    resumeSeniority: data.resume?.seniority ?? null,
  });
  return resumeSkills;
}

async function syncScannerContext(preferredBase) {
  const prefs = await fetchPrefs(preferredBase);
  const rules = await fetchRules(preferredBase);
  const resumeSkills = await fetchResumeSkills(preferredBase);
  const stored = await chrome.storage.local.get(["apiBase"]);
  return {
    prefs,
    rules,
    resumeSkills,
    apiBase: stored.apiBase ?? DEFAULT_API_BASE,
  };
}

async function fetchProfile(preferredBase) {
  const apiBase = await resolveApiBase(preferredBase);
  const res = await fetch(`${apiBase}/api/profile?includeResume=true`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `Job Radar API not found at ${apiBase}. Another app may be on this port — try http://localhost:3001 in the extension popup.`,
      );
    }
    throw new Error(`Job Radar API error (${res.status}) at ${apiBase}`);
  }
  const profile = await res.json();
  await chrome.storage.local.set({ profile, profileSyncedAt: Date.now(), apiBase });
  return profile;
}

async function syncProfileToStorage(preferredBase) {
  const profile = await fetchProfile(preferredBase);
  let scanner = {};
  try {
    scanner = await syncScannerContext(preferredBase);
  } catch {
    // profile sync still succeeds if prefs/rules are down
  }
  const stored = await chrome.storage.local.get(["apiBase"]);
  return {
    profile,
    apiBase: stored.apiBase ?? DEFAULT_API_BASE,
    ...scanner,
  };
}
