import { closedLocationList, pickTargetPlace, placeTarget, type TargetCountry } from "@/lib/location";
import { normalizeLabel } from "./fingerprint";
import type { FieldDescriptor, RecipeAction } from "./types";

/** Where the job is, as stored on `Job`. */
export interface JobLocation {
  country: string | null;
  location: string | null;
  remoteScope: string | null;
}

/** Lowercase names and big cities → ISO code. Matched on word boundaries. */
const PLACES: Record<string, string> = {
  india: "IN", bengaluru: "IN", bangalore: "IN", mumbai: "IN", delhi: "IN", "new delhi": "IN",
  gurugram: "IN", gurgaon: "IN", noida: "IN", hyderabad: "IN", pune: "IN", chennai: "IN", kolkata: "IN",
  germany: "DE", berlin: "DE", munich: "DE", "münchen": "DE", frankfurt: "DE", hamburg: "DE", cologne: "DE",
  japan: "JP", tokyo: "JP", osaka: "JP", kyoto: "JP",
  "united states": "US", america: "US", "san francisco": "US", "new york": "US", seattle: "US", austin: "US", boston: "US",
  "united kingdom": "GB", england: "GB", scotland: "GB", britain: "GB", london: "GB", manchester: "GB",
  canada: "CA", toronto: "CA", vancouver: "CA", montreal: "CA",
  ireland: "IE", dublin: "IE",
  netherlands: "NL", amsterdam: "NL",
  france: "FR", paris: "FR",
  spain: "ES", madrid: "ES", barcelona: "ES",
  portugal: "PT", lisbon: "PT",
  poland: "PL", warsaw: "PL", krakow: "PL",
  switzerland: "CH", zurich: "CH",
  austria: "AT", vienna: "AT",
  sweden: "SE", stockholm: "SE",
  denmark: "DK", copenhagen: "DK",
  norway: "NO", finland: "FI", belgium: "BE", italy: "IT", romania: "RO", czechia: "CZ", estonia: "EE",
  singapore: "SG", australia: "AU", sydney: "AU", melbourne: "AU", "new zealand": "NZ",
  "south korea": "KR", korea: "KR", seoul: "KR",
  "united arab emirates": "AE", dubai: "AE", israel: "IL",
  brazil: "BR", mexico: "MX", argentina: "AR", colombia: "CO", chile: "CL", peru: "PE",
  "dominican republic": "DO",
};

/** Upper-case abbreviations; case-sensitive so "us" the pronoun never counts. */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\b(US|USA|U\.S\.A?\.?)(?![a-z])/, "US"],
  [/\bUK\b/, "GB"],
  [/\bUAE\b/, "AE"],
];

/** Regions that are never India. APAC is left out on purpose. */
const NON_INDIA_REGION_RE = /\b(europe|european union|eu|emea|americas|north america|latam|latin america)\b/i;

