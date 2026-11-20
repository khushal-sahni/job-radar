import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { auditPage, contradictionAboutUnaskedTopic, isFalseContradiction, sameText, type FillIntent, type Readback } from "./audit";
import {
  buildFactSheet,
  choiceLimit,
  coerceFactValue,
  emptyFactSheet,
  itemMatches,
  parseRange,
  projectFact,
  resumeTools,
  yesNoOptions,
  type Fact,
  type FactSheet,
} from "./facts";
import { buildProfileValues } from "./profile-map";
import type { Classification, FieldDescriptor } from "./types";
import { BACKGROUND_FACTS } from "./applicant-data";
import { citedFacts, dropWordingFlags, isWordingOnlyFlag, parseReview, reviewErrors } from "./written";

let cleanClassification: typeof import("./classify").cleanClassification;
let questionKey: typeof import("./classify").questionKey;
let verifiedResumeFacts: typeof import("./resume-facts").verifiedResumeFacts;
let answerToFactValue: typeof import("./question-store").answerToFactValue;
let parkCompanyAsk: typeof import("./resolve").parkCompanyAsk;
let parkUnreadableList: typeof import("./resolve").parkUnreadableList;

before(async () => {
  // These modules import the Prisma client, which needs a URL to construct; no query runs in these tests.
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/unused";
  ({ cleanClassification, questionKey } = await import("./classify"));
  ({ verifiedResumeFacts } = await import("./resume-facts"));
  ({ answerToFactValue } = await import("./question-store"));
  ({ parkCompanyAsk, parkUnreadableList } = await import("./resolve"));
});

const profile = buildProfileValues(
  {
    firstName: "Khushal",
    lastName: "Sahni",
    email: "k@example.com",
    phone: "+91 90000 00000",
    location: "Gurugram, Haryana, India",
    linkedInUrl: "",
    githubUrl: "",
    portfolioUrl: "",
    currentCompany: "Fello",
    noticePeriod: "Immediate",
    expectedCtc: "45 LPA",
    resumeSummary: "",
  },
  4,
);

const RESUME = "SDE 2, Fello. Built high-throughput backend platforms using Node.js, Kafka, Redis, and MongoDB on AWS. Ready to go, and to Go live fast.";

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return { id: "q1", label: "Question", control: "radio", options: [], required: true, maxLength: null, freeText: false, ...partial };
}

function fact(partial: Partial<Fact> & Pick<Fact, "key" | "type" | "value">): Fact {
  return { id: "f1", question: partial.key, complete: false, source: "user", evidence: null, ...partial };
}

function sheetOf(...facts: Fact[]): FactSheet {
  const withIds = facts.map((f, i) => ({ ...f, id: `f${i + 1}` }));
  return { facts: withIds, byKey: new Map(withIds.map((f) => [f.key, f])), byId: new Map(withIds.map((f) => [f.id, f])) };
}

const c = (partial: Partial<Classification>): Classification => ({ kind: "fact", factKey: "x.y", ...partial });

const PROVIDERS = ["OpenAI", "Anthropic", "Llama", "Gemini", "Mistral", "DeepSeek", "Other", "None"];
const providersField = field({ label: "Have you used any of the following LLM providers professionally?", control: "checkbox", options: PROVIDERS, multi: true });

