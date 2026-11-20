import type { Lease } from "@/lib/browser/manager";
import type { ProfileName } from "@/lib/browser/profiles";
import type { Applicant } from "../applicant";
import type { TaskOutcome } from "../outcome";
import type { RunPlan } from "../plan";
import type { ResolveContext } from "../context";
import type { ReviewAnswer } from "../review-sample";

export interface ApplyJob {
  taskId: string;
  url: string;
  ctx: ResolveContext;
  /** Filled in with what the form shows, for the review samples. */
  review: ReviewAnswer[];
}

export interface RunEnv {
  plan: RunPlan;
  root: string;
  applicant: Applicant;
  log: (message: string) => void;
}

/** One way of applying (a job board or ATS family). The run loop knows nothing vendor-specific. */
export interface VendorApplier {
  /** The Chrome profile its jobs run in. */
  profile: ProfileName;
  /**
   * Checked once per run before its first job. An outcome means every job of this vendor would
   * hit the same wall (logged out, challenged), so they wait in the queue untouched.
   */
  prepare?(lease: Lease, env: RunEnv): Promise<TaskOutcome | null>;
  apply(lease: Lease, job: ApplyJob, env: RunEnv): Promise<TaskOutcome>;
}
