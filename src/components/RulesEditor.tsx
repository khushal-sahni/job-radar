"use client";

import type { RuleBranchForm } from "@/lib/rules-form";

interface RulesEditorProps {
  branches: RuleBranchForm[];
  onChange: (branches: RuleBranchForm[]) => void;
}

export function RulesEditor({ branches, onChange }: RulesEditorProps) {
  function update(id: string, patch: Partial<RuleBranchForm>) {
    onChange(branches.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  const enabledCount = branches.filter((b) => b.enabled).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        A job matches if it passes <strong className="text-zinc-200">any</strong>{" "}
        branch you leave on.
      </p>

      {branches.map((branch) => (
        <div
          key={branch.id}
          className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5"
        >
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={branch.enabled}
              onChange={(e) => update(branch.id, { enabled: e.target.checked })}
              className="mt-1 h-4 w-4 rounded border-zinc-600"
            />
            <span>
              <span className="block font-medium text-zinc-100">{branch.title}</span>
              <span className="mt-1 block text-sm text-zinc-400">
                {branch.description}
              </span>
            </span>
          </label>

          {branch.enabled && (
            <div className="mt-4 space-y-3 border-t border-zinc-800 pt-4">
              <label className="block text-sm text-zinc-300">
                Minimum{" "}
                {branch.salaryUnit === "LPA"
                  ? "salary (LPA)"
                  : branch.salaryUnit === "EUR"
                    ? "salary (€)"
                    : "salary (¥)"}
                <input
                  type="number"
                  min={0}
                  step={branch.salaryUnit === "JPY" ? 100_000 : 1}
                  value={branch.salaryValue}
                  onChange={(e) =>
                    update(branch.id, { salaryValue: Number(e.target.value) || 0 })
                  }
                  className="mt-2 w-40 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
                />
              </label>

              {branch.showVisa && (
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={branch.visaRequired}
                    onChange={(e) =>
                      update(branch.id, { visaRequired: e.target.checked })
                    }
                    className="h-4 w-4 rounded border-zinc-600"
                  />
                  Require confirmed visa sponsorship
                </label>
              )}
            </div>
          )}
        </div>
      ))}

      {enabledCount === 0 && (
        <p className="text-sm text-amber-400">
          Turn on at least one branch or no jobs will match.
        </p>
      )}
    </div>
  );
}