describe("fact sheet", () => {
  it("states resume tools with evidence, and never reads the English word 'go' as Go", () => {
    const names = resumeTools(RESUME).map((t) => t.name);
    assert.ok(names.includes("Node.js") && names.includes("Kafka") && names.includes("AWS"));
    assert.ok(!names.includes("Go"));
    assert.ok(resumeTools("Golang services").some((t) => t.name === "Go"));
    assert.ok(resumeTools("Skills: TypeScript, Go, SQL").some((t) => t.name === "Go"));
    assert.ok(!resumeTools("JavaScript only").some((t) => t.name === "Java"));
  });

  it("lets your stored answers win over derived facts", () => {
    const sheet = buildFactSheet({
      profile,
      resumeText: RESUME,
      stored: [{ key: "skill.nodejs.professional", question: "Node?", type: "boolean", value: false, complete: false, source: "user", evidence: null }],
    });
    assert.equal(sheet.byKey.get("skill.nodejs.professional")?.value, false);
    assert.equal(sheet.byKey.get("skill.kafka.professional")?.value, true);
    assert.equal(sheet.byKey.get("skills.professional")?.complete, false);
    assert.equal(sheet.byKey.get("experience.total_years")?.value, 4);
  });

  it("gives every skill the total years except the .NET family, which is 0 and not used", () => {
    const stored = (key: string, value: number) => ({ key, question: key, type: "number", value, complete: false, source: "user", evidence: null });
    const sheet = buildFactSheet({
      profile,
      resumeText: RESUME,
      stored: [stored("skill.dotnet.years", 4), stored("skill.azure_ai_foundry.years", 0), stored("skill.vue.years", 4), stored("skill.sap_applications.years", 1)],
    });
    assert.equal(sheet.byKey.get("skill.dotnet.years")?.value, 0);
    assert.equal(sheet.byKey.get("skill.dotnet.professional")?.value, false);
    assert.equal(sheet.byKey.get("skill.azure_ai_foundry.years")?.value, 4);
    assert.equal(sheet.byKey.get("skill.vue.years")?.value, 4);
    assert.equal(sheet.byKey.get("skill.sap_applications.years")?.value, 4);
    assert.ok(!(sheet.byKey.get("skills.professional")?.value as string[]).includes("dotnet"));
  });

  it("coerces values to their type or refuses them", () => {
    assert.equal(coerceFactValue("boolean", "Yes, daily"), true);
    assert.equal(coerceFactValue("boolean", "maybe"), null);
    assert.equal(coerceFactValue("number", "4"), 4);
    assert.deepEqual(coerceFactValue("list", "OpenAI, Anthropic\nOpenAI"), ["OpenAI", "Anthropic"]);
    assert.equal(coerceFactValue("text", "  "), null);
  });

  it("matches items across spellings but not Java to JavaScript", () => {
    assert.ok(itemMatches("Node", "Node.js"));
    assert.ok(itemMatches("AWS", "Amazon Web Services (AWS)"));
    assert.ok(itemMatches("Claude", "Anthropic"));
    assert.ok(!itemMatches("Java", "JavaScript"));
  });
});

