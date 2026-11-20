export type ApplicationStatus =
  | "applied"
  | "not_interested"
  | "saved"
  | "interviewing"
  | "rejected"
  | "offer";

export type StatusFilter = "open" | ApplicationStatus | "all";

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  "applied",
  "not_interested",
  "saved",
  "interviewing",
  "rejected",
  "offer",
];

export const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "open", label: "To apply" },
  { id: "applied", label: "Applied" },
  { id: "interviewing", label: "Interviewing" },
  { id: "offer", label: "Offer" },
  { id: "saved", label: "Saved" },
  { id: "not_interested", label: "Not interested" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

const PRISMA_TO_APP: Record<string, ApplicationStatus> = {
  APPLIED: "applied",
  NOT_INTERESTED: "not_interested",
  SAVED: "saved",
  INTERVIEWING: "interviewing",
  REJECTED: "rejected",
  OFFER: "offer",
};

const APP_TO_PRISMA: Record<ApplicationStatus, string> = {
  applied: "APPLIED",
  not_interested: "NOT_INTERESTED",
  saved: "SAVED",
  interviewing: "INTERVIEWING",
  rejected: "REJECTED",
  offer: "OFFER",
};

export function toAppStatus(
  prismaStatus: string | null | undefined,
): ApplicationStatus | null {
  if (!prismaStatus) return null;
  return PRISMA_TO_APP[prismaStatus] ?? null;
}

export function toPrismaStatus(status: ApplicationStatus): string {
  return APP_TO_PRISMA[status];
}

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return (
    typeof value === "string" &&
    APPLICATION_STATUSES.includes(value as ApplicationStatus)
  );
}

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  applied: "Applied",
  not_interested: "Not interested",
  saved: "Saved",
  interviewing: "Interviewing",
  rejected: "Rejected",
  offer: "Offer",
};

export const STATUS_BADGE_CLASS: Record<ApplicationStatus, string> = {
  applied: "bg-zinc-700/50 text-zinc-300",
  not_interested: "bg-red-500/15 text-red-300",
  saved: "bg-blue-500/15 text-blue-300",
  interviewing: "bg-violet-500/15 text-violet-300",
  rejected: "bg-orange-500/15 text-orange-300",
  offer: "bg-emerald-500/15 text-emerald-300",
};

export const STATUS_CARD_CLASS: Record<ApplicationStatus, string> = {
  applied: "border-zinc-700/80 bg-zinc-900/30 opacity-80",
  not_interested: "border-red-900/40 bg-zinc-900/20 opacity-60",
  saved: "border-blue-900/40 bg-zinc-900/40",
  interviewing: "border-violet-500/30 bg-zinc-900/50",
  rejected: "border-orange-900/40 bg-zinc-900/25 opacity-70",
  offer: "border-emerald-500/30 bg-emerald-950/20",
};

export function emptyMessageForFilter(filter: StatusFilter): string {
  switch (filter) {
    case "open":
      return "Nothing left to apply — nice work, or refresh jobs";
    case "applied":
      return "No applied jobs yet";
    case "not_interested":
      return "No jobs marked not interested";
    case "saved":
      return "No saved jobs yet";
    case "interviewing":
      return "No jobs in interviewing";
    case "rejected":
      return "No rejected jobs tracked";
    case "offer":
      return "No offers yet — you'll get there";
    default:
      return "No matching jobs yet";
  }
}
