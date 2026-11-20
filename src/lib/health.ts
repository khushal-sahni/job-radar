import { naukriLoginRunning } from "./apply/launch";
import { isProfileRunning } from "./browser/profiles";
import { readNaukriStatus, type NaukriSessionStatus } from "./browser/naukri-session";
import { readDailyState, type DailyState } from "./daily-state";

/** What the apply panel shows about the unattended machinery: logins, Chromes, daily steps. */
export interface SystemHealth {
  naukri: NaukriSessionStatus | null;
  naukriLoginOpen: boolean;
  chrome: { naukri: boolean; apply: boolean };
  daily: DailyState;
}

export function systemHealth(root: string): SystemHealth {
  return {
    naukri: readNaukriStatus(root),
    naukriLoginOpen: naukriLoginRunning(root),
    chrome: { naukri: isProfileRunning("naukri", root), apply: isProfileRunning("apply", root) },
    daily: readDailyState(root),
  };
}
