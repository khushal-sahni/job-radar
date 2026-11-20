import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { bridgeSource } from "./bridge-source";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const BRIDGE = bridgeSource(ROOT);

interface Scanned {
  label: string;
  control: string;
  options: string[];
  required: boolean;
  multi?: boolean;
}

let browser: Browser | null = null;

before(async () => {
  browser = await chromium.launch().catch(() => null);
});
after(async () => {
  await browser?.close();
});

async function open(html: { fixture?: string; content?: string }): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  if (html.fixture) await page.goto(`file://${path.join(ROOT, "fixtures/forms", `${html.fixture}.mhtml`)}`);
  else await page.setContent(html.content ?? "");
  await page.evaluate(BRIDGE);
  return page;
}

async function scan(page: Page): Promise<{ fields: Scanned[]; unread: string[] }> {
  return page.evaluate(() => {
    const api = (window as unknown as { JobRadarApply: { scan: () => Scanned[]; unreadRequired: () => string[] } }).JobRadarApply;
    const fields = api.scan();
    return { fields, unread: api.unreadRequired() };
  });
}

const find = (fields: Scanned[], re: RegExp) => fields.filter((f) => re.test(f.label));

describe("scanner on saved forms", { skip: !fs.existsSync(path.join(ROOT, "fixtures/forms")) }, () => {
  it("reads BJAK's provider list as one multi-choice question", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const { fields, unread } = await scan(await open({ fixture: "bjak-applied-ai" }));
    const providers = find(fields, /LLM providers professionally/);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].control, "checkbox");
    assert.equal(providers[0].multi, true);
    assert.deepEqual(providers[0].options, ["OpenAI", "Anthropic", "Llama", "Gemini", "Mistral", "DeepSeek", "Other", "None"]);
    for (const re of [/Node\.js professionally/, /Python professionally/, /AI evaluation/]) {
      const [q] = find(fields, re);
      assert.ok(q, `missing ${re}`);
      assert.deepEqual(q.options, ["Yes", "No"]);
      assert.equal(q.required, true);
    }
    assert.deepEqual(unread, []);
  });

  it("reads every Canonical question and its checkbox lists", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const { fields, unread } = await scan(await open({ fixture: "canonical-graduate" }));
    const areas = find(fields, /areas of engineering/)[0];
    assert.equal(areas.multi, true);
    assert.equal(areas.options.length, 29);
    assert.ok(areas.options.includes("Web back-end"));
    assert.equal(find(fields, /bachelor's university degree result/).length, 1);
    assert.equal(find(fields, /rationale or evidence for the high school/).length, 1);
    assert.deepEqual(unread, []);
  });

  it("labels Lever custom questions with their question, not the placeholder or field name", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const { fields } = await scan(await open({ fixture: "lever-weekday" }));
    assert.equal(fields.some((f) => /^type your response$/i.test(f.label) || f.label.startsWith("cards[")), false);
    assert.equal(find(fields, /current salary/).length, 1);
    assert.equal(find(fields, /notice period \(in days\)/)[0]?.control, "select");
  });
});