describe("projecting a fact onto a question", () => {
  it("answers yes/no from a boolean and from a list item", () => {
    const yn = field({ label: "Do you have Node.js experience?", options: ["Yes", "No"] });
    const res = projectFact(fact({ key: "skill.nodejs.professional", type: "boolean", value: true }), yn, c({}));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "option", value: "Yes" });
    const list = fact({ key: "skills.professional", type: "list", value: ["TypeScript", "Node.js"] });
    assert.deepEqual(projectFact(list, yn, c({ item: "Node" })).kind, "answer");
  });

  it("says unknown, not No, for an item missing from an open list", () => {
    const yn = field({ label: "Have you used Python professionally?", options: ["Yes", "No"] });
    const open = fact({ key: "skills.professional", type: "list", value: ["TypeScript"] });
    assert.equal(projectFact(open, yn, c({ item: "Python" })).kind, "unknown");
    const complete = { ...open, complete: true };
    const res = projectFact(complete, yn, c({ item: "Python" }));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "option", value: "No" });
  });

  it("ticks exactly the providers a complete list names, never all of them", () => {
    const providers = fact({ key: "llm_providers.professional", type: "list", value: ["Anthropic", "OpenAI"], complete: true });
    const res = projectFact(providers, providersField, c({ factKey: "llm_providers.professional" }));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "options", values: ["Anthropic", "OpenAI"] });
  });

  it("ticks only the known providers of a partly known list, and is unknown when none are offered", () => {
    const open = fact({ key: "llm_providers.professional", type: "list", value: ["Anthropic"] });
    const res = projectFact(open, providersField, c({}));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "options", values: ["Anthropic"] });
    const unoffered = fact({ key: "llm_providers.professional", type: "list", value: ["Cohere"] });
    assert.equal(projectFact(unoffered, providersField, c({})).kind, "unknown");
    assert.equal(projectFact(undefined, providersField, c({})).kind, "unknown");
  });

  it("uses None only for an empty complete list, and Other for items not offered", () => {
    const none = fact({ key: "llm_providers.professional", type: "list", value: [], complete: true });
    const res = projectFact(none, providersField, c({}));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "options", values: ["None"] });
    const extra = fact({ key: "llm_providers.professional", type: "list", value: ["Cohere", "OpenAI"], complete: true });
    const res2 = projectFact(extra, providersField, c({}));
    assert.deepEqual(res2.kind === "answer" && res2.action, { type: "options", values: ["OpenAI", "Other"] });
  });

  it("respects 'choose up to three'", () => {
    assert.equal(choiceLimit("Pick your areas (choose up to three)"), 3);
    const areas = field({ label: "Areas (choose up to two)", control: "checkbox", options: ["Backend", "Frontend", "Infra", "Data"], multi: true });
    const all = fact({ key: "experience.areas", type: "list", value: ["Backend", "Infra", "Data"], complete: true });
    const res = projectFact(all, areas, c({}));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "options", values: ["Backend", "Infra"] });
  });

  it("puts years into the right bucket and answers 'N+ years' questions", () => {
    assert.deepEqual(parseRange("3-5 years"), { min: 3, max: 5 });
    const buckets = field({ label: "Years of experience", control: "select", options: ["0-2 years", "3-5 years", "5+ years"] });
    const years = fact({ key: "experience.total_years", type: "number", value: 4 });
    const res = projectFact(years, buckets, c({}));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "option", value: "3-5 years" });
    const yn = field({ label: "Do you have 5+ years?", options: ["Yes", "No"] });
    const res2 = projectFact(years, yn, c({ atLeast: 5 }));
    assert.deepEqual(res2.kind === "answer" && res2.action, { type: "option", value: "No" });
  });

  it("hands a text fact with no exact option to the picker, and types it into a text box", () => {
    const select = field({ control: "select", options: ["Indian", "German"] });
    assert.equal(projectFact(fact({ key: "profile.nationality", type: "text", value: "India" }), select, c({})).kind, "pick");
    const box = field({ control: "text", freeText: false });
    const res = projectFact(fact({ key: "profile.zipcode", type: "text", value: "122022" }), box, c({}));
    assert.deepEqual(res.kind === "answer" && res.action, { type: "literal", value: "122022" });
  });

  it("recognises yes/no choices in other words", () => {
    assert.deepEqual(yesNoOptions(["Yes, I do", "No, I don't"]), { yes: "Yes, I do", no: "No, I don't" });
    assert.equal(yesNoOptions(["Remote", "Hybrid", "Office"]), null);
  });
});

describe("classification replies", () => {
  it("drops malformed keys and keeps written questions keyless", () => {
    const yn = field({ options: ["Yes", "No"] });
    assert.equal(cleanClassification({ kind: "fact", factKey: "Python Skills!" }, yn, emptyFactSheet(), null).factKey, null);
    assert.equal(cleanClassification({ kind: "written", factKey: "a.b" }, yn, emptyFactSheet(), null).factKey, null);
    const ok = cleanClassification({ kind: "fact", factKey: "skill.python.professional", item: "Python" }, yn, emptyFactSheet(), "m");
    assert.equal(ok.type, "boolean");
    assert.equal(ok.item, "Python");
  });

  it("turns employer questions into a list of companies", () => {
    const yn = field({ label: "Have you worked at GitLab before?", options: ["Yes", "No"] });
    const res = cleanClassification({ kind: "fact", factKey: "employment.employers", type: "boolean", employer: true, item: "GitLab" }, yn, emptyFactSheet(), null);
    assert.equal(res.type, "list");
    assert.equal(res.employer, true);
    assert.equal(res.item, undefined);
  });

  it("keeps a startup yes/no as Yes/No when the model calls it a list", () => {
    const yn = field({ label: "Have you ever worked in a startup?", options: ["Yes", "No"] });
    const res = cleanClassification({ kind: "fact", factKey: "experience.startup_experience", type: "list", item: "Yes\nNo" }, yn, emptyFactSheet(), null);
    assert.equal(res.type, "boolean");
    assert.equal(res.item, undefined);
  });

  it("keeps a years question with its bands as one answer", () => {
    const bands = ["I've never worked remotely", "Less than 2 years", "2 to 4 years", "More than 4 years"];
    const radio = field({ label: "How long have you been working remotely?", options: bands });
    assert.equal(cleanClassification({ kind: "fact", factKey: "experience.remote_years", type: "list" }, radio, emptyFactSheet(), null).type, "text");
    const select = field({ control: "select", options: bands });
    assert.equal(cleanClassification({ kind: "fact", factKey: "experience.remote_years", type: "list" }, select, emptyFactSheet(), null).type, "text");
  });

  it("keeps a list for real multi-checkbox choices", () => {
    const multi = field({ label: "Which clouds have you used?", control: "checkbox", multi: true, options: ["AWS", "GCP", "Azure"] });
    assert.equal(cleanClassification({ kind: "fact", factKey: "cloud_providers.professional", type: "list" }, multi, emptyFactSheet(), null).type, "list");
  });

  it("caches by wording and choices, per company only when the label names it", () => {
    const a = questionKey({ label: "Have you used Python?", options: ["Yes", "No"] }, "Acme");
    assert.equal(a, questionKey({ label: "Have you used Python?", options: ["No", "Yes"] }, "Other Co"));
    const named = questionKey({ label: "Why Acme?", options: [] }, "Acme");
    assert.notEqual(named, questionKey({ label: "Why Acme?", options: [] }, "Other Co"));
  });
});