const PLACE_RE = new RegExp(
  `\\b(${Object.keys(PLACES)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "giu",
);

/** ISO codes named in free text, in order of appearance. */
export function countriesIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.toLowerCase().matchAll(PLACE_RE)) found.push(PLACES[m[1]]);
  for (const [re, code] of ABBREVIATIONS) if (re.test(text)) found.push(code);
  return [...new Set(found)];
}

export function countryCode(name: string): string | null {
  const trimmed = name.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return countriesIn(trimmed)[0] ?? null;
}

const NEEDS_RE = /\b(require|requires|required|requirement|need|needs|needed)\b/;
const SPONSOR_RE = /\b(sponsor|sponsorship|sponsored|visa)\b/;
const AUTH_RE =
  /\b(authori[sz]ed|authori[sz]ation|eligible|eligibility|right) to work\b|\bwork (permit|authori[sz]ation)\b|\blegally (able|allowed|permitted|entitled) to work\b|\bwork authori[sz]ation\b/;
const LOOSE_AUTH_RE = /\b(able|allowed|permitted) to work in\b/;

type Question = "needs_sponsorship" | "authorized";

function classify(label: string, rawLabel: string): Question | null {
  const authorized = AUTH_RE.test(label) || (LOOSE_AUTH_RE.test(label) && countriesIn(rawLabel).length > 0);
  if (NEEDS_RE.test(label) && (SPONSOR_RE.test(label) || /\bwork permit\b/.test(label))) {
    return "needs_sponsorship";
  }
  if (authorized) return "authorized";
  if (SPONSOR_RE.test(label)) return "needs_sponsorship";
  return null;
}

/** True for sponsorship / right-to-work questions this module can answer from the job location. */
export function isWorkAuthLabel(label: string): boolean {
  return classify(normalizeLabel(label), label) !== null;
}

/**
 * Country the work happens in, or null when unknown.
 * A country named in the question wins; remote-from-India roles count as India.
 */
export function workCountry(label: string, job: JobLocation | undefined): string | null {
  const named = countriesIn(label);
  if (named.length > 0) return named[0];
  if (NON_INDIA_REGION_RE.test(label)) return "EU";
  if (!job) return null;
  if (job.remoteScope === "india" || job.country?.toUpperCase() === "IN") return "IN";
  const inLocation = countriesIn(job.location ?? "");
  if (inLocation.includes("IN")) return "IN";
  if (job.country) return job.country.toUpperCase();
  if (inLocation.length > 0) return inLocation[0];
  if (job.remoteScope === "europe" || job.remoteScope === "us") return job.remoteScope === "us" ? "US" : "EU";
  if (NON_INDIA_REGION_RE.test(job.location ?? "")) return "EU";
  return null;
}

function pickYesNo(field: FieldDescriptor, yes: boolean): RecipeAction | null {
  if (field.options.length === 0) {
    return field.control === "text" || field.control === "textarea"
      ? { type: "literal", value: yes ? "Yes" : "No" }
      : null;
  }
  const wants = yes ? ["yes", "ja"] : ["no", "nein"];
  const hits = field.options.filter((o) => {
    const n = normalizeLabel(o);
    return wants.some((w) => n === w || n.startsWith(`${w} `));
  });
  if (hits.length === 1) return { type: "option", value: hits[0] };
  if (hits.length > 1) return null;

  // "I will require sponsorship" / "I will not require sponsorship"
  const real = field.options.filter((o) => !/^(select|select one|please select|choose)$/.test(normalizeLabel(o)));
  if (real.length !== 2) return null;
  const negated = real.filter((o) => NEGATION_RE.test(normalizeLabel(o)));
  if (negated.length !== 1) return null;
  const value = yes ? real.find((o) => o !== negated[0]) : negated[0];
  return value ? { type: "option", value } : null;
}

const NEGATION_RE = /\b(not|no|don t|do not|won t|will not|doesn t|never)\b/;

/**
 * Sponsorship and right-to-work answers from where the job is: none needed at home,
 * needed everywhere else. Null means the caller should ask the user.
 */
export function answerWorkAuth(
  field: FieldDescriptor,
  job: JobLocation | undefined,
  homeCountry: string,
): RecipeAction | null {
  const question = classify(normalizeLabel(field.label), field.label);
  if (!question) return null;
  const work = workCountry(field.label, job);
  if (!work) return null;
  const atHome = work === homeCountry;
  return pickYesNo(field, question === "authorized" ? atHome : !atHome);
}

const COUNTRY_NAME_RE =
  /^(germany|deutschland|japan|india|united states|usa|us|uk|united kingdom|netherlands|france|spain|austria|switzerland|ireland|poland|canada|singapore|europe|eu)$/i;

/** City of the posting: "Revaler Straße 28-31, 10245 Berlin" → "Berlin", "Tokyo, Japan" → "Tokyo". */
export function jobCity(job: JobLocation | undefined): string | null {
  const parts = (job?.location ?? "").split(/[,;|]/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^\d{4,6}\s+(\p{L}[\p{L} .'-]*)$/u);
    if (m) return m[1].trim();
  }
  const plain = parts.find((p) => !/\d/.test(p) && !COUNTRY_NAME_RE.test(p) && !/\bremote\b/i.test(p));
  return plain ?? null;
}

/**
 * Expected salary for the job's country: the rule floor where one is set (Germany in EUR,
 * Japan in JPY), the profile figure for India, and null elsewhere so the user is asked.
 */
export function expectedSalaryFor(
  job: JobLocation | undefined,
  floors: Partial<Record<string, number>>,
  profileValue: string,
): { country: string | null; value: string | null } {
  const country = workCountry("", job);
  if (country && floors[country]) return { country, value: String(floors[country]) };
  if (!country || country === "IN") return { country, value: profileValue || null };
  return { country, value: null };
}

/** Short "where is this job" text for a question shown to the user. */
export function describeJobLocation(job: JobLocation | undefined): string | null {
  if (!job) return null;
  const location = job.location?.trim();
  if (location) return location.length > 60 ? `${location.slice(0, 57)}...` : location;
  return job.country ?? null;
}

const TARGET_COUNTRY_NAMES: Record<string, string> = { IN: "India", DE: "Germany", JP: "Japan" };

/**
 * The office city with its country ("Berlin, Germany"), for place search boxes that list every
 * Berlin in the world; just the city when the country is unknown.
 */
export function jobCityWithCountry(job: JobLocation | undefined): string | null {
  const city = jobCity(job);
  if (!city) return null;
  const country = job?.country ? TARGET_COUNTRY_NAMES[job.country] : undefined;
  return country && !normalizeLabel(city).includes(normalizeLabel(country)) ? `${city}, ${country}` : city;
}

/**
 * Where the application is for. A closed hiring list without India but with a German or Japanese
 * city becomes that city, so visa, salary and office answers follow it rather than the stored country.
 */
export function applyLocation(job: JobLocation & { source: string | null }): JobLocation {
  const places = closedLocationList(job.source, job.location);
  const pick = places ? pickTargetPlace(places) : null;
  if (pick && pick.country !== "IN") return { country: pick.country, location: pick.place, remoteScope: null };
  return { country: job.country, location: job.location, remoteScope: job.remoteScope };
}

const WORK_PLACE_RE =
  /^location$|\b(which|what|preferred|desired|choose|select)\b.*\b(location|office|hub|city|country)\b|\bwhere (would|will|do) you (like to |want to |prefer to |plan to )?(work|be based)\b|\blocation\b.*\b(applying|role|position)\b/;
const RESIDENCE_RE =
  /\b(reside|residence|live|living|currently|current|citizen|citizenship|nationality|address|born|home)\b|\b(applying|based|located) from\b|\bare you (in|from|located|based)\b/;
const OFFICE_RE = /\b(which|what|preferred|choose|select)\b.*\boffice\b|\boffice (location|city)\b|\bbased (in|at|out of) (which|what) office\b/;
const PLACEHOLDER_RE = /^(select|select one|select an option|please select|choose|)$/;
const OTHER_OPTION_RE = /^(other|others|none|elsewhere|somewhere else|not listed)\b/;

/** "Which office would you be based in?": the office for this role, never where the applicant lives. */
export function isOfficeQuestion(label: string): boolean {
  const l = normalizeLabel(label);
  return OFFICE_RE.test(l) && !RESIDENCE_RE.test(l);
}

/**
 * For a "which location is this application for" select or radio whose options are places
 * (or an office search box): undefined when that does not apply or India is offered (the profile
 * answer stands), the German or Japanese place to pick, or null when the list has none of the three.
 */
export function workPlaceChoice(field: FieldDescriptor): { country: TargetCountry; place: string } | null | undefined {
  const office = isOfficeQuestion(field.label);
  if (field.control !== "select" && field.control !== "radio" && !(field.control === "combobox" && office)) return undefined;
  const label = normalizeLabel(field.label);
  if (!WORK_PLACE_RE.test(label) || RESIDENCE_RE.test(label)) return undefined;
  const options = field.options.filter((o) => !PLACEHOLDER_RE.test(normalizeLabel(o)));
  if (options.length < 2 || options.some((o) => OTHER_OPTION_RE.test(normalizeLabel(o)))) return undefined;
  // Only a list that is clearly places: "Remote" / "Hybrid" choices are not a hiring list.
  const places = options.filter((o) => placeTarget(o) || countriesIn(o).length > 0);
  if (places.length < 2 || places.length * 2 < options.length) return undefined;
  const pick = pickTargetPlace(options);
  if (!pick) return null;
  return pick.country === "IN" ? undefined : pick;
}
