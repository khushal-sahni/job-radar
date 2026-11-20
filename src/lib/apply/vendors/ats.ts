import { runAtsTask } from "../ats-apply";
import type { VendorApplier } from "./types";

/** Greenhouse, Lever, Ashby, Workable and generic forms, in the job-site Chrome. */
export const atsApplier: VendorApplier = {
  profile: "apply",
  apply(lease, job, env) {
    return runAtsTask(lease, {
      taskId: job.taskId,
      url: job.url,
      ctx: job.ctx,
      extensionProfile: env.applicant.extensionProfile,
      resumePath: env.applicant.resumePath,
      root: env.root,
      dryRun: env.plan.dryRun,
      attended: env.plan.attended,
      keepOpen: env.plan.mode === "fill_only",
      review: job.review,
    });
  },
};