describe("list questions with nothing to tick", () => {
  const keys = { fingerprint: "f", genericKey: "g" };
  const listAsk = (f: FieldDescriptor) =>
    ({ kind: "ask", reason: "no fact", keys, field: f, fact: { key: "llm_providers.professional", question: "Which LLM providers?", type: "list" } }) as const;

  it("parks instead of asking with only None of these", () => {
    const res = parkUnreadableList(listAsk(field({ label: "Which have you designed?", control: "checkbox", options: ["None of the above"] })), emptyFactSheet());
    assert.equal(res.kind, "park");
    assert.match(res.kind === "park" ? res.reason : "", /^Could not read the choices for: Which have you designed\?/);
  });

  it("asks when the form or the file has real choices", () => {
    const multi = field({ control: "checkbox", multi: true, options: ["OpenAI", "Anthropic", "None of these"] });
    assert.equal(parkUnreadableList(listAsk(multi), emptyFactSheet()).kind, "ask");
    const onFile = sheetOf(fact({ key: "llm_providers.professional", type: "list", value: ["OpenAI"] }));
    assert.equal(parkUnreadableList(listAsk(field({ control: "radio", options: ["Yes", "No"] })), onFile).kind, "ask");
  });
});

describe("modal answers", () => {
  it("never stores None or Other as list items", () => {
    assert.deepEqual(answerToFactValue("OpenAI\nNone of these\nOther\nAnthropic", "list"), ["OpenAI", "Anthropic"]);
    assert.equal(answerToFactValue(" Yes ", "boolean"), "Yes");
  });
});

describe("resume facts", () => {
  it("keeps only facts whose quote is in the resume", () => {
    const facts = verifiedResumeFacts(
      [
        { key: "skill.nodejs.professional", type: "boolean", value: true, quote: "backend platforms using Node.js, Kafka" },
        { key: "skill.python.professional", type: "boolean", value: true, quote: "Python pipelines" },
        { key: "Bad Key", type: "boolean", value: true, quote: "Fello" },
      ],
      RESUME,
    );
    assert.deepEqual(facts.map((f) => f.key), ["skill.nodejs.professional"]);
  });
});

