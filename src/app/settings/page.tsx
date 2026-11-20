"use client";

import { useEffect, useState } from "react";
import {
  EMPTY_PROFILE,
  ProfileEditor,
  type ProfileFormData,
} from "@/components/ProfileEditor";
import { FactsEditor } from "@/components/FactsEditor";
import { RulesEditor } from "@/components/RulesEditor";
import {
  ScheduleEditor,
  type ScheduleFormData,
} from "@/components/ScheduleEditor";
import { formToRules, rulesToForm, type RuleBranchForm } from "@/lib/rules-form";
import { DEFAULT_RULES } from "@/lib/types";

export default function SettingsPage() {
  const [branches, setBranches] = useState<RuleBranchForm[]>(() =>
    rulesToForm(DEFAULT_RULES),
  );
  const [yearsOfExperience, setYearsOfExperience] = useState(4);
  const [excludeKeywordsText, setExcludeKeywordsText] = useState("staff");
  const [avoidLanguagesText, setAvoidLanguagesText] = useState("java");
  const [schedule, setSchedule] = useState<ScheduleFormData>({
    findScheduleEnabled: false,
    applyScheduleEnabled: false,
    scheduleHour: 8,
    dailyApplyCap: 15,
    naukriEnabled: false,
  });
  const [profile, setProfile] = useState<ProfileFormData>(EMPTY_PROFILE);
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState(false);
  const [gmailUser, setGmailUser] = useState("");
  const [gmailAppPassword, setGmailAppPassword] = useState("");
  const [hasGmailAppPassword, setHasGmailAppPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch("/api/rules").then((r) => r.json()),
      fetch("/api/preferences").then((r) => r.json()),
      fetch("/api/profile").then((r) => r.json()),
      fetch("/api/secrets").then((r) => r.json()),
    ])
      .then(([rulesData, prefsData, profileData, secretsData]: [
        { rules?: typeof DEFAULT_RULES },
        {
          yearsOfExperience?: number;
          excludeTitleKeywords?: string[];
          avoidIfExclusiveLanguages?: string[];
          findScheduleEnabled?: boolean;
          applyScheduleEnabled?: boolean;
          scheduleHour?: number;
          dailyApplyCap?: number;
          naukriEnabled?: boolean;
        },
        ProfileFormData,
        {
          hasOpenRouterKey?: boolean;
          gmailUser?: string;
          hasGmailAppPassword?: boolean;
        },
      ]) => {
        if (rulesData.rules?.length) setBranches(rulesToForm(rulesData.rules));
        if (prefsData.yearsOfExperience != null) {
          setYearsOfExperience(prefsData.yearsOfExperience);
        }
        if (prefsData.excludeTitleKeywords != null) {
          setExcludeKeywordsText(prefsData.excludeTitleKeywords.join(", "));
        }
        if (prefsData.avoidIfExclusiveLanguages != null) {
          setAvoidLanguagesText(prefsData.avoidIfExclusiveLanguages.join(", "));
        }
        setSchedule({
          findScheduleEnabled: prefsData.findScheduleEnabled ?? false,
          applyScheduleEnabled: prefsData.applyScheduleEnabled ?? false,
          scheduleHour: prefsData.scheduleHour ?? 8,
          dailyApplyCap: prefsData.dailyApplyCap ?? 15,
          naukriEnabled: prefsData.naukriEnabled ?? false,
        });
        if (profileData.email !== undefined) {
          setProfile(profileData);
        }
        setHasOpenRouterKey(Boolean(secretsData.hasOpenRouterKey));
        setGmailUser(secretsData.gmailUser ?? "");
        setHasGmailAppPassword(Boolean(secretsData.hasGmailAppPassword));
      })
      .catch(() => undefined);
  }, []);

  async function saveRules() {
    setSaving(true);
    setMessage(null);
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
            ...schedule,
          }),
        }),
      ]);

      const rulesData = (await rulesRes.json()) as { error?: string };
      const prefsData = (await prefsRes.json()) as {
        error?: string;
        excludeTitleKeywords?: string[];
        avoidIfExclusiveLanguages?: string[];
      };

      if (!rulesRes.ok) throw new Error(rulesData.error ?? "Save rules failed");
      if (!prefsRes.ok) {
        throw new Error(prefsData.error ?? "Save preferences failed");
      }

      if (prefsData.excludeTitleKeywords) {
        setExcludeKeywordsText(prefsData.excludeTitleKeywords.join(", "));
      }
      if (prefsData.avoidIfExclusiveLanguages) {
        setAvoidLanguagesText(prefsData.avoidIfExclusiveLanguages.join(", "));
      }

      setMessage("Preferences saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveSecrets() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openRouterApiKey: openRouterKey.trim() || undefined,
          gmailUser,
          gmailAppPassword: gmailAppPassword.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        hasOpenRouterKey?: boolean;
        gmailUser?: string;
        hasGmailAppPassword?: boolean;
      };
      if (!res.ok) throw new Error(data.error ?? "Could not save secrets");
      setHasOpenRouterKey(Boolean(data.hasOpenRouterKey));
      setGmailUser(data.gmailUser ?? "");
      setHasGmailAppPassword(Boolean(data.hasGmailAppPassword));
      setOpenRouterKey("");
      setGmailAppPassword("");
      setMessage("Keys saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-400">
              Job Radar
            </p>
            <h1 className="mt-1 text-2xl font-semibold">Preferences</h1>
          </div>
          <a
            href="/feed"
            className="min-h-11 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500"
          >
            Back to feed
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <ProfileEditor
          initial={profile}
          onSaved={() => {
            void fetch("/api/profile")
              .then((r) => r.json())
              .then((data: ProfileFormData) => setProfile(data))
              .catch(() => undefined);
          }}
        />

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="font-medium text-zinc-100">Keys</h2>
          <p className="mt-2 text-sm text-zinc-400">
            OpenRouter is required. Gmail is optional and only used for emailed
            security codes and career-site account mail.
          </p>
          <label className="mt-4 block text-sm text-zinc-300">
            OpenRouter API key
            {hasOpenRouterKey && (
              <span className="ml-2 text-xs text-emerald-400">saved</span>
            )}
            <input
              type="password"
              value={openRouterKey}
              onChange={(e) => setOpenRouterKey(e.target.value)}
              placeholder={hasOpenRouterKey ? "Leave blank to keep current key" : ""}
              autoComplete="off"
              className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
          <label className="mt-4 block text-sm text-zinc-300">
            Gmail address
            <input
              type="email"
              value={gmailUser}
              onChange={(e) => setGmailUser(e.target.value)}
              className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
          <label className="mt-4 block text-sm text-zinc-300">
            Gmail app password
            {hasGmailAppPassword && (
              <span className="ml-2 text-xs text-emerald-400">saved</span>
            )}
            <input
              type="password"
              value={gmailAppPassword}
              onChange={(e) => setGmailAppPassword(e.target.value)}
              placeholder={
                hasGmailAppPassword ? "Leave blank to keep current password" : ""
              }
              autoComplete="off"
              className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
          <button
            type="button"
            onClick={() => void saveSecrets()}
            disabled={saving}
            className="mt-4 min-h-11 rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-100 hover:border-zinc-400 disabled:opacity-50"
          >
            Save keys
          </button>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="font-medium text-zinc-100">Your experience</h2>
          <p className="mt-2 text-sm text-zinc-400">
            Jobs requiring more years than you have are filtered out.
          </p>
          <label className="mt-4 block text-sm text-zinc-300">
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
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="font-medium text-zinc-100">Exclude keywords</h2>
          <p className="mt-2 text-sm text-zinc-400">
            Jobs whose title, description, or tags contain any of these words
            are hidden from the feed. Stack words (java, php, kotlin, devops,
            kubernetes, robotics) only hide jobs when they appear in the
            title.
          </p>
          <label className="mt-4 block text-sm text-zinc-300">
            Keywords
            <input
              type="text"
              value={excludeKeywordsText}
              onChange={(e) => setExcludeKeywordsText(e.target.value)}
              placeholder="staff, principal, director"
              className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="font-medium text-zinc-100">
            Avoid exclusive language stacks
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Hide jobs whose required stack is only these languages.
          </p>
          <label className="mt-4 block text-sm text-zinc-300">
            Languages
            <input
              type="text"
              value={avoidLanguagesText}
              onChange={(e) => setAvoidLanguagesText(e.target.value)}
              placeholder="java"
              className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="font-medium text-zinc-100">Job branches</h2>
          <div className="mt-4">
            <RulesEditor branches={branches} onChange={setBranches} />
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="font-medium text-zinc-100">Daily schedule</h2>
          <div className="mt-4">
            <ScheduleEditor value={schedule} onChange={setSchedule} />
          </div>
        </section>

        <button
          type="button"
          onClick={() => void saveRules()}
          disabled={saving}
          className="min-h-11 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save job rules and schedule"}
        </button>

        {message && <p className="text-sm text-emerald-400">{message}</p>}

        <FactsEditor />
      </main>
    </div>
  );
}
