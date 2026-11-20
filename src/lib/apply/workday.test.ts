import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type Workday = typeof import("./workday");
let extractWorkdayMail: Workday["extractWorkdayMail"];
let generatePassword: Workday["generatePassword"];
let isWorkdayUrl: Workday["isWorkdayUrl"];
let isWorkdayWizard: Workday["isWorkdayWizard"];
let classifyWorkdayScreen: Workday["classifyWorkdayScreen"];
let workdayTenant: Workday["workdayTenant"];
let applyManuallyUrl: Workday["applyManuallyUrl"];

describe("workday accounts", () => {
  before(async () => {
    // The browser helpers import Prisma, which needs a URL but never connects here.
    process.env.DATABASE_URL ??= "postgresql://test@localhost:5432/test";
    ({ extractWorkdayMail, generatePassword, isWorkdayUrl, isWorkdayWizard, classifyWorkdayScreen, workdayTenant, applyManuallyUrl } = await import("./workday"));
  });

  const blank = {
    alreadyApplied: false,
    resetPasswordButton: false,
    forgotPasswordSubmit: false,
    verifyPassword: false,
    createAccountSubmit: false,
    signInSubmit: false,
    password: false,
    email: false,
    otp: false,
    applyManually: false,
    createAccountLink: false,
    signInLink: false,
    applyButton: false,
    applicationField: false,
    verifyNotice: false,
    passwordResetUrl: false,
  };

  it("classifies by the live action, not leftover progress chrome", () => {
    assert.equal(classifyWorkdayScreen({ ...blank, applicationField: true }), "wizard");
    assert.equal(classifyWorkdayScreen({ ...blank, resetPasswordButton: true, email: true }), "forgot_password");
    assert.equal(
      classifyWorkdayScreen({ ...blank, resetPasswordButton: true, email: true, applyButton: false, applicationField: false }),
      "forgot_password",
    );
    assert.equal(classifyWorkdayScreen({ ...blank, password: true, signInSubmit: true, email: true }), "sign_in");
    assert.equal(classifyWorkdayScreen({ ...blank, password: true, verifyPassword: true, createAccountSubmit: true }), "create_account");
    assert.equal(classifyWorkdayScreen({ ...blank, passwordResetUrl: true, password: true, resetPasswordButton: true }), "set_password");
    assert.equal(classifyWorkdayScreen({ ...blank, alreadyApplied: true, applicationField: true }), "already_applied");
    assert.equal(classifyWorkdayScreen({ ...blank, applyManually: true }), "apply_dialog");
    assert.equal(classifyWorkdayScreen({ ...blank, applyButton: true }), "apply_button");
    assert.equal(classifyWorkdayScreen({ ...blank, applyButton: true, applicationField: false }), "apply_button");
    assert.equal(classifyWorkdayScreen(blank), "unknown");
  });

  it("treats only an application field as the wizard, not a leftover bar or reset email", () => {
    const form = { progressBar: true, activeStep: true, email: false, password: false, signIn: false, createAccount: false, forgotPassword: false, applicationField: true };
    assert.equal(isWorkdayWizard(form), true);
    assert.equal(isWorkdayWizard({ ...form, applicationField: false, activeStep: false }), false);
    assert.equal(isWorkdayWizard({ ...form, email: true, applicationField: false }), false);
    assert.equal(isWorkdayWizard({ ...form, forgotPassword: true, applicationField: false }), false);
    assert.equal(isWorkdayWizard({ ...form, password: true, signIn: true, applicationField: false }), false);
  });

  it("knows Workday hosts and their tenant", () => {
    const url = "https://thales.wd3.myworkdayjobs.com/Careers/job/Bangalore/X_R1/apply/applyManually";
    assert.equal(isWorkdayUrl(url), true);
    assert.equal(isWorkdayUrl("https://job-boards.greenhouse.io/x"), false);
    assert.equal(workdayTenant(url), "thales.wd3");
  });

  it("builds /apply/applyManually once, even with a query string or a stacked path", () => {
    const posting = "https://jiostar.wd102.myworkdayjobs.com/en-GB/JioStar/job/Bengaluru--We-Work/Senior-Software-Development-Engineer_JR12516";
    const form = `${posting}/apply/applyManually`;
    assert.equal(applyManuallyUrl(posting), form);
    assert.equal(applyManuallyUrl(`${form}?source=LinkedIn`), form);
    assert.equal(applyManuallyUrl(`${form}/apply/applyManually`), form);
    assert.equal(applyManuallyUrl(`${posting}/apply?source=naukri`), form);
  });

  it("makes passwords Workday accepts", () => {
    for (let i = 0; i < 20; i++) {
      const p = generatePassword();
      assert.equal(p.length, 16);
      assert.match(p, /[A-Z]/);
      assert.match(p, /[a-z]/);
      assert.match(p, /[0-9]/);
      assert.match(p, /[!@#$%*?]/);
    }
  });

  it("reads the verify link from a Workday email", () => {
    const html = `<p>Verify your account</p><a href="https://thales.wd3.myworkdayjobs.com/Careers/activate/abc123?redirect=x&amp;y=1">Verify Account</a>
      <a href="https://www.thalesgroup.com/privacy">Privacy</a>`;
    const mail = extractWorkdayMail({ text: "", html }, "thales.wd3.myworkdayjobs.com");
    assert.equal(mail?.link, "https://thales.wd3.myworkdayjobs.com/Careers/activate/abc123?redirect=x&y=1");
  });

  it("reads a reset link and a one-time code", () => {
    const reset = extractWorkdayMail(
      { text: "Reset your password: https://wd3.myworkday.com/thales/passwordreset?token=Zx9", html: "" },
      "thales.wd3.myworkdayjobs.com",
    );
    assert.equal(reset?.link, "https://wd3.myworkday.com/thales/passwordreset?token=Zx9");
    const bare = extractWorkdayMail(
      {
        text: "",
        html: "<div>Click this link to reset your password<br>https://jiostar.wd102.myworkdayjobs.com/JioStar/passwordreset/abc123?redirect=%2Fen-GB<br>The link will expire after 2 hours.</div>",
      },
      "jiostar.wd102.myworkdayjobs.com",
    );
    assert.equal(bare?.link, "https://jiostar.wd102.myworkdayjobs.com/JioStar/passwordreset/abc123?redirect=%2Fen-GB");
    const code = extractWorkdayMail({ text: "Your verification code is 482913. It expires in 10 minutes.", html: "" }, "x");
    assert.equal(code?.code, "482913");
    assert.equal(extractWorkdayMail({ text: "Thanks for applying to Thales.", html: "" }, "x"), null);
  });
});
