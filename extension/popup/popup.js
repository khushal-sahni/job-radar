const DEFAULT_API_BASE = "http://localhost:3001";

const apiBaseInput = document.getElementById("apiBase");
const syncBtn = document.getElementById("syncBtn");
const applyBtn = document.getElementById("applyBtn");
const fillBtn = document.getElementById("fillBtn");
const shortcutHint = document.getElementById("shortcutHint");
const settingsBtn = document.getElementById("settingsBtn");
const linkedinToggle = document.getElementById("linkedinToggle");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("profile-preview");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#f87171" : "#34d399";
}

function renderPreview(profile, prefs) {
  if (!profile?.email && !profile?.firstName) {
    previewEl.textContent = "Profile empty — fill it in Job Radar Settings.";
    return;
  }
  const yoe = prefs?.yearsOfExperience != null ? `${prefs.yearsOfExperience} yrs` : "";
  previewEl.innerHTML = `
    <strong style="color:#fafafa">${profile.firstName} ${profile.lastName}</strong><br/>
    ${profile.email}<br/>
    ${profile.phone || "No phone"}<br/>
    Resume PDF: ${profile.hasResumePdf ? profile.resumeFilename ?? "yes" : "not uploaded"}
    ${yoe ? `<br/>Experience: ${yoe}` : ""}
  `;
}

async function loadStored() {
  const stored = await chrome.storage.local.get([
    "apiBase",
    "profile",
    "profileSyncedAt",
    "prefs",
    "linkedinScanEnabled",
  ]);
  apiBaseInput.value = stored.apiBase ?? DEFAULT_API_BASE;
  linkedinToggle.checked = stored.linkedinScanEnabled === true;
  if (stored.profile) renderPreview(stored.profile, stored.prefs);
  if (stored.profileSyncedAt) {
    setStatus(`Last synced ${new Date(stored.profileSyncedAt).toLocaleString()}`);
  }

  chrome.runtime.sendMessage({ type: "DETECT_API", apiBase: apiBaseInput.value }, (response) => {
    if (response?.ok && response.apiBase) {
      apiBaseInput.value = response.apiBase;
      if (response.apiBase !== stored.apiBase) {
        setStatus(`Found Job Radar at ${response.apiBase}`);
      }
    }
  });
}

linkedinToggle.addEventListener("change", async () => {
  const enabled = linkedinToggle.checked;
  await chrome.storage.local.set({ linkedinScanEnabled: enabled });
  if (enabled) {
    chrome.runtime.sendMessage({ type: "SYNC_SCANNER_CONTEXT" }, () => undefined);
    setStatus("LinkedIn scan on — open a jobs search tab and reload it");
  } else {
    setStatus("LinkedIn scan off");
  }
});

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  setStatus("Syncing…");

  const apiBase = apiBaseInput.value.trim() || DEFAULT_API_BASE;
  await chrome.storage.local.set({ apiBase });

  chrome.runtime.sendMessage({ type: "SYNC_PROFILE", apiBase }, (response) => {
    syncBtn.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, true);
      return;
    }
    if (!response?.ok) {
      setStatus(response?.error ?? "Sync failed", true);
      return;
    }
    renderPreview(response.profile, response.prefs);
    setStatus("Profile + prefs synced");
  });
});

settingsBtn.addEventListener("click", () => {
  const apiBase = apiBaseInput.value.trim() || DEFAULT_API_BASE;
  chrome.tabs.create({ url: `${apiBase}/settings` });
});

function sendTab(type, failed) {
  applyBtn.disabled = true;
  fillBtn.disabled = true;
  setStatus("Sending this page to Job Radar…");
  chrome.runtime.sendMessage({ type }, (response) => {
    applyBtn.disabled = false;
    fillBtn.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, true);
      return;
    }
    if (!response?.ok) {
      setStatus(response?.error ?? failed, true);
      return;
    }
    setStatus(response.message, !response.started);
  });
}

applyBtn.addEventListener("click", () => sendTab("APPLY_TO_TAB", "Could not apply to this page"));
fillBtn.addEventListener("click", () => sendTab("FILL_TAB", "Could not fill this page"));

chrome.commands.getAll((commands) => {
  const shortcut = (name) => commands.find((c) => c.name === name)?.shortcut;
  const apply = shortcut("apply-to-page");
  const fill = shortcut("fill-page");
  const parts = [apply && `Apply ${apply}`, fill && `Fill ${fill}`].filter(Boolean);
  shortcutHint.textContent = parts.length
    ? `Shortcuts: ${parts.join(" · ")}. Change them at chrome://extensions/shortcuts.`
    : "Set shortcuts at chrome://extensions/shortcuts.";
});

apiBaseInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ apiBase: apiBaseInput.value.trim() || DEFAULT_API_BASE });
});

void loadStored();
