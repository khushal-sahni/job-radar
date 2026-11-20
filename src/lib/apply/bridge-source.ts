import fs from "node:fs";
import path from "node:path";

const BRIDGE_PARTS = ["dom.js", "scan.js", "state.js", "readback.js"];

/**
 * The script injected into application pages. Its parts in `page-bridge/` share one scope and
 * expose `window.JobRadarApply`.
 */
export function bridgeSource(root: string): string {
  const parts = BRIDGE_PARTS.map((f) => fs.readFileSync(path.join(root, "src/lib/apply/page-bridge", f), "utf-8"));
  return `(function () {
if (window.JobRadarApply) return;
${parts.join("\n")}
window.JobRadarApply = { scan, state, answers, unreadRequired, associatedSelect, associatedSelectOptions, commitAssociatedSelect };
})();`;
}