describe("written answers", () => {
  it("must cite real fact ids", () => {
    const sheet = sheetOf(fact({ key: "background.item_1", type: "text", value: "Built Vivaahli" }));
    assert.equal(citedFacts({ text: "x", uses: [] }, sheet), null);
    assert.equal(citedFacts({ text: "x", uses: ["f1", "f9"] }, sheet), null);
    assert.equal(citedFacts({ text: "x", uses: ["f1"] }, sheet)?.length, 1);
  });

  it("rejects a draft that skips a part of the question or miscasts a project", () => {
    const missed = parseReview({ unsupported: [], missed: ["evaluation is neither answered nor admitted", "AniReco described as an agent"] });
    const errors = reviewErrors(missed);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].startsWith("does not answer the question"));
    assert.ok(errors[0].includes("AniReco"));
    assert.deepEqual(reviewErrors(parseReview({ unsupported: [], missed: [] })), []);
    assert.equal(reviewErrors(parseReview({ unsupported: ["led 10 engineers"], missed: [] })).length, 1);
  });

  it("ignores flags that only reword the cited facts", () => {
    const facts = BACKGROUND_FACTS.join("\n");
    for (const claim of [
      "re-architected multi-category checkout across 7+ microservices",
      "worked across 7+ microservices",
      "The challenge [with Vivaahli] was owning every layer alone with no team to catch gaps",
      "The challenge with Vivaahli was owning every layer alone",
      "That system served real consumer traffic across a large user base",
      "led a team of 3 on the money-flow stack at Urban Company, so I owned the reliability of that layer",
      "serving a large consumer base across India",
      "under concurrent load",
      "Both systems had to hold up under high concurrent transaction volumes in production.",
      "lifted homepage engagement 13.7% (f3)",
    ]) {
      assert.equal(isWordingOnlyFlag(claim, facts), true, claim);
    }
    const review = dropWordingFlags({ unsupported: ["worked across 7+ microservices", "led 10 engineers"], missed: [] }, facts);
    assert.deepEqual(review.unsupported, ["led 10 engineers"]);
  });

  it("keeps flags that add a number, a tool or an effect", () => {
    const facts = BACKGROUND_FACTS.join("\n");
    const ourmoney = BACKGROUND_FACTS.find((f) => f.startsWith("ourmoney")) ?? "";
    assert.equal(isWordingOnlyFlag("built ourmoney using LLMs", ourmoney), false);
    for (const claim of [
      "led 10 engineers",
      "Vivaahli has 10000 paying users",
      "cut checkout latency by 40%",
      "built the checkout on Kubernetes",
      "which caught regressions before release",
      "worked with Stripe at Urban Company",
    ]) {
      assert.equal(isWordingOnlyFlag(claim, facts), false, claim);
    }
  });

  it("fails closed when the checker reply is not a review", () => {
    assert.throws(() => parseReview({ unsupported: [] }));
    assert.throws(() => parseReview(null));
  });
});

