/**
 * End-to-end check of the apply runner against a local fixture form (no network, no model).
 *
 *   npx tsx scripts/apply-fixture-check.ts [--headed]
 *
 * Run 1 must park on the visa-sponsorship question without submitting; after the answer is
 * saved, run 2 must submit with no model call. Creates and deletes its own Job / recipes.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
loadEnv({ path: path.join(PROJECT_ROOT, ".env") });
delete process.env.OPENROUTER_API_KEY;

function check(cond: unknown, message: string): void {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

/**
 * A Lever-like form: the first Submit shows a captcha that "solves" after 4s.
 * auto: the form then submits by itself (slowly); any further click spends the token and errors.
 * cleared: the form reports a verification error and clears the resume; a retry with the resume succeeds.
 */
function leverLikeForm(mode: "auto" | "cleared"): string {
  return `<!doctype html><body>
    <form id="f" class="application-form">
      <div class="field"><label for="name">Full name *</label><input id="name" name="name" required></div>
      <div class="field"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
      <div class="field"><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></div>
      <button type="submit">Submit application</button>
    </form>
    <div id="msg"></div>
    <script>
      const mode = "${mode}";
      let phase = "fresh";
      const f = document.getElementById("f");
      const post = (data) => fetch("/submit", { method: "POST", body: JSON.stringify({ ...data, mode }) });
      const fail = () => {
        document.getElementById("msg").innerHTML = '<div class="error">There was an error verifying your application</div>';
        f.resume.value = "";
      };
      const done = () => (document.body.innerHTML = "<h1>Thank you for applying</h1>");
      f.addEventListener("submit", (e) => {
        e.preventDefault();
        const resume = f.resume.files[0]?.name ?? null;
        if (phase === "fresh") {
          phase = "captcha";
          const w = document.createElement("div");
          w.className = "g-recaptcha";
          w.style.cssText = "width:304px;height:78px;background:#ddd";
          document.body.appendChild(w);
          setTimeout(() => {
            w.remove();
            if (mode === "auto") {
              phase = "spent";
              setTimeout(() => post({ resume, via: "auto" }).then(done), 5000);
            } else {
              phase = "cleared";
              fail();
            }
          }, 4000);
          return;
        }
        if (phase === "spent") {
          post({ resume, via: "click", error: "spent token" });
          fail();
          return;
        }
        if (phase === "cleared") {
          if (!resume) return post({ via: "retry", error: "no resume" });
          post({ resume, via: "retry" }).then(done);
        }
      });
    </script>
  </body>`;
}

