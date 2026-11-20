import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { ResolveContext } from "./context";
import { buildFactSheet, projectFact, type StoredFact } from "./facts";
import { buildProfileValues, knownOption } from "./profile-map";
import { firstAnswer, noticeDays, noticeOption, standingAnswer, type Standing } from "./standing";
import type { FieldDescriptor } from "./types";

let needsSponsorship: typeof import("./vendors/workday").needsSponsorship;
let salaryCurrency: typeof import("./resolve").salaryCurrency;
let salaryForLabel: typeof import("./resolve").salaryForLabel;
let resolveField: typeof import("./resolve").resolveField;
let staleProfileRecipe: typeof import("./resolve").staleProfileRecipe;
let staleShownValue: typeof import("./resolve").staleShownValue;
let chooseOption: typeof import("./choose-option").chooseOption;

before(async () => {
  // The Workday applier imports the Prisma client, which needs a URL to construct; no query runs here.
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/unused";
  ({ needsSponsorship } = await import("./vendors/workday"));
  ({ salaryCurrency, salaryForLabel, resolveField, staleProfileRecipe, staleShownValue } = await import("./resolve"));
  ({ chooseOption } = await import("./choose-option"));
});

const profile = buildProfileValues(
  {
    firstName: "Khushal",
    lastName: "Sahni",
    email: "k@example.com",
    phone: "+91 90000 00000",
    location: "Gurugram, India",
    linkedInUrl: "",
    githubUrl: "",
    portfolioUrl: "",
    currentCompany: "N/A",
    noticePeriod: "0",
    expectedCtc: "4200000",
    resumeSummary: "",
  },
  4,
);

const stored: StoredFact[] = [
  { key: "relocation.willingness", question: "Willing to move?", type: "boolean", value: true, complete: false, source: "user", evidence: null },
  { key: "skill.ai_coding_tools.daily", question: "AI tools daily?", type: "boolean", value: true, complete: false, source: "user", evidence: null },
  { key: "skill.kafka.professional", question: "Kafka?", type: "boolean", value: true, complete: false, source: "user", evidence: null },
  { key: "profile.pronouns", question: "Pronouns?", type: "text", value: "He/him", complete: false, source: "user", evidence: null },
  { key: "profile.date_of_birth", question: "Date of birth?", type: "text", value: "10/09/2000", complete: false, source: "user", evidence: null },
  { key: "profile.current_salary_inr", question: "Current CTC?", type: "number", value: 3500000, complete: false, source: "user", evidence: null },
];

const facts = buildFactSheet({ profile, stored, resumeText: "Node.js, TypeScript, MongoDB, Redis, AWS, C++, SQL" });

function ctx(job?: ResolveContext["job"]): ResolveContext {
  return { vendor: "greenhouse", company: "Okta", jobTitle: "Backend Engineer", profile, facts, voiceSamples: [], job };
}

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return { id: "f1", label: "Question", control: "radio", options: [], required: true, maxLength: null, freeText: false, ...partial };
}

const YES_NO = ["Yes", "No"];
const BANGALORE_POLAND = { country: "IN", location: "Bangalore, India; Remote, Poland", remoteScope: null };

function value(res: Standing | null): string | string[] | null {
  if (!res || res.kind !== "fill") return null;
  const a = res.action;
  return a.type === "option" || a.type === "literal" ? a.value : a.type === "options" ? a.values : null;
}