describe("pre-submit audit", () => {
  const sheet = sheetOf(fact({ key: "llm_providers.professional", type: "list", value: PROVIDERS.slice(0, 6), complete: true }));
  const shown = (partial: Partial<Readback>): Readback => ({
    id: "q1",
    label: providersField.label,
    value: "",
    control: "checkbox",
    options: PROVIDERS,
    freeText: false,
    checked: [],
    ...partial,
  });
  const intent = (partial: Partial<FillIntent>): Map<string, FillIntent> =>
    new Map([["q1", { field: providersField, action: { type: "options", values: ["OpenAI"] }, source: "fact", grounds: [], ...partial }]]);

  it("passes when the page shows exactly what was chosen", () => {
    assert.deepEqual(auditPage({ intents: intent({}), shown: [shown({ checked: ["OpenAI"], value: "OpenAI" })], facts: sheet, profile }), []);
  });

  it("catches a checkbox set that differs from the intent", () => {
    const problems = auditPage({ intents: intent({}), shown: [shown({ checked: ["OpenAI", "Anthropic"] })], facts: sheet, profile });
    assert.equal(problems.length, 1);
  });

  it("catches None ticked with others and every box ticked without a complete list", () => {
    const all = auditPage({ intents: new Map(), shown: [shown({ checked: PROVIDERS })], facts: emptyFactSheet(), profile });
    assert.ok(all.some((p) => p.includes("None")));
    assert.ok(all.some((p) => p.includes("every choice")));
  });

  it("rejects a model answer to a choice and a written answer with no citations", () => {
    const model = auditPage({ intents: intent({ source: "cheap_model" }), shown: [shown({ checked: ["OpenAI"] })], facts: sheet, profile });
    assert.ok(model.some((p) => p.includes("without a fact")));
    const essay = field({ id: "q2", label: "Why this role?", control: "textarea", freeText: true });
    const written = auditPage({
      intents: new Map([["q2", { field: essay, action: { type: "compose", text: "I built X." }, source: "cheap_model", grounds: [] }]]),
      shown: [{ id: "q2", label: essay.label, value: "I built X.", control: "textarea", options: [], freeText: true, checked: null }],
      facts: sheet,
      profile,
    });
    assert.ok(written.some((p) => p.includes("cites no facts")));
  });

  it("flags a paragraph in a short field and tolerates a reformatted phone number", () => {
    const long = auditPage({
      intents: new Map(),
      shown: [{ id: "q3", label: "City", value: "x".repeat(200), control: "text", options: [], freeText: false, checked: null }],
      facts: sheet,
      profile,
    });
    assert.equal(long.length, 1);
    const phone = field({ id: "q4", label: "Phone", control: "text" });
    const ok = auditPage({
      intents: new Map([["q4", { field: phone, action: { type: "profile", key: "phone" }, source: "heuristic", grounds: [] }]]),
      shown: [{ id: "q4", label: "Phone", value: "+91 (900) 000-0000", control: "text", options: [], freeText: false, checked: null }],
      facts: sheet,
      profile,
    });
    assert.deepEqual(ok, []);
  });

  it("parks a nationality or residence answer that is not the home country", () => {
    const countries = ["Afghanistan", "Bangladesh", "British Indian Ocean Territory", "India"];
    const nationality = (value: string): Readback => ({
      id: "q5", label: "1. What is your nationality?*", value, control: "select", options: countries, freeText: false, checked: null,
    });
    const audit = (s: Readback) => auditPage({ intents: new Map(), shown: [s], facts: sheet, profile });
    assert.ok(audit(nationality("Bangladesh")).some((p) => p.includes("not India")));
    assert.ok(audit(nationality("British Indian Ocean Territory")).some((p) => p.includes("not India")));
    assert.deepEqual(audit(nationality("India")), []);
    const residence = { id: "q6", label: "Country of residence", value: "Germany", control: "text" as const, options: [], freeText: false, checked: null };
    assert.equal(audit(residence).length, 1);
    assert.deepEqual(audit({ ...residence, label: "Nationality", value: "Indian" }), []);
  });

  it("accepts a city typeahead pick that uses the old spelling plus the state", () => {
    const city = field({ id: "q7", label: "What city do you live in?", control: "combobox" });
    const ok = auditPage({
      intents: new Map([
        ["q7", { field: city, action: { type: "option", value: "Gurugram, India" }, source: "heuristic", grounds: [] }],
      ]),
      shown: [
        {
          id: "q7",
          label: city.label,
          value: "Gurgaon, Haryana, India",
          control: "combobox",
          options: [],
          freeText: false,
          checked: null,
        },
      ],
      facts: sheet,
      profile,
    });
    assert.deepEqual(ok, []);
  });
});