async function main(): Promise<void> {
  const html = fs.readFileSync(path.join(SCRIPT_DIR, "fixtures/apply-form.html"));
  const submissions: Array<Record<string, string | null>> = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        submissions.push(JSON.parse(body));
        res.end("{}");
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    const lever = req.url?.match(/^\/lever-(auto|cleared)\//);
    if (lever) {
      res.end(leverLikeForm(lever[1] as "auto" | "cleared"));
      return;
    }
    if (req.url === "/combo") {
      res.end(`<!doctype html><body>
        <ul class="phone-picker"><li role="option">Vereinigte Staaten +1</li><li role="option">Indien +91</li></ul>
        <div class="field"><label for="land">Land*</label><input id="land" role="combobox"></div>
        <div class="field"><label for="lang">Preferred language</label>
          <input id="lang" role="combobox" aria-controls="lang-list">
          <ul id="lang-list" role="listbox"><li role="option">German</li><li role="option">English</li></ul>
        </div>
        <div class="field"><label for="yrs">How many years of experience do you have in Go?</label>
          <input id="yrs" role="combobox"><ul><li role="option">Golang</li><li role="option">Kafka</li></ul>
        </div>
      </body>`);
      return;
    }
    if (req.url?.startsWith("/captcha")) {
      const widget = `<div class="g-recaptcha" id="cap" style="width:304px;height:78px;background:#ddd"></div>`;
      const solve = req.url.startsWith("/captcha-solved")
        ? `<script>setTimeout(() => document.getElementById("cap").remove(), 4000)</script>`
        : "";
      res.end(html.toString().replace("</body>", `${widget}${solve}</body>`));
      return;
    }
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/jobs/1`;

  const { db } = await import("../src/lib/db");
  const { runAtsTask } = await import("../src/lib/apply/ats-apply");
  const { buildProfileValues } = await import("../src/lib/apply/profile-map");
  const { saveAnswers } = await import("../src/lib/apply/question-store");
  const { getApplyInbox } = await import("../src/lib/apply/inbox");
  const { leaseFromContext } = await import("../src/lib/browser/manager");
  const { chromium } = (await import("patchright")) as { chromium: typeof import("playwright").chromium };
  const { readComboOptions, scanFields } = await import("../src/lib/apply/browser-fill");

  const started = new Date();
  const job = await db.job.create({
    data: {
      externalId: `fixture-${Date.now()}`,
      source: "fixture",
      title: "Backend Engineer",
      company: "Fixture Co",
      description: "fixture",
      url,
    },
  });
  const task = await db.applyTask.create({ data: { jobId: job.id, vendor: "generic", status: "IN_PROGRESS" } });

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "jr-apply-"));
  const resumePath = path.join(profileDir, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\n%fixture\n");
  const context = await chromium.launchPersistentContext(profileDir, { headless: !process.argv.includes("--headed") });
  const lease = leaseFromContext("apply", context);

  const raw = {
    firstName: "Test",
    lastName: "Person",
    email: "test@example.com",
    phone: "+91 90000 00000",
    location: "Bengaluru, India",
    linkedInUrl: "",
    githubUrl: "",
    portfolioUrl: "https://example.com",
    currentCompany: "Acme",
    noticePeriod: "30 days",
    expectedCtc: "",
    resumeSummary: "",
  };
  const ctx = {
    vendor: "generic" as const,
    company: "Fixture Co",
    jobTitle: "Backend Engineer",
    profile: buildProfileValues(raw, 4),
    voiceSamples: [],
    log: (m: string) => console.log(`   ${m}`),
  };
  const input = {
    taskId: task.id,
    url,
    ctx,
    extensionProfile: raw,
    resumePath,
    root: PROJECT_ROOT,
    dryRun: false,
    attended: false,
    review: [],
  };
  const { CAPTCHA_REASON } = await import("../src/lib/apply/outcome");

  try {
    const first = await runAtsTask(lease, input);
    console.log("run 1:", first);
    check(first.status === "NEEDS_ANSWER", "run 1 parks on an unknown question");
    check(submissions.length === 0, "run 1 does not submit");
    await db.applyTask.update({ where: { id: task.id }, data: { status: "NEEDS_ANSWER" } });

    const inbox = await getApplyInbox(new Date(0));
    const mine = inbox.questions.filter((q) => q.jobs.some((j) => j.company === "Fixture Co"));
    const sponsor = mine.find((q) => /sponsorship/i.test(q.prompt));
    check(sponsor, "sponsorship question reaches the feed inbox");
    check(mine.length === 1, "no questions for the human check, honeypots, or known fields");

    const humanRecipe = await db.fieldRecipe.findFirst({
      where: { createdAt: { gte: started }, label: { contains: "human" } },
    });
    check(humanRecipe && JSON.stringify(humanRecipe.action).includes("apple"), "human-branch answer saved as a recipe");

    await saveAnswers([{ fingerprint: sponsor!.fingerprint, answer: "No" }]);

    const dry = await runAtsTask(lease, { ...input, dryRun: true });
    check(dry.status === "READY", "dry run fills everything and stops before submit");
    check(submissions.length === 0, "dry run does not submit");

    const second = await runAtsTask(lease, input);
    console.log("run 2:", second);
    check(second.status === "SUBMITTED", "run 2 submits after the answer is saved");

    const posted = submissions[0];
    console.log("posted:", posted);
    check(posted.check === "apple", "human check answered 'apple', not 'banana'");
    check(posted.sponsor === "no", "saved answer used for sponsorship");
    check(!posted.website2 && !posted.honey, "honeypot fields left empty");
    check(posted.first_name === "Test" && posted.email === "test@example.com", "profile fields filled");
    check(posted.resume === "resume.pdf", "resume attached");

    const base = `http://127.0.0.1:${port}`;
    const parked = await runAtsTask(lease, { ...input, url: `${base}/captcha/1` });
    check(
      parked.status === "NEEDS_YOU" && parked.reason === CAPTCHA_REASON && submissions.length === 1,
      "headless run parks on a captcha without submitting",
    );

    const solved = await runAtsTask(lease, { ...input, url: `${base}/captcha-solved/1`, attended: true });
    check(
      solved.status === "SUBMITTED" && submissions.length === 2,
      "headed run waits for the captcha, then submits",
    );

    const before = submissions.length;
    const auto = await runAtsTask(lease, { ...input, url: `${base}/lever-auto/1`, attended: true });
    const autoPosts = submissions.slice(before);
    console.log("lever auto:", auto, autoPosts);
    check(
      auto.status === "SUBMITTED" && autoPosts.length === 1 && autoPosts[0].via === "auto" && autoPosts[0].resume === "resume.pdf",
      "form that submits itself after the captcha is not clicked again",
    );

    const mid = submissions.length;
    const cleared = await runAtsTask(lease, { ...input, url: `${base}/lever-cleared/1`, attended: true });
    const clearedPosts = submissions.slice(mid);
    console.log("lever cleared:", cleared, clearedPosts);
    check(
      cleared.status === "SUBMITTED" &&
        clearedPosts.length === 1 &&
        clearedPosts[0].via === "retry" &&
        clearedPosts[0].resume === "resume.pdf",
      "cleared resume is attached again before the single retry",
    );

    await lease.closePages();
    const page = await lease.newPage();
    await page.goto(`${base}/combo`);
    const scanned = await scanFields(page, PROJECT_ROOT);
    const optionsFor = async (label: string) => {
      const f = scanned.find((s) => s.label.startsWith(label));
      return f ? readComboOptions(page, f.id, f.label) : null;
    };
    check((await optionsFor("Land"))?.length === 0, "combobox without its own list reads no page-wide options");
    check(
      JSON.stringify(await optionsFor("Preferred language")) === JSON.stringify(["German", "English"]),
      "combobox reads the listbox it controls",
    );
    check((await optionsFor("How many years"))?.length === 0, "years combobox drops a skills menu");
  } finally {
    await context.close().catch(() => undefined);
    await db.job.delete({ where: { id: job.id } }).catch(() => undefined);
    await db.fieldRecipe.deleteMany({ where: { createdAt: { gte: started } } });
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  console.log("all fixture checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
