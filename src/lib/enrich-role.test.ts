import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRelevantRole } from "./enrich";

describe("isRelevantRole", () => {
  it("rejects support titles even when the body says distributed", () => {
    assert.equal(
      isRelevantRole(
        "Customer Support Specialist",
        "Earnings is distributed among eligible team members on our platform API.",
      ),
      false,
    );
  });

  it("keeps software and applied-AI titles", () => {
    assert.equal(isRelevantRole("Software Engineer", "Customer success team partners with you."), true);
    assert.equal(isRelevantRole("Sr. AI Engineer, AI FDE", "Work with customers."), true);
    assert.equal(isRelevantRole("Senior Lead Infrastructure Engineer", "Lead the platform."), true);
    assert.equal(isRelevantRole("Data Platform Engineer", "Partner with the business."), true);
  });

  it("rejects titles that only say platform", () => {
    assert.equal(isRelevantRole("Platform Business Partner", "Own the platform relationship."), false);
    assert.equal(isRelevantRole("Senior Accountant-Revenue & Platform Accounting", "ASC 606 revenue."), false);
  });

  it("rejects titles that only say infrastructure", () => {
    assert.equal(isRelevantRole("Senior Director, Infrastructure", "Lead infrastructure strategy."), false);
    assert.equal(isRelevantRole("Technical Sales, Infrastructure", "Sell infrastructure products."), false);
    assert.equal(isRelevantRole("Senior Lead Infrastructure Engineer", "Lead the platform."), true);
  });

  it("rejects intern, campus, and new-grad titles even when the body is backend", () => {
    assert.equal(isRelevantRole("2027 Software Engineer - Campus Graduate Program - IIT Madras", "Build backend services."), false);
    assert.equal(isRelevantRole("Software Engineer Intern", "Distributed systems in Go."), false);
    assert.equal(isRelevantRole("Software Engineer, New Grad (2027)", "Full-stack platform work."), false);
    assert.equal(isRelevantRole("Graduate Software Engineer", "Backend APIs."), false);
    assert.equal(isRelevantRole("2027 Early Career Flight Software Engineer", "Embedded C++."), false);
    assert.equal(isRelevantRole("Software Engineer", "Campus recruiting partners with you."), true);
  });
});
