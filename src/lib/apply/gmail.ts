import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import {
  getGmailAppPassword,
  getGmailUser,
  isGmailConfigured as secretsGmailConfigured,
} from "@/lib/secrets";
import { isAccountMailSubject, isApplicationConfirmationMail } from "./confirmation-mail";
import {
  extractSecurityCode,
  isSecurityCodeSubject,
  subjectNamesCompany,
} from "./security-code";

const DAY_MS = 24 * 60 * 60 * 1000;

export function gmailUser(): string | null {
  return getGmailUser();
}

export function isGmailConfigured(): boolean {
  return secretsGmailConfigured();
}

interface Candidate {
  subject: string;
  date: Date;
  source: Buffer;
}

async function spamPath(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === "\\Junk")?.path ?? null;
}

/** Messages in one mailbox matching `query` that arrived at or after `since` and pass `keep`. */
async function candidatesIn(
  client: ImapFlow,
  path: string,
  since: Date,
  query: SearchObject,
  keep: (subject: string) => boolean,
): Promise<Candidate[]> {
  const lock = await client.getMailboxLock(path);
  try {
    await client.noop();
    const uids = await client.search({ ...query, since: new Date(since.getTime() - DAY_MS) }, { uid: true });
    if (!uids || uids.length === 0) return [];
    const found: Candidate[] = [];
    for (const uid of uids.slice(-10)) {
      const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const subject = msg.envelope?.subject ?? "";
      const date = msg.internalDate ? new Date(msg.internalDate) : null;
      if (!date || date < since || !keep(subject)) continue;
      found.push({ subject, date, source: msg.source });
    }
    return found;
  } finally {
    lock.release();
  }
}

interface MailWait<T> {
  since: Date;
  query: SearchObject;
  keep: (subject: string) => boolean;
  /** Newest first; the first non-null result wins. */
  read: (candidates: Candidate[]) => Promise<T | null>;
  timeoutMs: number;
  pollMs?: number;
}

/** Polls Inbox and Spam over IMAP until `read` finds something. Null when Gmail is not configured or time runs out. */
async function waitForMail<T>(wait: MailWait<T>): Promise<T | null> {
  const user = gmailUser();
  const pass = getGmailAppPassword();
  if (!user || !pass) return null;

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  try {
    const paths = ["INBOX", ...[await spamPath(client)].filter((p): p is string => Boolean(p))];
    const deadline = Date.now() + wait.timeoutMs;
    for (;;) {
      const candidates: Candidate[] = [];
      for (const path of paths) candidates.push(...(await candidatesIn(client, path, wait.since, wait.query, wait.keep)));
      candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
      const found = await wait.read(candidates);
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, wait.pollMs ?? 5_000));
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function bodyOf(c: Candidate): Promise<{ text: string; html: string }> {
  const mail = await simpleParser(c.source);
  return { text: mail.text || "", html: typeof mail.html === "string" ? mail.html : "" };
}

export interface SecurityCodeWait {
  /** Only mail received at or after this time counts. */
  since: Date;
  company: string;
  timeoutMs: number;
  pollMs?: number;
}

/**
 * Polls Inbox and Spam over IMAP for the Greenhouse security-code email and returns the code.
 * Null when Gmail is not configured or nothing arrived in time. Throws on a failed login.
 */
export async function waitForSecurityCode(wait: SecurityCodeWait): Promise<string | null> {
  return waitForMail({
    since: wait.since,
    query: { or: [{ subject: "code" }, { subject: "identity" }, { subject: "verification" }] },
    keep: isSecurityCodeSubject,
    timeoutMs: wait.timeoutMs,
    pollMs: wait.pollMs,
    read: async (candidates) => {
      const ordered = [
        ...candidates.filter((c) => subjectNamesCompany(c.subject, wait.company)),
        ...candidates.filter((c) => !subjectNamesCompany(c.subject, wait.company)),
      ];
      for (const c of ordered) {
        const { text, html } = await bodyOf(c);
        const code = extractSecurityCode(text || html);
        if (code) return code;
      }
      return null;
    },
  });
}

export interface AccountMail {
  /** A link to open (verify the account, reset the password). */
  link: string | null;
  /** A one-time code to type. */
  code: string | null;
}

/**
 * Polls for a career-site account email (Workday verify / reset) from `fromDomain` and returns
 * its link or code. Null when Gmail is not configured or nothing arrived in time.
 */
export async function waitForAccountMail(wait: {
  since: Date;
  fromDomain: string;
  linkHost: string;
  extract: (body: { text: string; html: string }, linkHost: string) => AccountMail | null;
  timeoutMs: number;
  pollMs?: number;
}): Promise<AccountMail | null> {
  return waitForMail({
    since: wait.since,
    query: { from: wait.fromDomain },
    keep: () => true,
    timeoutMs: wait.timeoutMs,
    pollMs: wait.pollMs,
    read: async (candidates) => {
      for (const c of candidates) {
        const found = wait.extract(await bodyOf(c), wait.linkHost);
        if (found) return found;
      }
      return null;
    },
  });
}

export interface ApplicationMailWait {
  since: Date;
  company: string;
  jobTitle?: string;
  timeoutMs: number;
  pollMs?: number;
}

/**
 * Polls Inbox and Spam for a "we got your application" email for this company or title.
 * Null when Gmail is not configured or nothing arrived in time. Throws on a failed login.
 */
export async function waitForApplicationMail(wait: ApplicationMailWait): Promise<{ subject: string } | null> {
  return waitForMail({
    since: wait.since,
    query: {
      or: [
        { subject: "thank" },
        { subject: "application" },
        { subject: "applied" },
        { subject: "submitted" },
        { from: "myworkdayjobs.com" },
        { from: "myworkday.com" },
      ],
    },
    keep: (subject) => !isSecurityCodeSubject(subject) && !isAccountMailSubject(subject),
    timeoutMs: wait.timeoutMs,
    pollMs: wait.pollMs,
    read: async (candidates) => {
      const named = [
        ...candidates.filter((c) => subjectNamesCompany(c.subject, wait.company)),
        ...candidates.filter((c) => !subjectNamesCompany(c.subject, wait.company)),
      ];
      for (const c of named) {
        const { text, html } = await bodyOf(c);
        if (isApplicationConfirmationMail({ subject: c.subject, text, html }, { company: wait.company, jobTitle: wait.jobTitle })) {
          return { subject: c.subject };
        }
      }
      return null;
    },
  });
}

/**
 * After Submit, if the page never showed a thank-you, this is the second check.
 * True when Gmail has a confirmation for this job. False when Gmail is unset, empty, or errors.
 */
export async function submittedByEmail(
  wait: ApplicationMailWait & { log?: (m: string) => void },
): Promise<boolean> {
  if (!isGmailConfigured()) return false;
  wait.log?.("  page did not confirm submit; checking Gmail");
  try {
    const mail = await waitForApplicationMail(wait);
    if (!mail) return false;
    wait.log?.(`  Gmail has a submission email (${mail.subject.slice(0, 80)})`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    wait.log?.(`  Gmail confirmation check failed: ${message.slice(0, 120)}`);
    return false;
  }
}
