"use client";

import { useRef, useState } from "react";

interface ResumeUploadProps {
  onUploaded?: () => void;
}

export function ResumeUpload({ onUploaded }: ResumeUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    setSuccess(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/resume", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as {
        error?: string;
        skills?: string[];
        seniority?: string;
      };

      if (!res.ok) {
        throw new Error(data.error ?? "Upload failed");
      }

      setSuccess(
        `Uploaded — ${data.skills?.length ?? 0} skills detected (${data.seniority ?? "unknown"} level)`,
      );
      onUploaded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/40 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-medium text-zinc-100">Resume</h3>
          <p className="mt-1 text-sm text-zinc-400">
            Upload PDF to rank matches by fit. Stored locally in your DB only.
          </p>
        </div>
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-zinc-400 disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Upload PDF"}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
        }}
      />
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {success && <p className="mt-3 text-sm text-emerald-400">{success}</p>}
    </div>
  );
}
