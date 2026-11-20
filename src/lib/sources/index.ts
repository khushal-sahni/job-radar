import { arbeitnowAdapter } from "./arbeitnow";
import { adzunaAdapter } from "./adzuna";
import { remoteokAdapter } from "./remoteok";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { ashbyAdapter } from "./ashby";
import { workableAdapter } from "./workable";
import type { SourceAdapter } from "./base";

export const ALL_ADAPTERS: SourceAdapter[] = [
  arbeitnowAdapter,
  // adzuna disabled — stale/broken redirect links; prefer first-party ATS boards
  // adzunaAdapter,
  remoteokAdapter,
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workableAdapter,
];

export {
  arbeitnowAdapter,
  adzunaAdapter,
  remoteokAdapter,
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workableAdapter,
};
