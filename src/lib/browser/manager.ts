import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { findGoogleChrome, macChromeAppPath } from "@/lib/chrome";
import {
  legacyProfileDir,
  migrateLegacyProfile,
  profileDir,
  profileHolder,
  profileLabel,
  projectRoot,
  type ProfileName,
} from "./profiles";

/**
 * The only module that starts or attaches to Chrome on an app profile.
 *
 * Each profile is driven by one real, headed Chrome started detached with a DevTools port.
 * Every run (scheduled, Apply now, Fill, Naukri login, Naukri browse) attaches to it over CDP.
 * Code never quits that Chrome: a lease only closes the tabs it opened, so a login, a filled
 * form, or another process's tabs survive. Chrome is opened in the background.
 */

const START_WAIT_MS = 25_000;
const CONNECT_TIMEOUT_MS = 5_000;

export type BrowserErrorCode = "chrome_unavailable" | "profile_held";

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export interface Lease {
  readonly profile: ProfileName;
  readonly context: BrowserContext;
  /** Opens a tab this lease owns. Popups opened from it are owned too. */
  newPage(): Promise<Page>;
  /** Tabs this lease opened that are still open. */
  openPages(): Page[];
  /** Closes every tab this lease opened. Chrome and other tabs stay. */
  closePages(): Promise<void>;
  /** False once the user quit Chrome or the connection dropped. */
  isConnected(): boolean;
  /** Ends the lease; `keepOpen` leaves its tabs for the user. */
  release(options?: { keepOpen?: boolean }): Promise<void>;
}

interface Connection {
  browser: Browser | null;
  context: BrowserContext;
  /** Chrome's start-up blank tabs, closed once a lease has a tab of its own. */
  startupPages: Set<Page>;
}

const connections = new Map<string, Promise<Connection>>();

/** The port Chrome wrote for its `--remote-debugging-port=0` launch on this profile, if any. */
function activePort(dir: string): number | null {
  try {
    const port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf-8").split("\n")[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** CDP endpoint of the profile's running Chrome, for tools that attach on their own. */
export function cdpEndpoint(profile: ProfileName, root = projectRoot()): string | null {
  const port = activePort(profileDir(profile, root));
  return port ? `http://127.0.0.1:${port}` : null;
}

function clearStaleFiles(dir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

async function connect(port: number): Promise<Connection | null> {
  const { chromium } = (await import("patchright")) as { chromium: typeof import("playwright").chromium };
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: CONNECT_TIMEOUT_MS });
    const context = browser.contexts()[0];
    if (!context) return null;
    if (context.pages().length === 0) await context.newPage();
    const startupPages = new Set(context.pages().filter((p) => p.url() === "about:blank"));
    return { browser, context, startupPages };
  } catch {
    return null;
  }
}

async function chromeBinary(): Promise<{ binary: string; macApp: string | null }> {
  const google = findGoogleChrome();
  if (google) return { binary: google, macApp: macChromeAppPath() };
  const { chromium } = (await import("patchright")) as { chromium: typeof import("playwright").chromium };
  return { binary: chromium.executablePath(), macApp: null };
}

/**
 * Starts Chrome on the profile, detached so it outlives this process. On a Mac with Chrome
 * installed it goes through `open -gn` so the window opens behind the current app and a running
 * everyday Chrome cannot swallow the launch. Linux and Windows spawn the binary detached.
 */
async function startChrome(dir: string): Promise<void> {
  const { binary, macApp } = await chromeBinary();
  const args = [
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    // A debugging port alone turns on navigator.webdriver; hCaptcha (Lever) then fails every token.
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const child =
    process.platform === "darwin" && macApp
      ? spawn("open", ["-g", "-n", "-a", macApp, "--args", ...args], { detached: true, stdio: "ignore" })
      : spawn(binary, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function waitForConnection(dir: string): Promise<Connection | null> {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(500);
    const port = activePort(dir);
    if (!port) continue;
    const conn = await connect(port);
    if (conn) return conn;
  }
  return null;
}

async function openConnection(profile: ProfileName, root: string, log: (m: string) => void): Promise<Connection> {
  const dir = profileDir(profile, root);
  const label = profileLabel(profile);
  if (profileHolder(legacyProfileDir(profile, root)) === null && migrateLegacyProfile(profile, root)) {
    log(`Moved the ${label} profile to ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const port = activePort(dir);
  if (port) {
    const conn = await connect(port);
    if (conn) return conn;
  }

  const holder = profileHolder(dir);
  if (holder === null) {
    clearStaleFiles(dir);
    log(`Opening the ${label}`);
  } else if (port) {
    // Running but refusing connections: a Mac Chrome with no windows. A launch makes it open one.
    log(`Opening a window in the ${label}`);
  } else {
    throw new BrowserError(
      "profile_held",
      `The ${label} (pid ${holder}) was started without the app's debugging port. Quit that Chrome; the next run reopens it.`,
    );
  }

  await startChrome(dir);
  const conn = await waitForConnection(dir);
  if (!conn) throw new BrowserError("chrome_unavailable", `The ${label} did not open within ${START_WAIT_MS / 1000}s`);
  return conn;
}

async function connection(profile: ProfileName, root: string, log: (m: string) => void): Promise<Connection> {
  const key = profileDir(profile, root);
  const cached = connections.get(key);
  if (cached) {
    const conn = await cached.catch(() => null);
    if (conn && (conn.browser?.isConnected() ?? true)) return conn;
    connections.delete(key);
  }
  const pending = openConnection(profile, root, log);
  connections.set(key, pending);
  pending.catch(() => connections.delete(key));
  return pending;
}

/** Wraps an already-open context (tests, throwaway profiles) in the lease interface. */
export function leaseFromContext(profile: ProfileName, context: BrowserContext): Lease {
  return createLease(profile, { browser: context.browser(), context, startupPages: new Set() });
}

function createLease(profile: ProfileName, conn: Connection): Lease {
  const owned = new Set<Page>();
  const track = (page: Page): void => {
    if (owned.has(page)) return;
    owned.add(page);
    page.on("close", () => owned.delete(page));
    page.on("popup", track);
  };

  const lease: Lease = {
    profile,
    context: conn.context,
    async newPage() {
      const page = await conn.context.newPage();
      track(page);
      for (const blank of conn.startupPages) {
        // A Mac Chrome left with no window stalls CDP calls (cookies, new tabs); keep one tab of ours out of it.
        const others = conn.context.pages().filter((p) => !owned.has(p) && !p.isClosed());
        if (others.length <= 1) break;
        conn.startupPages.delete(blank);
        if (blank.url() === "about:blank") await blank.close().catch(() => undefined);
      }
      return page;
    },
    openPages() {
      return [...owned].filter((p) => !p.isClosed());
    },
    async closePages() {
      for (const page of [...owned]) await page.close().catch(() => undefined);
      owned.clear();
    },
    isConnected() {
      return conn.browser?.isConnected() ?? true;
    },
    async release(options) {
      if (!options?.keepOpen) await lease.closePages();
    },
  };
  return lease;
}

/**
 * Attaches to the profile's Chrome, starting it if needed. Many leases (in this process or
 * others) can share one Chrome; each only ever closes its own tabs.
 */
export async function leaseBrowser(
  profile: ProfileName,
  options: { root?: string; log?: (message: string) => void } = {},
): Promise<Lease> {
  const log = options.log ?? ((m: string) => console.log(m));
  const conn = await connection(profile, options.root ?? projectRoot(), log);
  return createLease(profile, conn);
}