describe("standing answers to the questions that used to reach the modal", () => {
  it("acknowledges policy boxes whose only choice is Acknowledged", () => {
    for (const label of ["[Document Policy]*", "[For more information]*"]) {
      assert.equal(value(standingAnswer(field({ label, control: "combobox", options: ["Acknowledged"] }), ctx())), "Acknowledged");
    }
  });

  it("never opts into marketing", () => {
    const sms = field({ label: "I agree to receive SMS updates", control: "checkbox", options: ["I agree"] });
    assert.equal(standingAnswer(sms, ctx()), null);
  });

  it("confirms a PDF-resume-only instruction", () => {
    const label =
      "Please only submit a PDF version of your resume above. Submitting .doc, .pages, or other formats will not be reviewed.";
    assert.deepEqual(standingAnswer(field({ label, control: "checkbox", options: [] }), ctx()), {
      kind: "fill",
      action: { type: "options", values: [""] },
    });
    assert.equal(value(standingAnswer(field({ label, options: YES_NO }), ctx())), "Yes");
  });

  it("checks interview recording consent when the scan left no option text", () => {
    const res = standingAnswer(field({ label: "Interview Recording Consent", control: "checkbox", options: [] }), ctx());
    assert.deepEqual(res, { kind: "fill", action: { type: "options", values: [""] } });
    assert.deepEqual(
      standingAnswer(
        field({
          label: "Interview Recording Consent",
          control: "checkbox",
          options: ["I have read the Interview Recording Consent", "I do not agree"],
        }),
        ctx(),
      ),
      { kind: "fill", action: { type: "options", values: ["I have read the Interview Recording Consent"] } },
    );
  });

  it("fills date of birth from the stored fact", () => {
    assert.equal(value(standingAnswer(field({ label: "Date of Birth*", control: "text" }), ctx())), "10/09/2000");
  });

  it("says No to public office, relatives at the company, and a job never held there", () => {
    const gov = field({
      label: "1. Are you currently, or have you been a government official, public servant, or employee of a public institution who may be subject to post-employment restrictions? *",
      control: "combobox",
      options: YES_NO,
    });
    assert.equal(value(standingAnswer(gov, ctx())), "No");
    const relatives = field({ label: "To the best of your knowledge, do you have any family members / relatives or personal relationships working at Okta?", options: YES_NO });
    assert.equal(value(standingAnswer(relatives, ctx())), "No");
    const worked = field({ label: "Have you previously worked for Okta?", options: YES_NO });
    assert.equal(value(standingAnswer(worked, ctx())), "No");
    const uc = field({ label: "Have you previously worked at Urban Company?", options: YES_NO });
    assert.equal(value(standingAnswer(uc, { ...ctx(), company: "Urban Company" })), "Yes");
    assert.equal(
      value(standingAnswer(field({ label: "Have you worked at DoorDash?", options: YES_NO }), { ...ctx(), company: "doordashindia" })),
      "No",
    );
    assert.equal(
      value(
        standingAnswer(
          field({ label: "Are you currently or have you ever been employed by Rubrik or contracted to provide services?", options: YES_NO }),
          { ...ctx(), company: "rubrik" },
        ),
      ),
      "No",
    );
    assert.equal(
      value(
        standingAnswer(field({ label: "Have you ever worked for Scopely Inc. or a subsidiary or affiliate in the past?", options: YES_NO }), {
          ...ctx(),
          company: "scopely",
        }),
      ),
      "No",
    );
    assert.equal(
      value(
        standingAnswer(field({ label: "Do you have current or former government work experience including military service?", options: YES_NO }), ctx()),
      ),
      "No",
    );
    assert.equal(
      value(standingAnswer(field({ label: "Are you a current ConnectWise user?", options: YES_NO }), { ...ctx(), company: "ConnectWise" })),
      "No",
    );
  });

  it("joins in 15 days on a zero notice period and picks the tightest notice bucket", () => {
    assert.equal(value(standingAnswer(field({ label: "Can you join in 15 days?", options: ["YES", "NO"] }), ctx())), "YES");
    assert.equal(noticeDays("0"), 0);
    assert.equal(noticeDays("2 months"), 60);
    assert.equal(noticeOption(["Serving notice", "15 days or less", "1 month", "More than 2 months"], 0), "15 days or less");
    assert.equal(noticeOption(["Immediate", "15 days or less", "1 month"], 0), "Immediate");
    assert.equal(noticeOption(["0", "15", "30", "60"], 0), "0");
  });

  it("works from a target-country city, says where you live, and answers sponsorship at home", () => {
    assert.equal(value(standingAnswer(field({ label: "Are you comfortable working from Bangalore?", options: ["YES", "NO"] }), ctx())), "YES");
    const based = field({ label: "Are you currently based in Poland or Bangalore, India? *", control: "combobox", options: YES_NO });
    assert.equal(value(standingAnswer(based, ctx(BANGALORE_POLAND))), "No");
    const reside = field({ label: "Do you currently reside in the location specified for this role?*", control: "combobox", options: YES_NO });
    assert.equal(value(standingAnswer(reside, ctx(BANGALORE_POLAND))), "No");
    assert.equal(value(standingAnswer(reside, ctx({ country: "IN", location: "Gurgaon, India", remoteScope: null }))), "Yes");
    assert.equal(value(standingAnswer(reside, ctx({ country: null, location: "Remote - Europe", remoteScope: "europe" }))), "No");
    const visa = field({ label: "Will you now or in the future require sponsorship for a visa to remain in your current location?*", control: "combobox" });
    assert.equal(value(standingAnswer(visa, ctx(BANGALORE_POLAND))), "No");
    const h1b = field({
      label: "Please help us work effectively with our immigration team: Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, STEM OPT, J-1, O-1, TN, etc.)?",
      options: YES_NO,
    });
    assert.equal(value(standingAnswer(h1b, ctx({ country: null, location: "Remote", remoteScope: null }))), "No");
  });

  it("overlaps US hours, takes a 6-month contract and night shifts", () => {
    const hours = field({
      label: "This role works closely with a team based in the United States. It requires working later hours in your time zone so you overlap with US Eastern and Pacific business hours. Are you able to work this schedule on a regular basis? *",
      control: "combobox",
      options: YES_NO,
    });
    assert.equal(value(standingAnswer(hours, ctx())), "Yes");
    assert.equal(value(standingAnswer(field({ label: "Are you comfortable with a 6-month contractual role?", options: YES_NO }), ctx())), "Yes");
    assert.equal(value(standingAnswer(field({ label: "Are you open to rotational shifts?", options: YES_NO }), ctx())), "Yes");
    assert.equal(
      value(standingAnswer(field({ label: "Are you comfortable with taking 1 week on-call rotations once a month?*", options: YES_NO }), ctx())),
      "Yes",
    );
  });

  it("answers the October 11 parks optimistically from the profile", () => {
    const ask = (label: string, partial: Partial<FieldDescriptor> = {}) => value(standingAnswer(field({ label, options: YES_NO, ...partial }), ctx()));
    assert.equal(ask("Are you 18 years of age or older?*"), "Yes");
    assert.equal(ask("Are you currently employed by a client, partner, or competitor of Addepar?*"), "No");
    assert.equal(ask("Have you attended any of our recruiting events?"), "No");
    assert.equal(ask("Have you worked at [Company Name] before?"), "No");
    assert.equal(ask("Are you a veteran?"), "No");
    assert.equal(ask("Were you referred for this position?*"), "No");
    assert.equal(ask("Have you been interviewed for this role in the past 1 year?*"), "No");
    assert.equal(ask("We're incredibly fast-paced. We do whatever it takes to get things done. Would you thrive here?"), "Yes");
    assert.equal(ask("Are you already on Notice period?"), "No");
    assert.equal(ask("Current Company Notice Period (number of days)*", { control: "text", options: [] }), "0");
    assert.equal(ask("Relevant Experience for Applied Role", { control: "text", options: [] }), "4");
    assert.equal(ask("How long do you need before you can start a new role?*", { control: "text", options: [] }), "1 week");
    assert.equal(ask("Where are you currently based in?", { control: "text", options: [] }), "Gurugram, India");
    assert.equal(ask("Where are you currently based in?", { options: ["Germany", "European Union", "Rest of the world"] }), "Rest of the world");
    assert.equal(ask("Please confirm the Country in which you currently reside?*", { control: "combobox", options: ["Germany", "India", "Japan"] }), "India");
    assert.equal(ask("What state are you currently located in? *", { control: "text", options: [] }), "Haryana");
    assert.equal(
      ask('A “U.S. person” is a citizen, legal permanent resident, or legal temporary resident. Are you a U.S. person?'),
      "No",
    );
    assert.equal(
      ask("Are you a U.S. person?", {
        options: ["I am a U.S. person", "I am not a U.S. person"],
      }),
      "I am not a U.S. person",
    );
    assert.equal(
      ask("OFAC: Please indicate whether you are either a citizen or lawful permanent resident of the United States"),
      "No",
    );
    const contact = firstAnswer(field({ label: "Preferred Contact Method*", control: "select", options: ["Email", "Phone", "SMS"] }));
    assert.equal(contact && contact.type === "option" ? contact.value : null, "Email");
    assert.equal(ask("Did you know about Sigmoid before our reach-out?"), "No");
    assert.equal(ask("Do you have at least 6 months of experience using AI-assisted development tools?"), "Yes");
  });

  it("signs a type-your-name box with the full name", () => {
    const sign = standingAnswer(field({ label: "By typing my name below, I confirm the above is true", control: "text" }), ctx());
    assert.deepEqual(sign, { kind: "fill", action: { type: "profile", key: "fullName" } });
  });

  it("claims no level in a spoken language not on file", () => {
    const japanese = field({ label: "Japanese proficiency level", options: ["Native", "Business", "Conversational", "None"] });
    assert.equal(value(standingAnswer(japanese, ctx())), "None");
  });

  it("puts total years in its band and picks the strongest level for known skills", () => {
    const years = field({
      label: "How many years of professional software engineering experience do you have?",
      control: "checkbox",
      multi: true,
      options: ["Less than 2 years", "2–5 years", "More than 5 years"],
    });
    assert.deepEqual(value(standingAnswer(years, ctx())), ["2–5 years"]);
    const rest = field({
      label: "What is your experience level with REST APIs and distributed systems fundamentals?",
      control: "checkbox",
      multi: true,
      options: ["Theoretical knowledge only", "Hands-on experience building in production environments", "None of these"],
    });
    assert.deepEqual(value(standingAnswer(rest, ctx())), ["Hands-on experience building in production environments"]);
    const java = field({
      label: "What is your proficiency level with Java or similar object-oriented programming languages?",
      control: "checkbox",
      multi: true,
      options: ["Intermediate / Familiar", "Strong programming skills", "None of these"],
    });
    assert.deepEqual(value(standingAnswer(java, ctx())), ["None of these"]);
    const agents = field({
      label: "Are you comfortable integrating AI coding agents (e.g., Cursor, Claude Code, Codex) into your daily development workflow?",
      control: "checkbox",
      multi: true,
      options: [
        "Yes, and I can independently validate AI-generated code for production",
        "Yes, but I have never used them in a professional setting",
        "No, I prefer traditional development without AI",
      ],
    });
    assert.deepEqual(value(standingAnswer(agents, ctx())), ["Yes, and I can independently validate AI-generated code for production"]);
    const coinbase = field({
      label: "How often do you use AI tools when writing code?",
      options: ["Never", "Occasionally", "Weekly", "Daily"],
    });
    assert.equal(value(standingAnswer(coinbase, ctx())), "Daily");
  });

  it("answers No to mobile development when later user facts say false", () => {
    const mobileFacts = buildFactSheet({
      profile,
      stored: [
        ...stored,
        { key: "experience.mobile_dev_years", question: "Mobile years?", type: "boolean", value: false, complete: true, source: "user", evidence: null },
        { key: "experience.mobile_apps_shipped", question: "Shipped mobile apps?", type: "boolean", value: false, complete: true, source: "user", evidence: null },
      ],
      resumeText: "Node.js",
    });
    const ask = field({
      label: "Do you have 3+ years of professional mobile development experience in this platform?",
      options: YES_NO,
    });
    assert.equal(value(standingAnswer(ask, { ...ctx(), facts: mobileFacts })), "No");
  });

  it("fails a closed US state list and types Haryana into an empty state box", () => {
    const states = ["Alabama", "California", "New York", "Texas"];
    const closed = standingAnswer(field({ label: "What state are you currently located in?", control: "select", options: states }), ctx());
    assert.equal(closed?.kind, "ineligible");
    assert.equal(
      standingAnswer(
        field({ label: "Which state do you plan on working from as your primary work location?", control: "select", options: states }),
        ctx(),
      )?.kind,
      "ineligible",
    );
    assert.equal(value(standingAnswer(field({ label: "What state are you currently located in?", control: "combobox", options: [] }), ctx())), "Haryana");
  });

  it("parks a group read as only None of these instead of ticking it or asking", () => {
    for (const label of ["Which languages do you speak?*", "In our pursuit of AI-driven advancements, how would you rate your overall familiarity with AI?"]) {
      const res = standingAnswer(field({ label, control: "checkbox", options: ["None of these"] }), ctx());
      assert.equal(res?.kind, "park");
    }
  });

  it("fills gender and pronouns from He/him and declines the rest", () => {
    assert.equal(value(standingAnswer(field({ label: "Gender", control: "select", options: ["Female", "Male", "Decline to self-identify"] }), ctx())), "Male");
    assert.equal(
      value(standingAnswer(field({ label: "What is your title/salutation?", control: "select", options: ["Mr", "Mrs", "Ms"] }), ctx())),
      "Mr",
    );
    assert.equal(
      value(standingAnswer(field({ label: "Type", control: "select", options: ["Home", "Mobile", "Work"] }), ctx())),
      "Mobile",
    );
    assert.equal(
      value(standingAnswer(field({ label: "Type", control: "select", options: ["Personal", "Work"] }), ctx())),
      "Personal",
    );
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "Type",
            control: "select",
            options: ["Personal Mobile/Cell", "Personal Home", "Business Phone"],
          }),
          ctx(),
        ),
      ),
      "Personal Mobile/Cell",
    );
    assert.equal(value(standingAnswer(field({ label: "Type", control: "select", options: ["Home", "Other"] }), ctx())), "Home");
    assert.equal(
      value(standingAnswer(field({ label: "Type", control: "select", options: [] }), ctx())),
      "Mobile",
    );
    const race = field({ label: "Race", control: "select", options: ["Asian", "White", "Decline to self-identify"] });
    assert.equal(value(standingAnswer(race, ctx())), "Decline to self-identify");
    const veteran = field({ label: "Veteran status", control: "select", options: ["I am a protected veteran", "I am not a protected veteran"] });
    assert.equal(value(standingAnswer(veteran, ctx())), "I am not a protected veteran");
  });

  it("gives current CTC in rupees", () => {
    assert.equal(value(standingAnswer(field({ label: "What is your current fixed annual CTC (in INR)?*", control: "text" }), ctx())), "3500000");
  });

  it("falls back to Other when a source list has no LinkedIn or career page", () => {
    assert.equal(knownOption({ label: "How did you hear about us?", options: ["LinkedIn", "Referral", "Other"] }), "LinkedIn");
    assert.equal(knownOption({ label: "How did you hear about us?", options: ["Indeed", "Referral", "Other"] }), "Other");
    assert.equal(knownOption({ label: "Where did Ekumen first catch your eye?", options: ["LinkedIn", "Other"] }), "LinkedIn");
    assert.equal(
      knownOption({ label: "Please select the primary reason.", options: ["Spreetail Employee", "Job board", "Other"] }),
      "Job board",
    );
  });
});