describe("contradiction check filter", () => {
  it("drops city aliases, phone formats and job-country visa answers", () => {
    assert.equal(isFalseContradiction("Location 'Gurgaon, Haryana, India' contradicts facts 'Gurugram'"), true);
    assert.equal(isFalseContradiction("Visa Sponsorship 'Yes' contradicts fact 'What is your U.S. work authorization'"), true);
    assert.equal(isFalseContradiction("The answer to 'Phone number' is '06386259889', but the answer elsewhere is +91 6386259889"), true);
  });

  it("drops overlapping skill years against total years", () => {
    assert.equal(
      isFalseContradiction(
        "The applicant claims 4 years of total professional software experience (f13) but lists 4 years of experience for each of the following: Agentic AI (f91), Azure (f95), which is mathematically impossible to have accumulated simultaneously",
      ),
      true,
    );
    assert.equal(
      isFalseContradiction("The applicant claims 4 years of professional experience but also claims 4 years in many specific technologies simultaneously"),
      true,
    );
  });

  it("drops the batch that parked jobs for nothing", () => {
    const dropped = [
      "The applicant states their current employer is N/A (f10), but also states their current employer is Fello (f41).",
      "The current job start date (02/2026) is in the future relative to the current date.",
      "The applicant states they are available to start immediately (f84) but also states their current job started in 02/2026 (f42).",
      "The applicant states their expected salary is 70000 EUR/year, but their expected salary in India is 4200000 INR.",
      "Current Location: Other, but facts state where you live is Gurugram, India (f4).",
      "Current location is Gurugram, Haryana, IND (answer) but city you live in is Gurugram (f5)",
      "The applicant claims 4 years of experience in multiple technologies (Agentic AI, Azure) while having only 4 years of total professional software experience, which implies they have used every single one of these tools for the entire duration of their career.",
    ];
    for (const p of dropped) assert.equal(isFalseContradiction(p), true, p);
  });

  it("drops the October 11 batch", () => {
    const dropped = [
      "The applicant states they are in India (answer to 'What is your location?'), which is consistent with their current location and the job location.",
      "The start date year is 2018, but the total years of professional software experience is 4. This implies the applicant started in 2022, which contradicts the start date year.",
      "The applicant states they have 4 years of experience in Azure Ai Foundry (f96), but also states 0 years of experience in Azure Ai Foundry (f96).",
      "The applicant stated they have 4 years of experience in Azure Ai Foundry, but also stated 0 years of experience in Azure Ai Foundry.",
      "The applicant claims 4 years of experience in Agentic AI, Azure, Claude Code, .NET, Generative AI, Golang, gRPC, LangGraph, Microservices, React.js, SAP Applications, and Vue.js, but the total professional software experience is only 4 years, which contradicts the claim that these are all separate 4-year experiences.",
      "Are you currently in Pune or ready to relocate to Pune?: Yes contradicts Location: Gurgaon, Haryana, India (f4, f5, f6, f77, f87)",
      "Are you able to work in the office listed on the job description? Yes contradicts Which office would you be based in?: Berlin (f75)",
      "The answer to \"How did you hear about ElevenLabs?\" is \"Other (please specify)\" but the facts do not contain any specification for this \"Other\" option.",
      "The answer to \"What's the most impactful thing you've built? What was your specific contribution?\" mentions building Vivaahli solo end to end, but the facts state that the applicant led a team of 3 on the money-flow stack at Urban Company.",
      "The start date is 10/18/2026, but the applicant's availability is one week after applying (2026-10-11), which is 7 days before the stated start date.",
      "The applicant states they are not authorized to work in Germany, but they are willing to move to Munich for the role.",
      "The answer to 'How did you know it worked? What did success actually look like?' mentions shipping AniReco and shutting it down because unit economics did not work, which contradicts fact f24 stating that AniReco was shut down because the unit economics did not work, and fact f25 stating the portfolio is https://anireco.app/.",
    ];
    for (const p of dropped) assert.equal(isFalseContradiction(p), true, p);
  });

  it("drops .NET at 0 next to the career total and self-cleared problems", () => {
    const p =
      "Years of professional software experience: 4, but years of experience in .NET / C#: 0 and have you used .NET / C# professionally?: No. These do not contradict, as 0 years is a valid amount of experience.";
    assert.equal(isFalseContradiction(p), true);
    assert.equal(isFalseContradiction("Years of professional software experience: 4, but years of experience in .NET / C#: 0"), true);
    assert.equal(isFalseContradiction("Have you used .NET professionally?: Yes, but years of experience in .NET: 0"), false);
  });

  it("drops the October 12 batch", () => {
    const dropped = [
      "The applicant states they prefer not to answer their ethnicity, but the facts state they are Asian (f30).",
      "The applicant states their race as 'Decline to self-identify', but the facts state Asian.",
      "The applicant states their gender identity is Man, but their pronouns are he/him/his.",
      "Can you join within 15 days? Yes contradicts notice period of 0 days (f12).",
      "Are you comfortable working from Bangalore? contradicts where you live: Gurugram (f5).",
      "Are you comfortable with a 6-month contractual role? contradicts the applicant's full-time background.",
      "The applicant claims 4 years of professional experience (f13) but also claims 4 years of experience in specific technologies like Agentic AI (f95), Azure (f99), Golang (f106), which exceeds the total professional experience duration.",
      "Years of professional software experience: 4, but has 0 years of experience in software system operations.",
      "The applicant's expected salary is 70000, but the currency is not specified.",
      "The answer omits the 13.7% engagement figure, which is fine, but the facts mention it.",
      "The applicant's current job search status is \"いいところがあれば転職を検討する\" which translates to \"Considering changing jobs if there is a good place\", but the applicant also states they are \"Unemployed\".",
    ];
    for (const p of dropped) assert.equal(isFalseContradiction(p), true, p);
  });

  it("reads a date the form reformatted as the date typed", () => {
    assert.equal(sameText("10/18/2026", "2026-10-18"), true);
    assert.equal(sameText("18.10.2026", "2026-10-18"), true);
    assert.equal(sameText("10/19/2026", "2026-10-18"), false);
  });

  it("keeps a side-project claim with a figure not on file", () => {
    assert.equal(isFalseContradiction("The answer says Vivaahli has 10000 paying users, but the facts state 250+ paid biodatas."), false);
    assert.equal(
      isFalseContradiction("The answer states professional experience with Gemini or open-source models, but the facts do not mention them."),
      false,
    );
  });

  it("keeps real conflicts", () => {
    assert.equal(
      isFalseContradiction(
        "The answer to 'Do you have at least 6 months of experience using AI-assisted development tools' is a URL (GitHub profile) instead of a confirmation of experience.",
      ),
      true,
    );
    assert.equal(isFalseContradiction("The applicant's LinkedIn URL and Twitter URL are the same."), false);
    assert.equal(isFalseContradiction("0 years of Python next to 'Yes, I use Python professionally'"), false);
    assert.equal(isFalseContradiction("Expected CTC 4,200,000 contradicts Expected salary in India: 4000000"), false);
    assert.equal(
      isFalseContradiction("Current Compensation: 3500000 (fact f115) contradicts 3500000 (answer to Current Compensation)"),
      true,
    );
    assert.equal(isFalseContradiction("The applicant claims 6 years of Go, which exceeds the 4 years of total professional experience."), false);
    assert.equal(isFalseContradiction("Which backend languages are you proficient in? lists MongoDB and Redis, which are not languages."), false);
    assert.equal(
      isFalseContradiction(
        'The applicant states their English proficiency is "Proficient User (TOEIC 875 above)" but the fact [language.english.level] states "Native or bilingual".',
      ),
      true,
    );
    assert.equal(
      isFalseContradiction("Years of professional software experience: 4, Please briefly describe a production incident you owned."),
      true,
    );
  });

  it("drops a leftover fact that this form never asked", () => {
    const answers = [
      { label: "Full name", value: "Khushal Sahni" },
      { label: "Current location", value: "Gurugram, Haryana, IND" },
    ];
    assert.equal(
      contradictionAboutUnaskedTopic("The applicant claims 4 years of experience in US GAAP (ASC 606).", answers),
      true,
    );
    assert.equal(
      contradictionAboutUnaskedTopic("The applicant claims 4 years of experience in SAP Applications.", [
        { label: "Which of the following have you personally done?", value: "Built AI/LLM-powered applications" },
      ]),
      true,
    );
    assert.equal(
      contradictionAboutUnaskedTopic("The applicant claims 6 years of experience in Go.", [
        { label: "Years of Go", value: "4" },
      ]),
      false,
    );
  });
});

describe("company questions never reach the modal", () => {
  const keys = { fingerprint: "fp", genericKey: "gk" };
  const ask = (label: string, reason = "not tied to a fact", factQuestion?: string) =>
    parkCompanyAsk(
      {
        kind: "ask",
        reason,
        keys,
        field: field({ label }),
        ...(factQuestion ? { fact: { key: "x.y", question: factQuestion, type: "boolean" as const } } : {}),
      },
      "Almedia",
    ).kind;

  it("parks prompts that name or are about this employer", () => {
    assert.equal(ask("Which Almedia office would you prefer?"), "park");
    assert.equal(ask("Why do you want to join us?"), "park");
    assert.equal(ask("Have you interviewed here before? (list dates)", "question about this employer"), "fill");
    assert.equal(ask("Do you use Almedia's SDK?", "no data", "Do you use Almedia's SDK?"), "fill");
  });

  it("keeps facts for later jobs and place-scoped questions", () => {
    assert.equal(ask("Do you use Almedia's Go services?", "no data", "Have you used Go professionally?"), "ask");
    assert.equal(ask("Notice period"), "ask");
    assert.equal(ask("Do you need sponsorship to work at Almedia? (job in Berlin)", "work authorization for this location"), "ask");
  });
});
