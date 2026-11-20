/**
 * Jobgether's Lever board lists partner roles with a single-country location
 * subtitle, while bodies often say "open globally". Trust the subtitle.
 */
export type JobgetherGate =
  | { kind: "pass" }
  | { kind: "keep"; country: "IN" | "DE" | "JP" }
  | { kind: "drop" };

const TARGET_COUNTRIES: Record<string, "IN" | "DE" | "JP"> = {
  india: "IN",
  germany: "DE",
  japan: "JP",
};

export function isJobgether(company: string): boolean {
  return company.trim().toLowerCase() === "jobgether";
}

export function gateJobgether(
  company: string,
  location: string | null | undefined,
): JobgetherGate {
  if (!isJobgether(company)) return { kind: "pass" };
  const country = TARGET_COUNTRIES[(location ?? "").trim().toLowerCase()];
  return country ? { kind: "keep", country } : { kind: "drop" };
}