describe("open skill lists", () => {
  it("tick every known tool, including skills you said yes to, and never None or Other", () => {
    const tools = field({
      label: "What tools and languages have you used at work?",
      control: "checkbox",
      multi: true,
      options: ["TypeScript", "Node.js", "Kafka", "Ruby", "Another language", "None of these"],
    });
    const list = facts.byKey.get("skills.professional");
    const res = projectFact(list, tools, { kind: "fact", factKey: "skills.professional" });
    assert.deepEqual(res.kind === "answer" && res.action, { type: "options", values: ["TypeScript", "Node.js", "Kafka"] });
  });
});

const NOW = new Date(2026, 9, 11);

describe("answers that outrank saved ones", () => {
  it("gives a start date a week out, in the shape the control takes", () => {
    assert.deepEqual(firstAnswer(field({ label: "Start date", control: "text" }), NOW), { type: "literal", value: "2026-10-18" });
    assert.deepEqual(firstAnswer(field({ label: "When are you available to start?", control: "textarea" }), NOW), {
      type: "literal",
      value: "2026-10-18",
    });
    const notice = field({ label: "Earliest start date", control: "select", options: ["Immediately", "Within 15 days", "1 month"] });
    assert.deepEqual(firstAnswer(notice, NOW), { type: "option", value: "Within 15 days" });
    const month = field({ label: "Date available to start", control: "select", options: ["September", "October", "November"] });
    assert.deepEqual(firstAnswer(month, NOW), { type: "option", value: "October" });
  });

  it("leaves education and employment dates to the block", () => {
    assert.equal(firstAnswer(field({ label: "Employment — Start date month", control: "select" }), NOW), null);
    assert.equal(firstAnswer(field({ label: "Start date of your current job", control: "text" }), NOW), null);
  });

  it("answers time zone membership from India", () => {
    const tz = (label: string) => firstAnswer(field({ label, options: YES_NO }), NOW);
    assert.deepEqual(tz("Are you in an European time zone?"), { type: "option", value: "No" });
    assert.deepEqual(tz("Are you in an Americas time zone?"), { type: "option", value: "No" });
    assert.deepEqual(tz("Are you in an Asian time zone?"), { type: "option", value: "Yes" });
    assert.equal(tz("Are you willing to work from a European timezone long-term?"), null);
  });

  it("asks to be reached by email only", () => {
    const channels = field({
      label: "How should we communicate with you? *",
      control: "checkbox",
      multi: true,
      options: ["Email", "Phone Call", "Text Message", "WhatsApp"],
    });
    assert.deepEqual(firstAnswer(channels, NOW), { type: "options", values: ["Email"] });
  });

  it("leaves Twitter and extra website boxes empty", () => {
    for (const label of ["Twitter URL", "Twitter/X", "X/Twitter", "Other website"]) {
      assert.deepEqual(firstAnswer(field({ label, control: "text", required: false }), NOW), { type: "skip" }, label);
    }
  });
});

