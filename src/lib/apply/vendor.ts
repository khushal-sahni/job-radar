import type { ApplyVendor } from "./types";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLinkedInUrl(url: string): boolean {
  const host = hostOf(url);
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

/** Career-site hosts with a plain one-page form the generic runner can fill. */
const GENERIC_FORM_HOST_RE = /(^|\.)pinpointhq\.com$/;

/** True when the generic runner handles this host's form (Pinpoint). */
export function isGenericFormHost(url: string): boolean {
  return GENERIC_FORM_HOST_RE.test(hostOf(url));
}

function isWorkdayHost(host: string): boolean {
  return host.endsWith("myworkdayjobs.com") || host.endsWith("myworkdaysite.com");
}

export function detectVendor(url: string, source?: string): ApplyVendor {
  const host = hostOf(url);
  if (host.endsWith("greenhouse.io") || /[?&]gh_jid=/.test(url)) return "greenhouse";
  if (host.endsWith("lever.co")) return "lever";
  if (host.endsWith("ashbyhq.com")) return "ashby";
  if (host.endsWith("workable.com")) return "workable";
  if (isWorkdayHost(host)) return "workday";
  if (host.endsWith("naukri.com")) return "naukri";
  if (source === "greenhouse" || source === "lever" || source === "ashby" || source === "workable") {
    return source;
  }
  if (source === "naukri") return "naukri";
  return "generic";
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Workday tenant: the host's first label (acme.wd1.myworkdayjobs.com) or the path's (wd1.myworkdaysite.com/recruiting/acme). */
function workdayTenant(host: string, path: string): string {
  if (host.endsWith("myworkdayjobs.com")) return host.split(".")[0];
  return path.split("/").filter((s) => s && s !== "recruiting" && !/^[a-z]{2}(-[a-z]{2})?$/i.test(s))[0] ?? host;
}

/**
 * One key per posting, the same for every link that reaches it: the ATS board, a career-site
 * wrapper (`?gh_jid=`), the embed form, or a Naukri "Apply on company site" redirect. Null when
 * the link carries no posting id. Two postings of one role in two cities have two keys.
 */
export function postingKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const gh =
    parsed.searchParams.get("gh_jid") ??
    (host.endsWith("greenhouse.io") ? (/\/jobs\/(\d+)/.exec(path)?.[1] ?? parsed.searchParams.get("token")) : null);
  if (gh && /^\d+$/.test(gh)) return `greenhouse:${gh}`;
  const uuid = UUID_RE.exec(path)?.[0]?.toLowerCase();
  if (uuid && host.endsWith("lever.co")) return `lever:${uuid}`;
  if (uuid && host.endsWith("ashbyhq.com")) return `ashby:${uuid}`;
  if (host.endsWith("workable.com")) {
    const id = /\/j\/([0-9a-f]+)/i.exec(path)?.[1];
    if (id) return `workable:${id.toUpperCase()}`;
  }
  if (isWorkdayHost(host)) {
    const req = /\/job\/(?:[^/]+\/)*[^/]*_([a-z0-9-]+)(?:\/|$)/i.exec(path)?.[1];
    if (req) return `workday:${workdayTenant(host, path).toLowerCase()}:${req.toUpperCase()}`;
  }
  return null;
}

/** Greenhouse job id from a `gh_jid` career-site link or a board URL. */
function greenhouseJobId(url: string): string | null {
  return /[?&]gh_jid=(\d+)/.exec(url)?.[1] ?? /\/jobs\/(\d+)/.exec(url)?.[1] ?? null;
}

/**
 * URL that lands directly on the application form when the vendor splits posting and form.
 * `board` is the ATS board slug (the job's company for ATS sources).
 */
export function applicationEntryUrl(url: string, vendor: ApplyVendor, board?: string): string {
  const clean = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (isGenericFormHost(url) && /\/postings\/[0-9a-f-]{36}$/i.test(clean)) return `${clean}/applications/new`;
  switch (vendor) {
    case "greenhouse": {
      // Company career pages (stripe.com, jobs.elastic.co, helsing.ai) wrap the form in their own shell;
      // Greenhouse's embed page is the bare form for any board.
      const id = greenhouseJobId(url);
      if (hostOf(url).endsWith("greenhouse.io") || !id || !board || !/^[a-z0-9_-]+$/i.test(board)) return url;
      return `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${id}`;
    }
    case "lever":
      return clean.endsWith("/apply") ? clean : `${clean}/apply`;
    case "ashby":
      return clean.endsWith("/application") ? clean : `${clean}/application`;
    case "workable":
      return clean.endsWith("/apply") ? `${clean}/` : `${clean}/apply/`;
    case "workday": {
      // The manual form, past the "Autofill with Resume / Apply Manually" dialog.
      if (!/\/job\//.test(clean)) return url;
      return `${clean.replace(/\/apply(\/.*)?$/, "")}/apply/applyManually`;
    }
    default:
      return url;
  }
}
