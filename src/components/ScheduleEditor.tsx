"use client";

export interface ScheduleFormData {
  findScheduleEnabled: boolean;
  applyScheduleEnabled: boolean;
  scheduleHour: number;
  dailyApplyCap: number;
  naukriEnabled: boolean;
}

interface ScheduleEditorProps {
  value: ScheduleFormData;
  onChange: (value: ScheduleFormData) => void;
  /** When true, turning apply on asks for confirm. */
  confirmApply?: boolean;
}

export function ScheduleEditor({
  value,
  onChange,
  confirmApply = true,
}: ScheduleEditorProps) {
  function set(patch: Partial<ScheduleFormData>) {
    onChange({ ...value, ...patch });
  }

  function toggleApply(checked: boolean) {
    if (checked && confirmApply) {
      const ok = window.confirm(
        "Auto-apply will submit real job applications for you (never on LinkedIn). Continue?",
      );
      if (!ok) return;
    }
    set({
      applyScheduleEnabled: checked,
      findScheduleEnabled: checked ? true : value.findScheduleEnabled,
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Leave Job Radar open for the daily run. Nothing is installed in the
        background on your computer.
      </p>

      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={value.findScheduleEnabled}
          onChange={(e) => {
            const on = e.target.checked;
            set({
              findScheduleEnabled: on,
              applyScheduleEnabled: on ? value.applyScheduleEnabled : false,
            });
          }}
          className="mt-1 h-4 w-4 rounded border-zinc-600"
        />
        <span>
          <span className="block font-medium text-zinc-100">
            Look for matching jobs every day
          </span>
          <span className="mt-1 block text-sm text-zinc-400">
            Pulls new postings at the hour you choose.
          </span>
        </span>
      </label>

      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={value.applyScheduleEnabled}
          disabled={!value.findScheduleEnabled}
          onChange={(e) => toggleApply(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-zinc-600 disabled:opacity-40"
        />
        <span>
          <span className="block font-medium text-zinc-100">
            Also auto-apply after finding jobs
          </span>
          <span className="mt-1 block text-sm text-zinc-400">
            Leave this off to review and apply yourself. Never applies on
            LinkedIn.
          </span>
        </span>
      </label>

      <label className="block text-sm text-zinc-300">
        Run around this hour (local time)
        <select
          value={value.scheduleHour}
          onChange={(e) => set({ scheduleHour: Number(e.target.value) })}
          disabled={!value.findScheduleEnabled}
          className="mt-2 w-40 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 disabled:opacity-40"
        >
          {Array.from({ length: 24 }, (_, hour) => (
            <option key={hour} value={hour}>
              {String(hour).padStart(2, "0")}:00
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm text-zinc-300">
        Max applications per day
        <input
          type="number"
          min={0}
          max={1000}
          value={value.dailyApplyCap}
          onChange={(e) => set({ dailyApplyCap: Number(e.target.value) || 0 })}
          disabled={!value.applyScheduleEnabled}
          className="mt-2 w-32 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 disabled:opacity-40"
        />
      </label>

      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={value.naukriEnabled}
          onChange={(e) => set({ naukriEnabled: e.target.checked })}
          className="mt-1 h-4 w-4 rounded border-zinc-600"
        />
        <span>
          <span className="block font-medium text-zinc-100">Include Naukri</span>
          <span className="mt-1 block text-sm text-zinc-400">
            Optional. Needs a one-time Naukri login in the feed panel.
          </span>
        </span>
      </label>
    </div>
  );
}