describe("standing answers for the last needs-a-look batch", () => {
  const okta = { ...ctx(), company: "Okta" };
  it("answers employer ties in any word order", () => {
    assert.equal(value(standingAnswer(field({ label: "Have you been employed by Okta, Inc. or any of its subsidiaries in the past?*", options: YES_NO }), okta)), "No");
    const outside = "Do you have any outside business activity(ies) (advisory, consulting, or board roles)?*";
    assert.equal(value(standingAnswer(field({ label: outside, options: YES_NO }), okta)), "No");
    const knows = { ...ctx(), company: "Smartsheet" };
    assert.equal(value(standingAnswer(field({ label: "Do you know anyone who works at Smartsheet?*", options: YES_NO }), knows)), "No");
  });

  it("agrees to a hybrid office in India", () => {
    const label = "This role is a hybrid position based in Bengaluru. Can you fulfill the requirement to work on-site?";
    assert.equal(value(standingAnswer(field({ label, options: YES_NO }), ctx({ country: "IN", location: "Bengaluru", remoteScope: null }))), "Yes");
  });

  it("offers to relocate when the hybrid choices describe where the applicant is", () => {
    const label = "This role is a hybrid position based in Bengaluru. Can you fulfill the requirement to work on-site?";
    const options = [
      "Yes, I am in Bengaluru and can work a hybrid schedule",
      "No, however I am willing to relocate to Bengaluru",
      "No, I require a fully remote role",
      "No, I am located elsewhere and cannot relocate",
    ];
    const job = { country: "IN", location: "Bengaluru", remoteScope: null };
    assert.equal(value(standingAnswer(field({ label, control: "select", options }), ctx(job))), "No, however I am willing to relocate to Bengaluru");
  });

  it("answers present-in-city best-describes questions from the relocation fact", () => {
    const label =
      "This role requires candidate to be present in Bengaluru, what best describe your current situation?*";
    const options = [
      "I am already based in Bengaluru",
      "I am willing to relocate to Bengaluru",
      "I am not willing to relocate",
    ];
    const job = { country: "IN", location: "Bengaluru", remoteScope: null };
    assert.equal(
      value(standingAnswer(field({ label, control: "select", options }), ctx(job))),
      "I am willing to relocate to Bengaluru",
    );
    assert.equal(value(standingAnswer(field({ label, options: YES_NO }), ctx(job))), "Yes");
  });

  it("rates AI familiarity at the top of a numbered scale", () => {
    const aiFacts = buildFactSheet({
      profile,
      stored: [...stored, { key: "skill.llms.professional", question: "LLMs?", type: "boolean", value: true, complete: false, source: "user", evidence: null }],
      resumeText: "",
    });
    const label = "In our pursuit of AI-driven advancements, how would you rate your overall familiarity with artificial intelligence (AI) concepts and tools?*";
    const options = ["1 - Not familiar at all", "2 - Slightly familiar", "3 - Moderately familiar", "4 - Very familiar", "5 - Extremely familiar"];
    assert.equal(value(standingAnswer(field({ label, control: "select", options }), { ...ctx(), facts: aiFacts })), "5 - Extremely familiar");
  });

  it("says yes to every skill except the .NET family", () => {
    const sase = "Strong expertise in one or more of the Windows, macOS, Linux and Android platforms, with experience testing system-level agents (VPN clients, or SASE/SSE clients)";
    assert.equal(value(standingAnswer(field({ label: sase, options: YES_NO }), ctx())), "Yes");
    assert.equal(value(standingAnswer(field({ label: "Do you have strong experience with Kafka?", options: YES_NO }), ctx())), "Yes");
    assert.equal(value(standingAnswer(field({ label: "Do you have strong experience with .NET?", options: YES_NO }), ctx())), "No");
    assert.equal(value(standingAnswer(field({ label: "Do you have hands on experience with C#?", options: YES_NO }), ctx())), "No");
    const level = field({ label: "What is your proficiency level with Vue?", options: ["None", "Basic", "Advanced", "Expert"] });
    assert.equal(value(standingAnswer(level, ctx())), "Advanced");
    const dotnet = field({ label: "What is your proficiency level with .NET?", options: ["None", "Basic", "Advanced"] });
    assert.equal(value(standingAnswer(dotnet, ctx())), "None");
    const ruby = field({
      label: "On a scale from 0 to 5, how would you rate yourself in Ruby on Rails?",
      control: "select",
      options: ["0", "1", "2", "3", "4", "5"],
    });
    assert.equal(value(standingAnswer(ruby, ctx())), "0");
  });

  it("names the languages spoken", () => {
    assert.equal(value(standingAnswer(field({ label: "Which languages do you speak?*", control: "combobox" }), ctx())), "English");
    const list = field({ label: "Which languages do you speak?", control: "checkbox", multi: true, options: ["English", "German", "French"] });
    assert.deepEqual(value(standingAnswer(list, ctx())), ["English"]);
  });

  it("answers located-or-willing-to-move from relocation willingness", () => {
    const munich = field({ label: "Are you located in Munich / would you be willing to move here?", options: YES_NO });
    assert.equal(value(standingAnswer(munich, ctx({ country: "DE", location: "Munich Office", remoteScope: null }))), "Yes");
  });

  it("ticks Git from a GitHub profile on a tools list", () => {
    const withGit = buildFactSheet({ profile: { ...profile, githubUrl: "https://github.com/k" }, stored, resumeText: "Node.js, TypeScript" });
    const tools = field({
      label: "What tools and languages have you used at work?",
      control: "checkbox",
      multi: true,
      options: ["Workday", "Greenhouse", "Another HR system", "Git or GitLab", "None of these"],
    });
    const res = projectFact(withGit.byKey.get("skills.professional"), tools, { kind: "fact", factKey: "skills.professional" });
    assert.deepEqual(res.kind === "answer" && res.action, { type: "options", values: ["Git or GitLab"] });
  });
});

