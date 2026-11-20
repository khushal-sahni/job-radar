import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closedListTarget, closedLocationList, countryFromText, pickTargetPlace } from "./location";
import { eligibleFromIndia, evaluateJob, type JobForRules } from "./rules";
import { DEFAULT_RULES } from "./types";

describe("country from a location", () => {
  it("reads cities and country names", () => {
    assert.equal(countryFromText("Berlin, Germany"), "DE");
    assert.equal(countryFromText("Bengaluru, Karnataka"), "IN");
    assert.equal(countryFromText("Tokyo"), "JP");
  });

  it("leaves unknown or remote-only places blank", () => {
    assert.equal(countryFromText("Remote"), undefined);
    assert.equal(countryFromText(null), undefined);
  });
});

const ELEVENLABS =
  "London; Dublin; Hungary; United States; New York; Sofia; Germany; Switzerland; Paris; Poland; United Kingdom; Zurich; Stockholm; Czechia; France; Amsterdam; Canada; Berlin";

describe("closed hiring-location lists", () => {
  it("reads only multi-place Ashby and Workable lists", () => {
    assert.equal(closedLocationList("ashby", ELEVENLABS)?.length, 18);
    assert.equal(closedLocationList("greenhouse", ELEVENLABS), null);
    assert.equal(closedLocationList("ashby", "San Francisco"), null);
    assert.equal(closedLocationList("ashby", "Remote"), null);
    assert.equal(closedLocationList("ashby", "London; Remote"), null);
    assert.deepEqual(closedLocationList("workable", "Remote - Berlin, Germany; Paris, France"), ["Berlin, Germany", "Paris, France"]);
  });

  it("prefers India, then the best German city, then the best Japanese city", () => {
    assert.deepEqual(pickTargetPlace(ELEVENLABS.split("; ")), { country: "DE", place: "Berlin" });
    assert.deepEqual(pickTargetPlace(["Munich, Germany", "Berlin, Germany", "Gurugram, India"]), { country: "IN", place: "Gurugram, India" });
    assert.deepEqual(pickTargetPlace(["Germany", "Munich", "London"]), { country: "DE", place: "Munich" });
    assert.deepEqual(pickTargetPlace(["Kyoto", "Osaka", "Tokyo", "Berlin"]), { country: "DE", place: "Berlin" });
    assert.deepEqual(pickTargetPlace(["Kyoto", "Osaka", "Tokyo"]), { country: "JP", place: "Tokyo" });
    assert.deepEqual(pickTargetPlace(["Kyoto", "Osaka"]), { country: "JP", place: "Osaka" });
    assert.deepEqual(pickTargetPlace(["Kyoto", "Seoul"]), { country: "JP", place: "Kyoto" });
    assert.equal(pickTargetPlace(["London", "New York", "Canada"]), null);
  });

  it("does not read India into Indiana or the Indian Ocean", () => {
    assert.equal(pickTargetPlace(["Indianapolis, Indiana", "British Indian Ocean Territory"]), null);
  });

  it("gives the one country the list allows", () => {
    assert.equal(closedListTarget({ source: "ashby", location: ELEVENLABS }), "DE");
    assert.equal(closedListTarget({ source: "ashby", location: "London; New York; Canada" }), null);
    assert.equal(closedListTarget({ source: "ashby", location: "Remote" }), undefined);
  });

  it("reads a one-line list of countries", () => {
    assert.deepEqual(closedLocationList("ashby", "Anywhere in France, Belgium, Spain"), ["France", "Belgium", "Spain"]);
    assert.equal(closedListTarget({ source: "ashby", location: "Anywhere in France, Belgium, Spain" }), null);
    assert.equal(closedListTarget({ source: "ashby", location: "France, Germany" }), "DE");
    assert.equal(closedLocationList("ashby", "Berlin, Germany"), null);
    assert.equal(closedLocationList("ashby", "Darmstadt, DE"), null);
    assert.equal(closedLocationList("ashby", "Bengaluru, India"), null);
  });
});

