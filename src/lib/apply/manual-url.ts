import { isLinkedInUrl } from "./vendor";

/** ATS hosts whose first path segment is the company's board slug. */
const BOARD_HOST_RE = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com)$/;

export type UrlCheck = { url: string } | { error: string };

/** A pasted job link, trimmed and checked. LinkedIn is refused: it is never auto-applied. */
export function checkJobUrl(raw: string): UrlCheck {
  const text = raw.trim();
  if (!text) return { error: "Paste a job link" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: "That is not a link" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "Only http and https links work" };
  if (isLinkedInUrl(parsed.href)) return { error: "LinkedIn jobs are never auto-applied" };
  parsed.hash = "";
  return { url: parsed.href };
}

/** The same posting with and without a trailing slash. */
export function urlVariants(url: string): string[] {
  const parsed = new URL(url);
  const bare = parsed.pathname.replace(/\/+$/, "") || "/";
  const paths = bare === "/" ? ["/"] : [bare, `${bare}/`];
  return [url, ...paths.map((p) => `${parsed.origin}${p}${parsed.search}`)].filter((v, i, all) => all.indexOf(v) === i);
}

/** The posting's address without query or trailing slash; tracking parameters differ between pastes. */
export function postingPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Company name for a link not in Job Radar: the board slug on an ATS, otherwise the site name. */
export function companyFromUrl(url: string): string {
  const { hostname, pathname, searchParams } = new URL(url);
  const host = hostname.toLowerCase();
  if (BOARD_HOST_RE.test(host)) {
    const slug = searchParams.get("for") ?? pathname.split("/").filter(Boolean).find((s) => s !== "embed" && s !== "j");
    if (slug) return slug;
  }
  if (host.endsWith(".myworkdayjobs.com") || host.endsWith(".myworkdaysite.com")) {
    const tenant = pathname.split("/").filter((s) => s && !/^[a-z]{2}(-[a-z]{2})?$/i.test(s) && s !== "recruiting")[0];
    if (tenant) return tenant;
  }
  const labels = host.replace(/^(www|careers|jobs|apply|boards)\./, "").split(".");
  return labels.length > 1 ? labels[labels.length - 2] : labels[0];
}
