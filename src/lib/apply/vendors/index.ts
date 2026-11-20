import type { ApplyVendor } from "../types";
import { atsApplier } from "./ats";
import { naukriApplier } from "./naukri";
import type { VendorApplier } from "./types";
import { workdayApplier } from "./workday";

export function applierFor(vendor: ApplyVendor): VendorApplier {
  if (vendor === "naukri") return naukriApplier;
  if (vendor === "workday") return workdayApplier;
  return atsApplier;
}

export type { ApplyJob, RunEnv, VendorApplier } from "./types";
