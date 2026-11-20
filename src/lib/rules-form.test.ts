import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formToRules, rulesToForm, ruleBranchLabel } from "./rules-form";
import { DEFAULT_RULES } from "./types";

describe("rules-form", () => {
  it("round-trips default rules through the form", () => {
    const form = rulesToForm(DEFAULT_RULES);
    assert.equal(form.every((b) => b.enabled), true);
    const back = formToRules(form);
    assert.equal(back.length, DEFAULT_RULES.length);
    assert.equal(
      back.find((r) => r.id === "remote-india")?.minSalaryINR,
      3_500_000,
    );
    assert.equal(
      back.find((r) => r.id === "india-onsite")?.minBaseINR,
      4_000_000,
    );
    assert.equal(back.find((r) => r.id === "germany")?.minSalaryEUR, 70_000);
    assert.equal(back.find((r) => r.id === "japan")?.minSalaryJPY, 8_000_000);
  });

  it("drops disabled branches", () => {
    const form = rulesToForm(DEFAULT_RULES).map((b) =>
      b.id === "germany" ? { ...b, enabled: false } : b,
    );
    const rules = formToRules(form);
    assert.equal(rules.some((r) => r.id === "germany"), false);
    assert.equal(rules.length, 3);
  });

  it("builds labels from salary floors", () => {
    const label = ruleBranchLabel({
      id: "remote-india",
      remote: true,
      eligibleFromIndia: true,
      minSalaryINR: 3_500_000,
    });
    assert.match(label, /35 LPA/);
  });
});