describe("scanner on small forms", () => {
  it("reads a Lever location box as a place picker, without the hidden dropdown copy", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form><ul><li class="application-question"><label>
        <div class="application-label">Current location</div>
        <div class="application-field">
          <input class="location-input" name="location">
          <div class="dropdown-container" style="display:none">
            <div class="dropdown-no-results">No location found. Try entering a different location</div>
            <div>Loading</div>
          </div>
        </div>
      </label></li></ul></form>`,
    });
    const { fields } = await scan(page);
    const location = fields.find((f) => f.control === "combobox");
    assert.equal(location?.label, "Current location");
  });

  it("keeps separate single checkboxes apart", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form><ul>
        <li class="application-question"><div class="application-label">Privacy notice *</div><label><input type="checkbox" name="a"> I agree to the privacy policy</label></li>
        <li class="application-question"><div class="application-label">Marketing *</div><label><input type="checkbox" name="b"> I agree to receive emails</label></li>
      </ul><input type="email" name="email"></form>`,
    });
    const { fields } = await scan(page);
    assert.equal(fields.filter((f) => f.control === "checkbox").length, 2);
  });

  it("groups same-named radios and reports a required question it cannot read", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form>
        <div class="field"><label>Do you have 3+ years of experience? *</label>
          <label><input type="radio" name="yoe" value="Yes"> Yes</label><label><input type="radio" name="yoe" value="No"> No</label></div>
        <div class="field"><div class="question-title">Pick your stack *</div><div class="tiles"><div class="tile">Go</div><div class="tile">Node</div></div></div>
      </form>`,
    });
    const { fields, unread } = await scan(page);
    const yoe = find(fields, /3\+ years/)[0];
    assert.deepEqual(yoe.options, ["Yes", "No"]);
    assert.deepEqual(unread, ["Pick your stack"]);
  });

  it("names Greenhouse uploads by their group title and counts an attached file as read", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form><input type="email" name="email">
        <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
          <div id="upload-label-resume" class="label upload-label">Resume/CV<span class="required">*</span></div>
          <div class="file-upload__filename"><p>resume.pdf</p><button type="button" aria-label="Remove file"><svg></svg></button></div>
        </div>
        <div role="group" aria-labelledby="upload-label-cover_letter" class="file-upload">
          <div id="upload-label-cover_letter" class="label upload-label">Cover Letter<span class="required">*</span></div>
          <label for="cl">Attach</label><input id="cl" type="file">
        </div></form>`,
    });
    const { fields, unread } = await scan(page);
    assert.deepEqual(unread, []);
    assert.equal(fields.find((f) => f.control === "file")?.label, "Cover Letter");
  });

  it("names the field behind an Ashby missing-entry link and sees Ashby's success banner", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<div role="alert"><ul><li>Missing entry for required field: <a href="#visa"></a></li></ul></div>
        <form><div id="visa"><label>Do you need a work visa?</label><button type="button">Yes</button><button type="button">No</button></div>
        <input type="email" name="email"></form>`,
    });
    const errors = await page.evaluate(() => (window as unknown as { JobRadarApply: { state: () => { errors: string[] } } }).JobRadarApply.state().errors);
    assert.ok(errors.some((e) => /required field: Do you need a work visa\?/.test(e)), errors.join(" | "));

    const done = await open({ content: `<div><p>Success</p><p>Thank you so much for your interest in joining Bjak!</p></div>` });
    const confirmed = await done.evaluate(() => (window as unknown as { JobRadarApply: { state: () => { confirmation: boolean } } }).JobRadarApply.state().confirmation);
    assert.equal(confirmed, true);

    const sent = await open({ content: `<div><p>Success</p><p>Thank you for submitting your application. We'll be in contact soon with next steps.</p></div>` });
    const sentConfirmed = await sent.evaluate(() => (window as unknown as { JobRadarApply: { state: () => { confirmation: boolean } } }).JobRadarApply.state().confirmation);
    assert.equal(sentConfirmed, true);

    const somnia = await open({
      content: `<div><p>Success</p><p>We wanted to let you know that we’ve successfully received your application and our team is reviewing all submissions.</p></div>`,
    });
    const somniaConfirmed = await somnia.evaluate(() => (window as unknown as { JobRadarApply: { state: () => { confirmation: boolean } } }).JobRadarApply.state().confirmation);
    assert.equal(somniaConfirmed, true);

    const again = await open({ content: `<div><p>Your application was already submitted.</p><p>We received your previous application on October 6, 2026.</p></div>` });
    const againConfirmed = await again.evaluate(() => (window as unknown as { JobRadarApply: { state: () => { confirmation: boolean } } }).JobRadarApply.state().confirmation);
    assert.equal(againConfirmed, true);

    const phenom = await open({
      content: `<p>Senior Delivery AI Software Engineer</p><iframe srcdoc="<p>Thank you for applying!</p>"></iframe>`,
    });
    const phenomConfirmed = await phenom.evaluate(() => (window as unknown as { JobRadarApply: { state: () => { confirmation: boolean } } }).JobRadarApply.state().confirmation);
    assert.equal(phenomConfirmed, true);
  });

  it("keeps select options that have text even when the value attribute is empty", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form><label>Title/Salutation<select>
        <option value="">Please Select</option>
        <option>Mr</option>
        <option>Mrs</option>
        <option>Ms</option>
      </select></label></form>`,
    });
    const { fields } = await scan(page);
    const title = fields.find((f) => /title\/salutation/i.test(f.label));
    assert.equal(title?.control, "select");
    assert.deepEqual(title?.options, ["Mr", "Mrs", "Ms"]);
  });

  it("appends an in-lakhs unit next to a compensation box", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form><label>Current Base Compensation*<input> in lakhs</label></form>`,
    });
    const { fields } = await scan(page);
    assert.ok(fields.some((f) => /lakhs/i.test(f.label)), fields.map((f) => f.label).join(" | "));
  });

  it("reads a Workday From/To date as one field and keeps the current-job checkbox's own label", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<section>
        <h2>Work Experience</h2>
        <div data-automation-id="formField-jobTitle"><label>Job Title*</label><input id="jt"></div>
        <div data-automation-id="formField-currentlyWorkHere"><label><input type="checkbox"> I currently work here</label></div>
        <div data-automation-id="formField-startDate"><fieldset><legend><label><span>From<abbr aria-hidden="true">*</abbr></span></label></legend>
          <div role="group" data-automation-id="dateInputWrapper"><div>
            <div><div aria-hidden="true" data-automation-id="dateSectionMonth-display">MM</div><input role="spinbutton" aria-label="Month" aria-valuetext="MM" data-automation-id="dateSectionMonth-input" value=""></div>
            <div>/</div>
            <div><div aria-hidden="true" data-automation-id="dateSectionYear-display">YYYY</div><input role="spinbutton" aria-label="Year" aria-valuetext="YYYY" data-automation-id="dateSectionYear-input" value=""></div>
          </div></div></fieldset>
        </div>
        <h2>Education</h2>
        <div data-automation-id="formField-firstYearAttended"><fieldset><legend><label>From</label></legend>
          <div role="group" data-automation-id="dateInputWrapper"><div>
            <div><div aria-hidden="true" data-automation-id="dateSectionYear-display">YYYY</div><input role="spinbutton" aria-label="Year" aria-valuetext="YYYY" data-automation-id="dateSectionYear-input" value=""></div>
          </div></div></fieldset>
        </div>
      </section>`,
    });
    const { fields, unread } = await scan(page);
    const dates = fields.filter((f) => /^from/i.test(f.label));
    assert.equal(dates.length, 2, fields.map((f) => f.label).join(", "));
    assert.equal(dates[0].control, "text");
    assert.equal(dates[0].required, true);
    assert.equal(dates[1].required, false);
    assert.ok(!fields.some((f) => /^(month|year)$/i.test(f.label)));
    assert.ok(fields.some((f) => /currently work here/i.test(f.label) && f.control === "checkbox"));
    assert.ok(!unread.some((u) => /^from$/i.test(u)), unread.join(", "));
  });

  it("reads a chosen react-select value as filled, multi-select included", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const select = (id: string, label: string, chip: string) => `<div class="select"><div class="select__container">
        <label for="${id}">${label}*</label><div class="select-shell"><div><div class="select__control">
        <div class="select__value-container select__value-container--is-multi">${chip}
        <div class="select__input-container" data-value=""><input class="select__input" id="${id}" type="text" role="combobox" aria-required="true" value=""></div>
        </div></div></div></div></div></div>`;
    const page = await open({
      content: `<form>
        ${select("g", "Please select which gender applies to you", `<div class="select__multi-value"><div class="select__multi-value__label">Man</div></div>`)}
        ${select("p", "Pronouns", "")}
      </form>`,
    });
    const fields = (await page.evaluate(() =>
      (window as unknown as { JobRadarApply: { scan: () => Array<{ label: string; empty: boolean }> } }).JobRadarApply.scan(),
    )) as Array<{ label: string; empty: boolean }>;
    assert.equal(fields.find((f) => /gender/.test(f.label))?.empty, false);
    assert.equal(fields.find((f) => /Pronouns/.test(f.label))?.empty, true);

    const shown = (await page.evaluate(() =>
      (window as unknown as { JobRadarApply: { answers: () => Array<{ label: string; value: string }> } }).JobRadarApply.answers(),
    )) as Array<{ label: string; value: string }>;
    assert.equal(shown.find((f) => /gender/.test(f.label))?.value, "Man");
    assert.equal(shown.find((f) => /Pronouns/.test(f.label))?.value, "");
  });

  it("drops Workable's SVG fallback text and Lever's internal input names from labels", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form>
        <div class="field"><label for="y">Total years of professional experience<svg><text>SVGs not supported by this browser.</text></svg></label>
          <input id="y" name="years"></div>
        <ul><li class="application-question custom-question">
          <div class="application-label"><div class="text">Have you worked at Woven before?</div></div>
          <div class="application-field"><ul>
            <li><label><input type="radio" name="cards[0b5e][field0]" value="Yes">Yes</label></li>
            <li><label><input type="radio" name="cards[0b5e][field0]" value="No">No</label></li>
          </ul></div>
        </li>
        <li class="application-question custom-question">
          <div class="application-label"><div class="text">Japanese proficiency</div></div>
          <div class="application-field"><input type="text" name="cards[0b5e][field1]"></div>
        </li></ul>
      </form>`,
    });
    const { fields } = await scan(page);
    const labels = fields.map((f) => f.label);
    assert.ok(labels.includes("Total years of professional experience"), labels.join(" | "));
    assert.ok(labels.some((l) => /^Have you worked at Woven before\?/.test(l)), labels.join(" | "));
    assert.ok(labels.some((l) => /^Japanese proficiency/.test(l)), labels.join(" | "));
    assert.ok(!labels.some((l) => /cards\[|SVGs/.test(l)), labels.join(" | "));
  });

  it("treats an Education block title as read when its questions are scanned", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form><div><label class="required">Education History *</label>
        <div><label for="s">School</label><input id="s" name="s"></div>
        <div><label for="d">Degree</label><input id="d" name="d"></div></div></form>`,
    });
    const { unread } = await scan(page);
    assert.deepEqual(unread, []);
  });

  it("fills an iCIMS dropdown whose combobox sits next to a hidden native select", async (t) => {
    if (!browser) return t.skip("no Chromium");
    process.env.DATABASE_URL ??= "postgresql://localhost:5432/unused";
    const { applyAction, scanFields } = await import("./browser-fill");
    const page = await open({
      content: `<form><div class="iCIMS_InfoData">
        <label>Title/Salutation</label>
        <select id="rcf2038" aria-hidden="true" style="display:none">
          <option value="">— Make a Selection —</option>
          <option value="MR">Mr</option>
          <option value="MRS">Mrs</option>
        </select>
        <a id="rcf2038_icimsDropdown" class="dropdown-select" role="combobox" aria-required="true">— Make a Selection —</a>
      </div></form>`,
    });
    const fields = await scanFields(page, ROOT);
    const title = fields.find((f) => /Title/.test(f.label));
    assert.ok(title, fields.map((f) => `${f.control}:${f.label}`).join(" | "));
    const profile = {
      firstName: "",
      lastName: "",
      fullName: "",
      email: "",
      phone: "",
      location: "",
      city: "",
      country: "India",
      linkedInUrl: "",
      githubUrl: "",
      portfolioUrl: "",
      currentCompany: "",
      noticePeriod: "",
      expectedCtc: "",
      resumeSummary: "",
      yearsOfExperience: "4",
    };
    assert.equal(await applyAction(page, title!, { type: "literal", value: "Mr" }, profile), true);
    const after = await scanFields(page, ROOT);
    assert.equal(after.find((f) => /Title/.test(f.label))?.empty, false);
  });

  it("treats a Select2 combobox as filled once the hidden native select has a value", async (t) => {
    if (!browser) return t.skip("no Chromium");
    const page = await open({
      content: `<form><label>Title/Salutation
        <select id="title" class="select2-hidden-accessible" aria-hidden="true" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)">
          <option value="">Make a Selection</option>
          <option value="MR">Mr</option>
          <option value="MRS">Mrs</option>
        </select>
        <span class="select2-container">
          <span class="select2-selection" role="combobox" aria-required="true">
            <span class="select2-selection__rendered">Make a Selection</span>
          </span>
        </span>
      </label></form>`,
    });
    const before = (await page.evaluate(() =>
      (window as unknown as { JobRadarApply: { scan: () => Array<{ label: string; empty: boolean; control: string }> } }).JobRadarApply.scan(),
    )) as Array<{ label: string; empty: boolean; control: string }>;
    const title = before.find((f) => /Title/.test(f.label));
    assert.equal(title?.control, "combobox");
    assert.equal(title?.empty, true);

    await page.evaluate(() => {
      const combo = document.querySelector("[role='combobox']");
      const api = (window as unknown as { JobRadarApply: { associatedSelect: (el: Element) => HTMLSelectElement | null } }).JobRadarApply;
      const sel = api.associatedSelect(combo!);
      if (sel) sel.value = "MR";
    });
    const after = (await page.evaluate(() =>
      (window as unknown as { JobRadarApply: { scan: () => Array<{ label: string; empty: boolean }> } }).JobRadarApply.scan(),
    )) as Array<{ label: string; empty: boolean }>;
    assert.equal(after.find((f) => /Title/.test(f.label))?.empty, false);
  });

  it("fills a Select2 combobox through the hidden native select", async (t) => {
    if (!browser) return t.skip("no Chromium");
    process.env.DATABASE_URL ??= "postgresql://localhost:5432/unused";
    const { applyAction, scanFields } = await import("./browser-fill");
    const page = await open({
      content: `<form><label>Country
        <select id="country" class="select2-hidden-accessible" aria-hidden="true" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)">
          <option value="">Make a Selection</option>
          <option value="IN">India</option>
          <option value="US">United States</option>
        </select>
        <span class="select2-container">
          <span class="select2-selection" role="combobox" aria-required="true">
            <span class="select2-selection__rendered">Make a Selection</span>
          </span>
        </span>
      </label></form>`,
    });
    const fields = await scanFields(page, ROOT);
    const country = fields.find((f) => /Country/.test(f.label));
    assert.ok(country, fields.map((f) => `${f.control}:${f.label}`).join(" | "));
    assert.equal(country?.control, "combobox", JSON.stringify(country));
    const profile = {
      firstName: "",
      lastName: "",
      fullName: "",
      email: "",
      phone: "",
      location: "Bengaluru, India",
      city: "Bengaluru",
      country: "India",
      linkedInUrl: "",
      githubUrl: "",
      portfolioUrl: "",
      currentCompany: "",
      noticePeriod: "",
      expectedCtc: "",
      resumeSummary: "",
      yearsOfExperience: "4",
    };
    assert.equal(await applyAction(page, country!, { type: "literal", value: "India" }, profile), true);
    const after = await scanFields(page, ROOT);
    assert.equal(after.find((f) => /Country/.test(f.label))?.empty, false);
  });
});
