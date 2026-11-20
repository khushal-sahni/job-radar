"use client";

import { useEffect, useRef, useState } from "react";

export interface ProfileFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedInUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  currentCompany: string;
  noticePeriod: string;
  expectedCtc: string;
  resumeSummary: string;
  resumeFilename: string | null;
  hasResumePdf: boolean;
}

const EMPTY_PROFILE: ProfileFormData = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  linkedInUrl: "",
  githubUrl: "",
  portfolioUrl: "",
  currentCompany: "",
  noticePeriod: "",
  expectedCtc: "",
  resumeSummary: "",
  resumeFilename: null,
  hasResumePdf: false,
};

interface ProfileEditorProps {
  initial: ProfileFormData;
  onSaved?: () => void;
}

export function ProfileEditor({ initial, onSaved }: ProfileEditorProps) {
  const [profile, setProfile] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Parent loads profile async after mount — sync when server data arrives.
  // Without this, the form stays EMPTY_PROFILE forever while DB is fine.
  useEffect(() => {
    setProfile(initial);
  }, [initial]);

  function update(field: keyof ProfileFormData, value: string) {
    setProfile((prev) => ({ ...prev, [field]: value }));
  }

  async function saveProfile() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setMessage("Profile saved. Auto-apply uses it from the next job.");
      onSaved?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function uploadResume(file: File) {
    setUploading(true);
    setMessage(null);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/resume", { method: "POST", body: formData });
      const data = (await res.json()) as { error?: string; filename?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");

      setProfile((prev) => ({
        ...prev,
        resumeFilename: data.filename ?? file.name,
        hasResumePdf: true,
      }));
      setMessage("Resume uploaded. Auto-apply attaches this PDF.");
      onSaved?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const fields: Array<{
    key: keyof ProfileFormData;
    label: string;
    type?: string;
    wide?: boolean;
  }> = [
    { key: "firstName", label: "First name" },
    { key: "lastName", label: "Last name" },
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone", type: "tel" },
    { key: "location", label: "Location" },
    { key: "linkedInUrl", label: "LinkedIn URL" },
    { key: "githubUrl", label: "GitHub URL" },
    { key: "portfolioUrl", label: "Portfolio URL" },
    { key: "currentCompany", label: "Current company" },
    { key: "noticePeriod", label: "Notice period" },
    { key: "expectedCtc", label: "Expected CTC / salary" },
  ];

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="font-medium text-zinc-100">Autofill profile</h2>
      <p className="mt-2 text-sm text-zinc-400">
        Used by the auto-apply runner to fill application forms, including links you
        paste on the feed or send with the extension shortcut.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {fields.map(({ key, label, type = "text" }) => (
          <label key={key} className="block text-sm text-zinc-300">
            {label}
            <input
              type={type}
              value={String(profile[key] ?? "")}
              onChange={(e) => update(key, e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
        ))}
      </div>

      <label className="mt-4 block text-sm text-zinc-300">
        Resume summary (optional cover letter blurb)
        <textarea
          value={profile.resumeSummary}
          onChange={(e) => update("resumeSummary", e.target.value)}
          rows={4}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
        />
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Upload resume PDF"}
        </button>
        {profile.hasResumePdf && profile.resumeFilename && (
          <span className="text-sm text-emerald-400">
            PDF: {profile.resumeFilename}
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadResume(file);
          }}
        />
      </div>

      <button
        type="button"
        onClick={() => void saveProfile()}
        disabled={saving}
        className="mt-5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
      >
        {saving ? "Saving profile…" : "Save profile"}
      </button>

      {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}
    </section>
  );
}

export { EMPTY_PROFILE };
