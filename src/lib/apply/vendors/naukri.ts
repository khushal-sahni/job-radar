import { ensureNaukriSession } from "@/lib/browser/naukri-session";
import { NAUKRI_LOGIN_REASON, runNaukriTask } from "../naukri-apply";
import { alreadySent, park } from "../outcome";
import { sentPostingTwin } from "../queue";
import { detectVendor, isLinkedInUrl } from "../vendor";
import { atsApplier } from "./ats";
import type { VendorApplier } from "./types";

/**
 * Naukri in the Naukri Chrome. The login is checked (and restored from the saved session) once
 * per run; "Apply on company site" hands over to the ATS applier in the same Chrome.
 */
export const naukriApplier: VendorApplier = {
  profile: "naukri",
  async prepare(lease, env) {
    const state = await ensureNaukriSession(lease, { root: env.root, log: env.log });
    if (state === "login_required") return park("login_required", NAUKRI_LOGIN_REASON);
    if (state === "challenge") return park("challenge", "Naukri showed a challenge page");
    return null;
  },
  apply(lease, job, env) {
    return runNaukriTask(lease, {
      taskId: job.taskId,
      url: job.url,
      ctx: job.ctx,
      dryRun: env.plan.dryRun,
      review: job.review,
      keepOpen: env.plan.mode === "fill_only",
      onCompanySite: async (url) => {
        if (isLinkedInUrl(url)) return park("linkedin", "Naukri's company-site link goes to LinkedIn");
        const twin = await sentPostingTwin(url, job.taskId);
        if (twin) return alreadySent(twin.company, twin.title);
        const site = detectVendor(url);
        env.log(`  company site is ${site}: ${url}`);
        return atsApplier.apply(lease, { ...job, url, ctx: { ...job.ctx, vendor: site } }, env);
      },
    });
  },
};
