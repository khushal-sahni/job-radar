/**
 * Saves a live application form as an offline fixture for the scanner tests.
 *
 *   npx tsx scripts/capture-form.ts <name> <url>
 *
 * Opens the form in a fresh browser (no profile, nothing typed), clears any values the page
 * prefilled, and writes `fixtures/forms/<name>.mhtml` with its styles, so visibility and layout
 * match the real page when a test loads it from disk.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const [name, url] = process.argv.slice(2);
  if (!name || !url || !/^[a-z0-9-]+$/.test(name)) {
    console.error("usage: npx tsx scripts/capture-form.ts <name: a-z0-9-> <url>");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForSelector("form, input[type='email'], input[type='file']", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);

    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
        if (el instanceof HTMLInputElement && ["checkbox", "radio", "file", "submit", "button", "hidden"].includes(el.type)) continue;
        el.value = "";
        el.setAttribute("value", "");
      }
      for (const s of document.querySelectorAll("script, noscript, iframe")) s.remove();
    });

    const cdp = await page.context().newCDPSession(page);
    const { data } = (await cdp.send("Page.captureSnapshot", { format: "mhtml" })) as { data: string };
    const dir = path.join(ROOT, "fixtures", "forms");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.mhtml`);
    fs.writeFileSync(file, data);
    console.log(`saved ${path.relative(ROOT, file)} (${Math.round(data.length / 1024)} KB) from ${page.url()}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