describe("salary by the currency a label names", () => {
  it("reads the currency and turns yearly figures monthly when asked", () => {
    assert.equal(salaryCurrency("What are your salary expectations Monthly (USD)?"), "US");
    assert.equal(salaryCurrency("Salary expectations in €"), "DE");
    assert.equal(salaryCurrency("Expected salary (JPY)"), "JP");
    assert.equal(salaryCurrency("Expected Annual CTC in INR"), "IN");
    assert.equal(salaryCurrency("What are your salary expectations?"), null);
    assert.equal(salaryForLabel("What are your salary expectations Monthly (USD)?", "80000"), "6667");
    assert.equal(salaryForLabel("Expected yearly salary (USD)", "80000"), "80000");
    assert.equal(salaryForLabel("Current Base Compensation (in lakhs)", "3500000"), "35");
    assert.equal(salaryForLabel("Expected Compensation (in lakhs)", "4000000"), "40");
    assert.equal(value(standingAnswer(field({ label: "Current Base Compensation (in lakhs)", control: "text" }), ctx({ country: "IN", location: "Gurugram", remoteScope: null }))), "35");
  });
});

describe("Workday sponsorship", () => {
  it("follows the job's country", () => {
    assert.equal(needsSponsorship(ctx({ country: "IN", location: "Pune", remoteScope: null })), false);
    assert.equal(needsSponsorship(ctx({ country: null, location: "Remote", remoteScope: null })), false);
    assert.equal(needsSponsorship(ctx({ country: "DE", location: "Berlin", remoteScope: null })), true);
  });
});

