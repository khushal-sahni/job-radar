/**
 * One-off: fill salary on stored Naukri jobs that have none, using the
 * AmbitionBox “typically earns” range from each job page, in the Naukri Chrome; no LLM,
 * no other sources. The feed re-applies the 35/42 LPA rules on next load.
 *
 * Usage: npx tsx scripts/naukri-salary-backfill.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

loadEnv({ path: path.join(PROJECT_ROOT, ".env") });

function log(message: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

function lpa(inr: number | undefined): string {
  return inr == null ? "?" : (inr / 100_000).toFixed(1);
}

async function main(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  const { db } = await import("../src/lib/db");
  const { fetchNaukriJobDetails, naukriSalary } = await import("../src/lib/sources/naukri");
  const { salaryRangeToINRSync } = await import("../src/lib/fx");

  const rows = await db.job.findMany({
    where: { source: "naukri", isActive: true, salaryINRMin: null, salaryINRMax: null },
    select: { id: true, externalId: true, url: true, title: true, company: true },
  });
  log(`${rows.length} Naukri jobs without salary`);
  if (rows.length === 0) return;

  const { leaseBrowser } = await import("../src/lib/browser/manager");
  const lease = await leaseBrowser("naukri", { root: PROJECT_ROOT, log });
  const { details, expiredIds, blocked } = await fetchNaukriJobDetails(
    await lease.newPage(),
    rows.map((r) => ({ jobId: r.externalId, url: r.url })),
    { log },
  ).finally(() => lease.release());

  let updated = 0;
  let noInsight = 0;
  for (const row of rows) {
    if (!details.has(row.externalId)) continue;
    const salary = naukriSalary(null, details.get(row.externalId) ?? null);
    if (salary.salaryMin == null && salary.salaryMax == null) {
      noInsight += 1;
      continue;
    }
    const inr = salaryRangeToINRSync(salary.salaryMin, salary.salaryMax, salary.salaryCurrency);
    await db.job.update({
      where: { id: row.id },
      data: {
        salaryMin: salary.salaryMin ?? null,
        salaryMax: salary.salaryMax ?? null,
        salaryCurrency: salary.salaryCurrency ?? null,
        salaryINRMin: inr.min ?? null,
        salaryINRMax: inr.max ?? null,
        salaryEstimated: salary.salaryEstimated ?? false,
        salaryVerified: !salary.salaryEstimated,
        isBaseSalary: salary.salaryEstimated ? null : undefined,
      },
    });
    updated += 1;
    log(
      `  ${row.company} · ${row.title}: ₹${lpa(inr.min)}–${lpa(inr.max)} LPA${salary.salaryEstimated ? " (est.)" : ""}`,
    );
  }

  if (expiredIds.length > 0) {
    await db.job.updateMany({
      where: { source: "naukri", externalId: { in: expiredIds } },
      data: { isActive: false },
    });
  }

  log(
    `Done — updated ${updated}, no salary insight ${noInsight}, expired ${expiredIds.length}, not visited ${rows.length - details.size - expiredIds.length}`,
  );
  if (blocked) log(`Stopped early: ${blocked}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
