/**
 * Whether an inbound email is a "we got your application" note for this job, not a
 * verify / reset / security-code message. Used when the career site never painted a
 * thank-you page after Submit.
 */

const CONFIRM_RE =
  /\b(thank(s| you)( so much| very much)? for (applying|your application|your interest|submitting)|application (has been |was )?(successfully )?(submitted|received|sent|complete)|we('ve|’ve| have) (successfully )?received your application|successfully (applied|submitted)|you have (successfully )?(applied|submitted)|application (received|complete|submitted)|congratulations.{0,80}(application|applied|submitted))\b/i;

const ACCOUNT_RE =
  /\b(reset\b.{0,40}\bpassword|forgot\b.{0,40}\bpassword|password reset|verify (your )?(account|email)|activate (your )?account|confirm your (email|account)|security code for your application|one[- ]time (code|password|passcode)|confirm your identity)\b/i;

function htmlToText(body: string): string {
  return body
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when `haystack` names this company or title after stripping punctuation. */
export function namesJob(haystack: string, name: string | undefined, minLen = 1): boolean {
  if (!name) return false;
  const needle = norm(name);
  if (needle.length < minLen) return false;
  const hay = norm(haystack);
  if (hay.includes(needle)) return true;
  const compact = (s: string) => s.replace(/\s+/g, "");
  return compact(needle).length >= minLen && compact(hay).includes(compact(needle));
}

export function isAccountMailSubject(subject: string): boolean {
  return ACCOUNT_RE.test(subject);
}

export function isApplicationConfirmationMail(
  mail: { subject: string; text?: string; html?: string },
  job: { company: string; jobTitle?: string },
): boolean {
  const subject = mail.subject ?? "";
  if (isAccountMailSubject(subject)) return false;
  const body = `${mail.text ?? ""} ${htmlToText(mail.html ?? "")}`;
  const blob = `${subject}\n${body}`;
  if (!CONFIRM_RE.test(blob)) return false;
  return namesJob(blob, job.company) || namesJob(blob, job.jobTitle, 10);
}
