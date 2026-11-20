/** Greenhouse's spam check emails a one-time code with this subject, followed by the company name. */
export const SECURITY_CODE_SUBJECT = "Security code for your application";

export const SECURITY_CODE_REASONS = {
  noMail: "Greenhouse emailed a security code; add Gmail in Settings so the runner can read it",
  noCode: "Greenhouse emailed a security code, but none arrived in Gmail in time",
  rejected: "Greenhouse did not accept the emailed security code",
  mismatch: (email: string) =>
    `Greenhouse emailed the security code to ${email}, which is not the Gmail address in Settings`,
} as const;

const CODE_TOKEN = "[A-Za-z0-9]{6,10}";
const INSTRUCTION_RE = new RegExp(`security code field[^:]{0,80}:\\s*(${CODE_TOKEN})\\b`, "i");
const LONE_TOKEN_RE = new RegExp(`^(${CODE_TOKEN})$`);

function htmlToText(body: string): string {
  return body
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** A word on its own line counts only if it looks generated: a digit, or a capital after the first letter. */
function looksLikeCode(token: string): boolean {
  return /\d/.test(token) || /[A-Z]/.test(token.slice(1));
}

/** The code from a Greenhouse security-code email body (plain text or HTML), or null. */
export function extractSecurityCode(body: string): string | null {
  const text = htmlToText(body);
  const flat = text.replace(/\s+/g, " ");
  const inline = flat.match(INSTRUCTION_RE);
  if (inline) return inline[1];

  for (const line of text.split("\n")) {
    const token = line.trim().match(LONE_TOKEN_RE)?.[1];
    if (token && looksLikeCode(token)) return token;
  }
  const six = text.match(/\b(\d{6})\b/);
  return six?.[1] ?? null;
}

export function isSecurityCodeSubject(subject: string): boolean {
  const s = subject.toLowerCase();
  return s.includes(SECURITY_CODE_SUBJECT.toLowerCase()) || /\b(verification code|one[- ]time (code|password|passcode)|confirm your identity|otp)\b/.test(s);
}

/** True when the subject names this company (the employer's brand can differ from the board name). */
export function subjectNamesCompany(subject: string, company: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = norm(company);
  return name.length > 0 && norm(subject).includes(name);
}
