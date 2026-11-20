"use client";

import { useCallback, useEffect, useState } from "react";

interface FactRow {
  key: string;
  question: string;
  type: string;
  value: unknown;
  complete: boolean;
  source: string;
  evidence: string | null;
}

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";
const button = `min-h-11 rounded-lg px-3 text-sm disabled:opacity-40 ${focusRing}`;

function shownValue(fact: FactRow): string {
  if (fact.type === "boolean") return fact.value ? "Yes" : "No";
  if (fact.type === "list") {
    const items = Array.isArray(fact.value) ? (fact.value as string[]) : [];
    const list = items.length > 0 ? items.join(", ") : "None";
    return fact.complete ? `${list} (that's all)` : `${list} (maybe more)`;
  }
  return String(fact.value ?? "");
}

function sourceLabel(source: string): string {
  if (source === "user") return "Your answer";
  if (source === "resume") return "From your resume";
  return "From settings";
}

function draftOf(fact: FactRow): string {
  if (fact.type === "list") return Array.isArray(fact.value) ? (fact.value as string[]).join(", ") : "";
  if (fact.type === "boolean") return fact.value ? "Yes" : "No";
  return String(fact.value ?? "");
}

function FactEditRow({ fact, onSaved, onDeleted }: { fact: FactRow; onSaved: () => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(draftOf(fact));
  const [complete, setComplete] = useState(fact.complete);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const value = fact.type === "list" ? draft.split(",").map((s) => s.trim()).filter(Boolean) : draft;
      const res = await fetch("/api/facts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: fact.key, value, complete }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/facts?key=${encodeURIComponent(fact.key)}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not delete");
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
      setBusy(false);
    }
  }

  const inputId = `fact-${fact.key}`;
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="block text-sm font-medium text-zinc-100">
          {fact.question}
        </label>
        <p className="mt-0.5 truncate text-xs text-zinc-500" title={fact.evidence ?? undefined}>
          {sourceLabel(fact.source)}
          {fact.evidence && fact.source === "resume" ? ` · ${fact.evidence}` : ""}
        </p>
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            {fact.type === "boolean" ? (
              <div className="flex gap-2" role="radiogroup" aria-labelledby={inputId}>
                {["Yes", "No"].map((option) => (
                  <button
                    key={option}
                    id={option === "Yes" ? inputId : undefined}
                    type="button"
                    role="radio"
                    aria-checked={draft === option}
                    onClick={() => setDraft(option)}
                    className={`${button} px-4 ${
                      draft === option
                        ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/50"
                        : "border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : (
              <input
                id={inputId}
                value={draft}
                inputMode={fact.type === "number" ? "decimal" : undefined}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={fact.type === "list" ? "Comma separated" : undefined}
                className={`min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 ${focusRing}`}
              />
            )}
            {fact.type === "list" && (
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  className={`size-4 accent-emerald-500 ${focusRing}`}
                  checked={complete}
                  onChange={(e) => setComplete(e.target.checked)}
                />
                That&apos;s all of them (anything not listed is a no)
              </label>
            )}
          </div>
        ) : (
          <p className="mt-1 break-words text-sm text-zinc-300">{shownValue(fact)}</p>
        )}
        {error && (
          <p className="mt-2 text-sm text-red-300" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {editing ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className={`${button} bg-emerald-500 font-medium text-zinc-950 hover:bg-emerald-400`}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft(draftOf(fact));
                setComplete(fact.complete);
                setError(null);
              }}
              className={`${button} text-zinc-400 hover:text-zinc-200`}
            >
              Cancel
            </button>
          </>
        ) : confirmDelete ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className={`${button} border border-red-500/50 text-red-300 hover:bg-red-500/10`}
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={`${button} text-zinc-400 hover:text-zinc-200`}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={`${button} border border-zinc-700 text-zinc-300 hover:border-zinc-500`}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className={`${button} text-zinc-500 hover:text-zinc-300`}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

async function fetchFacts(): Promise<FactRow[]> {
  const res = await fetch("/api/facts");
  const data = (await res.json()) as { facts?: FactRow[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load facts");
  return data.facts ?? [];
}

/** Facts auto-apply answers from: your answers and what your resume states. */
export function FactsEditor() {
  const [facts, setFacts] = useState<FactRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFacts(await fetchFacts());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load facts");
    }
  }, []);

  useEffect(() => {
    fetchFacts()
      .then(setFacts)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load facts"));
  }, []);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="font-medium text-zinc-100">What Job Radar knows about you</h2>
      <p className="mt-2 text-sm text-zinc-400">
        Applications are answered only from your profile and these facts. Anything else is asked once, then saved
        here. Fix a wrong one and every future form uses the fix.
      </p>
      {error && !facts ? (
        <div className="mt-4 flex items-center gap-3">
          <p className="text-sm text-red-300">{error}</p>
          <button type="button" onClick={() => void load()} className={`${button} border border-zinc-700 text-zinc-300`}>
            Try again
          </button>
        </div>
      ) : !facts ? (
        <p className="mt-4 text-sm text-zinc-500">Loading facts…</p>
      ) : facts.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">
          Nothing yet. Upload your resume in the feed. New facts are asked in chat when a form needs them.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-800">
          {facts.map((fact) => (
            <FactEditRow key={`${fact.key}-${JSON.stringify(fact.value)}-${fact.complete}`} fact={fact} onSaved={() => void load()} onDeleted={() => void load()} />
          ))}
        </ul>
      )}
    </section>
  );
}
