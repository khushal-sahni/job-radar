import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkJobUrl, companyFromUrl, urlVariants } from "./manual-url";

describe("pasted job links", () => {
  it("accepts http(s) links and drops the fragment", () => {
    assert.deepEqual(checkJobUrl("  https://jobs.lever.co/acme/123#apply "), { url: "https://jobs.lever.co/acme/123" });
    assert.ok("error" in checkJobUrl(""));
    assert.ok("error" in checkJobUrl("not a link"));
    assert.ok("error" in checkJobUrl("ftp://example.com/job"));
    assert.ok("error" in checkJobUrl("javascript:alert(1)"));
  });

  it("refuses LinkedIn", () => {
    assert.ok("error" in checkJobUrl("https://www.linkedin.com/jobs/view/123"));
    assert.ok("error" in checkJobUrl("https://in.linkedin.com/jobs/view/123"));
  });

  it("matches the same posting with or without a trailing slash", () => {
    const a = urlVariants("https://jobs.lever.co/acme/123");
    assert.ok(a.includes("https://jobs.lever.co/acme/123/"));
    const b = urlVariants("https://apply.workable.com/acme/j/ABC/?src=x");
    assert.ok(b.includes("https://apply.workable.com/acme/j/ABC?src=x"));
  });

  it("names the company from the board slug or the site", () => {
    assert.equal(companyFromUrl("https://jobs.lever.co/acme/123"), "acme");
    assert.equal(companyFromUrl("https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=1"), "stripe");
    assert.equal(companyFromUrl("https://jobs.ashbyhq.com/elevenlabs/abc"), "elevenlabs");
    assert.equal(companyFromUrl("https://careers.example.co.uk/role/1").length > 0, true);
    assert.equal(companyFromUrl("https://www.stripe.com/jobs/listing/x"), "stripe");
  });
});
