import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type Icims = typeof import("./icims");
let extractIcimsMail: Icims["extractIcimsMail"];
let isIcimsUrl: Icims["isIcimsUrl"];
let icimsHost: Icims["icimsHost"];
let icimsContentUrl: Icims["icimsContentUrl"];
let icimsJobContentUrl: Icims["icimsJobContentUrl"];

describe("icims accounts", () => {
  before(async () => {
    process.env.DATABASE_URL ??= "postgresql://test@localhost:5432/test";
    ({ extractIcimsMail, isIcimsUrl, icimsHost, icimsContentUrl, icimsJobContentUrl } = await import("./icims"));
  });

  it("knows iCIMS hosts and content URLs", () => {
    const url =
      "https://careers-orange.icims.com/jobs/26244/software-engineer---lead/login?mobile=false&width=1470";
    assert.equal(isIcimsUrl(url), true);
    assert.equal(isIcimsUrl("https://job-boards.greenhouse.io/x"), false);
    assert.equal(icimsHost(url), "careers-orange.icims.com");
    assert.match(icimsContentUrl(url), /in_iframe=1/);
    const atlassian = "https://globalcareers-atlassian.icims.com/jobs/25540/backend-software-engineer%2c-ii/login";
    assert.match(icimsContentUrl(atlassian), /25540/);
    assert.match(icimsContentUrl(atlassian), /in_iframe=1/);
    const job = icimsJobContentUrl(atlassian);
    assert.match(job, /\/job(?:\?|$)/);
    assert.match(job, /in_iframe=1/);
    assert.equal(job.includes("/login"), false);
  });

  it("reads the verify link from an iCIMS email", () => {
    const html = `<p>Verify your account</p><a href="https://careers-orange.icims.com/jobs/login?eem=abc123&amp;code=xyz">Verify Account</a>
      <a href="https://www.orange-business.com/privacy">Privacy</a>`;
    const mail = extractIcimsMail({ text: "", html }, "careers-orange.icims.com");
    assert.equal(mail?.link, "https://careers-orange.icims.com/jobs/login?eem=abc123&code=xyz");
  });

  it("reads a reset link and a one-time code", () => {
    const reset = extractIcimsMail(
      { text: "Reset your password: https://careers-orange.icims.com/jobs/passwordreset?token=Zx9", html: "" },
      "careers-orange.icims.com",
    );
    assert.equal(reset?.link, "https://careers-orange.icims.com/jobs/passwordreset?token=Zx9");
    const code = extractIcimsMail(
      { text: "Your verification code is 482913. It expires in 10 minutes.", html: "" },
      "x",
    );
    assert.equal(code?.code, "482913");
    assert.equal(extractIcimsMail({ text: "Thanks for applying to Orange.", html: "" }, "x"), null);
  });
});
