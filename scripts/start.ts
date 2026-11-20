/**
 * Cross-platform starter for non-technical users.
 * Called by "Start Job Radar.command" / .bat / .sh
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const PORT = Number(process.env.PORT || 3001);
const URL = `http://localhost:${PORT}`;
const NODE_DOWNLOAD = "https://nodejs.org/";

function say(message: string): void {
  console.log(`\n${message}\n`);
}

async function openBrowser(url: string): Promise<void> {
  try {
    const open = (await import("open")).default;
    await open(url);
    return;
  } catch {
    // fall through to OS helpers
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function ensureNode(): void {
  const result = spawnSync("node", ["-v"], { encoding: "utf-8" });
  if (result.status !== 0) {
    say(
      `Node.js is not installed.\n\n1. Open ${NODE_DOWNLOAD}\n2. Download and install the LTS version\n3. Run Start Job Radar again.`,
    );
    void openBrowser(NODE_DOWNLOAD);
    process.exit(1);
  }
}

function ensureDeps(): void {
  if (fs.existsSync(path.join(ROOT, "node_modules", "next"))) return;
  say("First run: installing Job Radar (this can take a few minutes)…");
  const result = spawnSync("npm", ["install"], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    say("Could not install dependencies. Check the messages above, then try again.");
    process.exit(1);
  }
}

async function waitForServer(timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL, { redirect: "manual" });
      if (res.status > 0) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  ensureNode();
  ensureDeps();

  say(`Starting Job Radar on ${URL}…\nLeave this window open while you use the app.`);

  const child = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });

  const up = await waitForServer();
  if (up) {
    say("Opening your browser…");
    await openBrowser(URL);
  } else {
    say(`The app is still starting. Open ${URL} in your browser when ready.`);
  }
}

main().catch((err) => {
  say(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
