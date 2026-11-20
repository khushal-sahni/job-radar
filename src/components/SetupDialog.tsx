"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_PROFILE,
  type ProfileFormData,
} from "@/components/ProfileEditor";
import { RulesEditor } from "@/components/RulesEditor";
import {
  ScheduleEditor,
  type ScheduleFormData,
} from "@/components/ScheduleEditor";
import { formToRules, rulesToForm, type RuleBranchForm } from "@/lib/rules-form";
import { DEFAULT_RULES } from "@/lib/types";

type WizardStep =
  | "boot"
  | "database"
  | "chrome"
  | "openrouter"
  | "profile"
  | "rules"
  | "schedule"
  | "done";

interface SetupStatusPayload {
  configured?: boolean;
  database?: { status: string; message: string; log?: string };
  chrome?: { status: string; message: string; downloadUrl: string };
  openRouter?: { hasKey: boolean; message: string };
  profile?: { hasEmail: boolean };
  error?: string;
}

const DEFAULT_SCHEDULE: ScheduleFormData = {
  findScheduleEnabled: false,
  applyScheduleEnabled: false,
  scheduleHour: 8,
  dailyApplyCap: 15,
  naukriEnabled: false,
};

export function SetupDialog() {
  const [step, setStep] = useState<WizardStep>("boot");
  const [statusMessage, setStatusMessage] = useState("Starting…");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [profile, setProfile] = useState<ProfileFormData>(EMPTY_PROFILE);
  const [yearsOfExperience, setYearsOfExperience] = useState(4);
  const [excludeKeywordsText, setExcludeKeywordsText] = useState("staff");
  const [avoidLanguagesText, setAvoidLanguagesText] = useState("java");
  const [branches, setBranches] = useState<RuleBranchForm[]>(() =>
    rulesToForm(DEFAULT_RULES),
  );
  const [schedule, setSchedule] = useState<ScheduleFormData>(DEFAULT_SCHEDULE);
  const [chromeUrl, setChromeUrl] = useState("https://www.google.com/chrome/");
  const started = useRef(false);

  const loadStatus = useCallback(async (): Promise<SetupStatusPayload | null> => {
    const res = await fetch("/api/setup/status");
    const data = (await res.json()) as SetupStatusPayload;
    if (!res.ok) throw new Error(data.error ?? "Could not load setup status");
    return data;
  }, []);

  const runDatabase = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDetails(null);
    setStatusMessage("Saving your jobs on this computer…");
    try {
      const res = await fetch("/api/setup/database", { method: "POST" });
      const data = (await res.json()) as {
        status?: string;
        message?: string;
        log?: string;
        error?: string;
      };
      if (!res.ok || data.status !== "done") {
        setError(data.message ?? data.error ?? "Database setup failed");
        setDetails(data.log ?? null);
        setStep("database");
        return false;
      }
      setStatusMessage(data.message ?? "Database ready");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Database setup failed");
      setStep("database");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        const status = await loadStatus();
        if (!status) return;
        if (status.configured) {
          window.location.href = "/feed";
          return;
        }

        setStep("database");
        const dbOk = await runDatabase();
        if (!dbOk) return;

        const afterDb = await loadStatus();
        if (afterDb?.chrome?.downloadUrl) setChromeUrl(afterDb.chrome.downloadUrl);
        if (afterDb?.chrome?.status === "needs_action") {
          setStatusMessage(afterDb.chrome.message);
          setStep("chrome");
          return;
        }

        if (afterDb?.openRouter?.hasKey) {
          setStep("profile");
        } else {
          setStep("openrouter");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Setup failed");
        setStep("database");
      }
    })();
  }, [loadStatus, runDatabase]);

  async function continueAfterChrome() {
    setBusy(true);
    setError(null);
    try {
      const status = await loadStatus();
      if (status?.chrome?.status === "needs_action" && !status.chrome.message.includes("bundled")) {
        setError(status.chrome.message);
        return;
      }
      setStep(status?.openRouter?.hasKey ? "profile" : "openrouter");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue");
    } finally {
      setBusy(false);
    }
  }

  async function saveOpenRouter() {
    setBusy(true);
    setError(null);
    setStatusMessage("Checking your OpenRouter key…");
    try {
      const res = await fetch("/api/setup/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error ?? "Key check failed");
      setStatusMessage(data.message ?? "Key saved");
      setStep("profile");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Key check failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfileStep() {
    setBusy(true);
    setError(null);
    try {
      if (!profile.email.trim() || !profile.firstName.trim()) {
        throw new Error("First name and email are required.");
      }
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save profile");

      const [rulesRes, prefsRes] = await Promise.all([
        fetch("/api/rules").then((r) => r.json()) as Promise<{ rules?: typeof DEFAULT_RULES }>,
        fetch("/api/preferences").then((r) => r.json()) as Promise<{
          yearsOfExperience?: number;
          excludeTitleKeywords?: string[];
          avoidIfExclusiveLanguages?: string[];
          findScheduleEnabled?: boolean;
          applyScheduleEnabled?: boolean;
          scheduleHour?: number;
          dailyApplyCap?: number;
          naukriEnabled?: boolean;
        }>,
      ]);
      if (rulesRes.rules?.length) setBranches(rulesToForm(rulesRes.rules));
      if (prefsRes.yearsOfExperience != null) setYearsOfExperience(prefsRes.yearsOfExperience);
      if (prefsRes.excludeTitleKeywords) {
        setExcludeKeywordsText(prefsRes.excludeTitleKeywords.join(", "));
      }
      if (prefsRes.avoidIfExclusiveLanguages) {
        setAvoidLanguagesText(prefsRes.avoidIfExclusiveLanguages.join(", "));
      }
      setSchedule({
        findScheduleEnabled: prefsRes.findScheduleEnabled ?? false,
        applyScheduleEnabled: prefsRes.applyScheduleEnabled ?? false,
        scheduleHour: prefsRes.scheduleHour ?? 8,
        dailyApplyCap: prefsRes.dailyApplyCap ?? 15,
        naukriEnabled: prefsRes.naukriEnabled ?? false,
      });
      setStep("rules");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile");
    } finally {
      setBusy(false);
    }
  }

  async function uploadResume(file: File) {
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/resume", { method: "POST", body: formData });
      const data = (await res.json()) as { error?: string; filename?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setProfile((prev) => ({
        ...prev,
        resumeFilename: data.filename ?? file.name,
        hasResumePdf: true,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveRulesStep() {
    setBusy(true);
    setError(null);
    try {
      const rules = formToRules(branches);
      if (rules.length === 0) {
        throw new Error("Turn on at least one job branch.");
      }
      const excludeTitleKeywords = excludeKeywordsText
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const avoidIfExclusiveLanguages = avoidLanguagesText
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const [rulesRes, prefsRes] = await Promise.all([
        fetch("/api/rules", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules }),
        }),
        fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            yearsOfExperience,
            excludeTitleKeywords,
            avoidIfExclusiveLanguages,
          }),
        }),
      ]);
      const rulesData = (await rulesRes.json()) as { error?: string };
      const prefsData = (await prefsRes.json()) as { error?: string };
      if (!rulesRes.ok) throw new Error(rulesData.error ?? "Could not save rules");
      if (!prefsRes.ok) throw new Error(prefsData.error ?? "Could not save preferences");
      setStep("schedule");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save preferences");
    } finally {
      setBusy(false);
    }
  }

  async function saveScheduleStep() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save schedule");
      setStep("done");
      window.location.href = "/feed";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save schedule");
    } finally {
      setBusy(false);
    }
  }

  function updateProfile(field: keyof ProfileFormData, value: string) {
    setProfile((prev) => ({ ...prev, [field]: value }));
  }

  const checklist = [
    { id: "database", label: "Saving jobs on this computer", active: step === "database" || step === "boot" },
    { id: "chrome", label: "Finding Google Chrome", active: step === "chrome" },
    { id: "openrouter", label: "OpenRouter key", active: step === "openrouter" },
    { id: "profile", label: "Your profile", active: step === "profile" },
    { id: "rules", label: "Job preferences", active: step === "rules" },
    { id: "schedule", label: "Daily schedule", active: step === "schedule" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
        <header>
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-400">
            Job Radar
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Welcome</h1>
          <p className="mt-2 text-sm text-zinc-400">
            A few steps on this computer. Technical setup runs in the background.
          </p>
        </header>

        <ol className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
          {checklist.map((item) => (
            <li
              key={item.id}
              className={
                item.active ? "font-medium text-emerald-400" : "text-zinc-500"
              }
            >
              {item.label}
            </li>
          ))}
        </ol>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          {(step === "boot" || step === "database") && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-300">{statusMessage}</p>
              {busy && (
                <p className="text-sm text-zinc-500">Working…</p>
              )}
              {error && (
                <div className="space-y-3">
                  <p className="text-sm text-red-400">{error}</p>
                  {details && (
                    <details className="text-xs text-zinc-500">
                      <summary className="cursor-pointer">Details</summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3">
                        {details}
                      </pre>
                    </details>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runDatabase()}
                    className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}

          {step === "chrome" && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-300">{statusMessage}</p>
              <a
                href={chromeUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-100 hover:border-zinc-400"
              >
                Download Google Chrome
              </a>
              <button
                type="button"
                disabled={busy}
                onClick={() => void continueAfterChrome()}
                className="block min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                Continue
              </button>
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          )}

          {step === "openrouter" && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-300">
                Job Radar uses OpenRouter to read job posts and fill forms. Create a
                free key at{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 underline"
                >
                  openrouter.ai/keys
                </a>
                .
              </p>
              <label className="block text-sm text-zinc-300">
                OpenRouter API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
                />
              </label>
              <button
                type="button"
                disabled={busy || !apiKey.trim()}
                onClick={() => void saveOpenRouter()}
                className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? "Checking…" : "Save and continue"}
              </button>
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          )}

          {step === "profile" && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400">
                Used to fill applications. Upload a PDF resume if you have one.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["firstName", "First name"],
                    ["lastName", "Last name"],
                    ["email", "Email"],
                    ["phone", "Phone"],
                    ["location", "Location"],
                    ["linkedInUrl", "LinkedIn URL"],
                    ["expectedCtc", "Expected salary"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="block text-sm text-zinc-300">
                    {label}
                    <input
                      type={key === "email" ? "email" : "text"}
                      value={String(profile[key] ?? "")}
                      onChange={(e) => updateProfile(key, e.target.value)}
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
                    />
                  </label>
                ))}
              </div>
              <label className="block text-sm text-zinc-300">
                Resume PDF
                <input
                  type="file"
                  accept=".pdf"
                  className="mt-2 block w-full text-sm text-zinc-400"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadResume(file);
                  }}
                />
              </label>
              {profile.hasResumePdf && profile.resumeFilename && (
                <p className="text-sm text-emerald-400">
                  PDF: {profile.resumeFilename}
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveProfileStep()}
                className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Continue"}
              </button>
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          )}

          {step === "rules" && (
            <div className="space-y-6">
              <label className="block text-sm text-zinc-300">
                Years of experience
                <input
                  type="number"
                  min={0}
                  max={40}
                  value={yearsOfExperience}
                  onChange={(e) => setYearsOfExperience(Number(e.target.value))}
                  className="mt-2 w-32 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
                />
              </label>
              <label className="block text-sm text-zinc-300">
                Words to skip in job posts
                <input
                  type="text"
                  value={excludeKeywordsText}
                  onChange={(e) => setExcludeKeywordsText(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
                />
              </label>
              <label className="block text-sm text-zinc-300">
                Languages to avoid when they are the only stack
                <input
                  type="text"
                  value={avoidLanguagesText}
                  onChange={(e) => setAvoidLanguagesText(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
                />
              </label>
              <RulesEditor branches={branches} onChange={setBranches} />
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveRulesStep()}
                className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Continue"}
              </button>
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          )}

          {step === "schedule" && (
            <div className="space-y-4">
              <ScheduleEditor value={schedule} onChange={setSchedule} />
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveScheduleStep()}
                className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? "Finishing…" : "Finish"}
              </button>
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