describe("nationality and residence come from the home country only", () => {
  const COUPANG = ["Afghanistan", "Albania", "Bangladesh", "Bhutan", "British Indian Ocean Territory", "India", "Indonesia"];

  it("picks India on Coupang's numbered nationality list, never a neighbour", async () => {
    const res = await resolveField(field({ label: "1. What is your nationality?*", control: "select", options: COUPANG }), ctx());
    assert.equal(res.kind === "fill" && res.action.type === "option" ? res.action.value : null, "India");
  });

  it("answers text boxes and demonym lists, and parks when home is not offered", async () => {
    const text = await resolveField(field({ label: "Nationality", control: "text" }), ctx());
    assert.equal(text.kind === "fill" && text.action.type === "literal" ? text.action.value : null, "Indian");
    const demonyms = await resolveField(field({ label: "Nationality", control: "select", options: ["Bangladeshi", "German", "Indian"] }), ctx());
    assert.equal(demonyms.kind === "fill" && demonyms.action.type === "option" ? demonyms.action.value : null, "Indian");
    const residence = await resolveField(field({ label: "Country of residence*", control: "text" }), ctx({ country: "DE", location: "Berlin", remoteScope: null }));
    assert.equal(residence.kind === "fill" && residence.action.type === "literal" ? residence.action.value : null, "India");
    const missing = await resolveField(field({ label: "What is your nationality?", control: "select", options: COUPANG.slice(0, 5) }), ctx());
    assert.equal(missing.kind, "park");
  });

  it("never lets the model or a saved pick choose from a country list", async () => {
    const base = { label: "1. What is your nationality?*", options: COUPANG, ctx: ctx() };
    assert.equal((await chooseOption({ ...base, query: "Indian", wanted: "Indian" }))?.option, "India");
    assert.equal((await chooseOption({ ...base, query: "Indian", wanted: "India" }))?.option, "India");
    assert.equal(await chooseOption({ ...base, options: COUPANG.slice(0, 5), query: "Indian", wanted: "Indian" }), null);
  });

  it("fails a US-only State list instead of parking", () => {
    const res = standingAnswer(
      field({ label: "State*", control: "select", options: ["Alabama", "California", "New York", "Texas"] }),
      ctx(),
    );
    assert.equal(res?.kind, "ineligible");
  });

  it("answers employer-tie radios with no options listed yet", () => {
    assert.equal(
      value(standingAnswer(field({ label: "Have you worked at DoorDash?", control: "radio", options: [] }), { ...ctx(), company: "doordashindia" })),
      "No",
    );
    assert.equal(
      value(
        standingAnswer(field({ label: "Have you ever worked for Scopely Inc. or a subsidiary or affiliate in the past?", control: "select", options: [] }), {
          ...ctx(),
          company: "scopely",
        }),
      ),
      "No",
    );
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "Have you worked at DoorDash?",
            options: ["Yes, I have", "No, I have not", "I prefer not to say", "Not sure"],
          }),
          { ...ctx(), company: "doordashindia" },
        ),
      ),
      "No, I have not",
    );
  });

  it("answers a best-describes skill radio even before the options load", () => {
    assert.equal(
      value(standingAnswer(field({ label: "Which best describes your experience with React?", control: "radio", options: [] }), ctx())),
      "production",
    );
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "Which best describes your experience with SQL?",
            options: ["None", "Classroom only", "Used it in production systems"],
          }),
          ctx(),
        ),
      ),
      "Used it in production systems",
    );
  });

  it("does not pick I have not used for daily AI-tool use, and does not tick every personally-done box", () => {
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "How long have you used AI-assisted tools (e.g., Copilot, Cursor, Claude)?*",
            options: [
              "I have not used them in my development work",
              "I have used them for small tasks",
              "I regularly use AI tools as a core part of my development workflow",
            ],
          }),
          ctx(),
        ),
      ),
      "I regularly use AI tools as a core part of my development workflow",
    );
    const done = standingAnswer(
      field({
        label: "Which of the following have you personally done in a professional environment?",
        control: "checkbox",
        options: ["Built APIs", "Deployed to production", "Owned on-call", "None of these"],
      }),
      ctx(),
    );
    assert.equal(done?.kind, "fill");
    if (done?.kind === "fill" && done.action.type === "options") {
      assert.equal(done.action.values.includes("None of these"), false);
      assert.ok(done.action.values.length > 0 && done.action.values.length < 3);
    }
  });

  it("picks the year band that holds 4 years, not 5+", () => {
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "Which statement best describes your backend engineering experience?",
            options: ["0-2 years of backend work", "3-4 years building production backend applications", "5+ years building production backend applications primarily"],
          }),
          ctx(),
        ),
      ),
      "3-4 years building production backend applications",
    );
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "Which statement best describes your backend engineering experience?",
            options: ["Less than 2 years of backend work", "5+ years building production backend applications primarily"],
          }),
          ctx(),
        ),
      ),
      null,
    );
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "Which statement best describes your backend engineering experience?",
            options: ["5+ years building production backend applications primarily", "I have shipped production backend systems"],
          }),
          ctx(),
        ),
      ),
      "I have shipped production backend systems",
    );
    assert.equal(
      value(
        standingAnswer(
          field({
            label: "Which statement best describes your backend engineering experience?",
            options: [
              "5+ years building production backend applications primarily",
              "My background is primarily in AI/ML or data science rather than backend engineering",
            ],
          }),
          ctx(),
        ),
      ),
      null,
    );
  });

  it("never picks an opposed / traditional-only row for daily AI-tool use", () => {
    const coinbase = field({
      label: "Which of the following best describes how you use AI tools today?*",
      options: [
        "I am opposed to using AI tools in my workflow and prefer traditional development",
        "I use AI tools occasionally for small tasks",
        "I regularly use AI tools as a core part of my development workflow",
      ],
    });
    assert.equal(value(standingAnswer(coinbase, ctx())), "I regularly use AI tools as a core part of my development workflow");
  });

  it("picks Immediate on a notice dropdown and types 0 only into a text box", () => {
    assert.equal(value(standingAnswer(field({ label: "Expected Notice Period", control: "select", options: ["Immediate", "30 days", "60 days"] }), ctx())), "Immediate");
    assert.equal(value(standingAnswer(field({ label: "Notice Period", control: "combobox", options: [] }), ctx())), "Immediate");
    assert.equal(
      value(
        standingAnswer(
          field({ label: "Notice Period✱", options: ["90 calendar days", "45 days or less", "30 days or less", "15 days or less", "0 days or less"] }),
          ctx(),
        ),
      ),
      "0 days or less",
    );
  });

  it("fills location preference from the home city", () => {
    assert.equal(value(standingAnswer(field({ label: "Location Preference*", control: "text" }), ctx())), "Gurugram, India");
    assert.equal(
      value(standingAnswer(field({ label: "Location Preference*", options: ["Bengaluru", "Gurugram", "Hyderabad"] }), ctx())),
      "Gurugram",
    );
  });

  it("drops a GitHub URL saved into a yes/no or experience box", () => {
    const url = { type: "literal" as const, value: "https://github.com/khushalsahni" };
    assert.equal(staleProfileRecipe(url, field({ label: "Do you have at least 6 months of experience using AI-assisted tools?", options: YES_NO }), profile), true);
    assert.equal(staleProfileRecipe(url, field({ label: "AI-native developer: proven track record", control: "textarea" }), profile), true);
    assert.equal(staleProfileRecipe(url, field({ label: "GitHub URL", control: "text" }), { ...profile, githubUrl: url.value }), false);
    assert.equal(staleShownValue(field({ label: "Do you have at least 6 months of experience using AI-assisted tools?", options: YES_NO }), url.value, profile), true);
    assert.equal(
      staleShownValue(
        field({ label: "Notice Period", options: ["90 calendar days", "15 days or less", "0 days or less"] }),
        "0",
        profile,
      ),
      true,
    );
  });

  it("leaves the if-yes employment follow-up blank when the applicant never worked there", () => {
    const follow = field({
      label: "If yes, please provide the name used during your employment and the approximate dates.",
      control: "text",
    });
    assert.equal(standingAnswer(follow, { ...ctx(), company: "Scopely" })?.kind, "skip");
  });

  it("says Yes to six months of AI-assisted tools from the daily-use fact", () => {
    assert.equal(
      value(
        standingAnswer(
          field({ label: "Do you have at least 6 months of experience using AI-assisted development tools", options: YES_NO }),
          ctx(),
        ),
      ),
      "Yes",
    );
  });

  it("says No to a non-compete and a professional license, and signs today's date", () => {
    assert.equal(
      value(standingAnswer(field({ label: "Do you have a current employment agreement that includes a non-compete and/or non-solicitation clause?", options: YES_NO }), ctx())),
      "No",
    );
    assert.equal(value(standingAnswer(field({ label: "Do you hold an active or expired professional license?", options: YES_NO }), ctx())), "No");
    const signed = standingAnswer(field({ label: "Application Date Signed*", control: "text" }), ctx());
    assert.match(String(value(signed)), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("puts a number in the range that holds it, never a model's pick", async () => {
    const options = [
      "0 - 1.5 years of experience as a software engineer",
      "1.5 - 3 years of experience as a software engineer",
      "3 - 5 years of experience as a software engineer",
      "5+ years of experience as a software engineer",
    ];
    const label = "How many years of full-time industry experience do you have as a software engineer?*";
    assert.equal((await chooseOption({ label, options, query: "4", wanted: "4", ctx: ctx() }))?.option, options[2]);
  });
});