describe("rules with a closed hiring-location list", () => {
  const job = (partial: Partial<JobForRules>): JobForRules => ({
    source: "ashby",
    isRemote: true,
    remoteScope: "worldwide",
    country: "IN",
    salaryCurrency: "EUR",
    salaryMin: 120_000,
    salaryMax: 150_000,
    salaryINRMin: 12_000_000,
    salaryINRMax: 15_000_000,
    visaSponsorship: true,
    ...partial,
  });

  it("keeps an ElevenLabs-style list out of India but lets it match Germany", () => {
    const eleven = job({ location: ELEVENLABS });
    assert.equal(eligibleFromIndia(eleven), false);
    assert.equal(evaluateJob(eleven, DEFAULT_RULES).branchId, "germany");
  });

  it("still rejects Germany when sponsorship is explicitly not offered", () => {
    assert.equal(evaluateJob(job({ location: ELEVENLABS, visaSponsorship: false }), DEFAULT_RULES).matched, false);
  });

  it("matches nothing when the list has no India, Germany or Japan", () => {
    const res = evaluateJob(job({ location: "London; New York; Canada" }), DEFAULT_RULES);
    assert.equal(res.matched, false);
  });

  it("matches Japan only from a Japanese list", () => {
    assert.equal(evaluateJob(job({ location: "Osaka; Kyoto; Seoul", salaryCurrency: "JPY", salaryMin: 9_000_000, salaryMax: 10_000_000 }), DEFAULT_RULES).branchId, "japan");
  });

  it("keeps India first when India is on the list", () => {
    assert.equal(evaluateJob(job({ location: "Bengaluru, India; Berlin, Germany" }), DEFAULT_RULES).branchId, "remote-india");
  });

  it("leaves one-place and remote locations to the old rules", () => {
    assert.equal(eligibleFromIndia(job({ location: "Remote" })), true);
    assert.equal(eligibleFromIndia(job({ location: "San Francisco", remoteScope: "us" })), false);
    assert.equal(eligibleFromIndia(job({ source: "greenhouse", location: ELEVENLABS })), true);
  });
});

describe("Germany is a hard gate; Japan only needs its country", () => {
  const onsite = (partial: Partial<JobForRules>): JobForRules => ({
    source: "greenhouse",
    isRemote: false,
    country: "DE",
    location: "Berlin, Germany",
    salaryCurrency: "EUR",
    salaryMin: 75_000,
    salaryMax: 85_000,
    visaSponsorship: true,
    ...partial,
  });
  const noSalary = { salaryCurrency: null, salaryMin: null, salaryMax: null };

  it("matches with a listed salary over the floor and confirmed sponsorship", () => {
    assert.equal(evaluateJob(onsite({}), DEFAULT_RULES).branchId, "germany");
  });

  it("rejects unconfirmed sponsorship", () => {
    assert.equal(evaluateJob(onsite({ visaSponsorship: null }), DEFAULT_RULES).matched, false);
  });

  it("rejects an unlisted salary", () => {
    assert.equal(evaluateJob(onsite(noSalary), DEFAULT_RULES).matched, false);
  });

  it("rejects a job with no country, and Japan does not pick it up", () => {
    assert.equal(evaluateJob(onsite({ country: null, location: null }), DEFAULT_RULES).matched, false);
    assert.equal(evaluateJob(onsite({ country: null, location: "Remote (Europe)", isRemote: true, remoteScope: "europe" }), DEFAULT_RULES).matched, false);
  });

  it("still matches Japan with unconfirmed sponsorship or no salary", () => {
    const japan = onsite({ country: "JP", location: "Tokyo", salaryCurrency: "JPY", salaryMin: 9_000_000, salaryMax: 10_000_000 });
    assert.equal(evaluateJob({ ...japan, visaSponsorship: null }, DEFAULT_RULES).branchId, "japan");
    assert.equal(evaluateJob({ ...japan, ...noSalary }, DEFAULT_RULES).branchId, "japan");
  });
});
