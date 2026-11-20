import { localCountryNames } from "./countries";
import { normalizeLabel } from "./fingerprint";
import type { FieldDescriptor, RecipeAction } from "./types";

/**
 * Nationality, citizenship and country of residence are the applicant's, whatever the job. They are
 * answered only from the profile country and never picked by a model: a guess here once sent
 * "Bangladesh" as an Indian applicant's nationality.
 */

export type IdentityKind = "nationality" | "residence";

const NATIONALITY_RE = /\b(nationality|nationalities|citizenship|country of citizenship|staatsangeh\w*)\b/;
const RESIDENCE_RE =
  /\b(country of (current )?residence|current country of residence|residence country|country (where )?you (currently )?(live|reside|are living)( in)?|country you (currently )?(live|reside) in|(which|what) country (are|do) you (currently )?(live|reside|based|located|living|based in|located in)|(which|what) country do you (currently )?(live|reside) in|country (in which|where) you (are )?(currently )?(located|based|living)|wohnsitzland)\b/;
const YES_NO_LEAD_RE = /^(are|is|do|does|have|has|were|was|will|would|can|could)\b/;
const CITY_RE = /\b(city|town|cities)\b/;

const DEMONYMS: Record<string, string> = {
  india: "Indian",
  germany: "German",
  japan: "Japanese",
  "united states": "American",
  "united kingdom": "British",
  bangladesh: "Bangladeshi",
  pakistan: "Pakistani",
  "sri lanka": "Sri Lankan",
  nepal: "Nepalese",
  china: "Chinese",
  canada: "Canadian",
  france: "French",
  spain: "Spanish",
  italy: "Italian",
  netherlands: "Dutch",
  ireland: "Irish",
  poland: "Polish",
  brazil: "Brazilian",
  mexico: "Mexican",
  australia: "Australian",
  singapore: "Singaporean",
  "south korea": "South Korean",
  philippines: "Filipino",
  indonesia: "Indonesian",
  vietnam: "Vietnamese",
  "united arab emirates": "Emirati",
};

let countryNames: Set<string> | null = null;

/** Every country and territory name English knows ("india", "bangladesh", "british indian ocean territory"). */
function allCountryNames(): Set<string> {
  if (countryNames) return countryNames;
  const names = new Set<string>();
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const A = "A".charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        name = undefined;
      }
      if (name && name !== code) names.add(normalizeLabel(name));
    }
  }
  for (const [country, demonym] of Object.entries(DEMONYMS)) {
    names.add(country);
    names.add(normalizeLabel(demonym));
  }
  countryNames = names;
  return names;
}

/** An option as a bare name: "India (+91)" / "India+91" → "india". */
function bareName(option: string): string {
  return normalizeLabel(option.replace(/\(.*?\)/g, " ").replace(/\+?\d[\d\s-]*/g, " "));
}

/** True when at least half the options are countries or nationalities ("Indian", "Other" counts); city search rows do not. */
export function isCountryList(options: string[]): boolean {
  const names = allCountryNames();
  const real = options.filter((o) => o.trim());
  const countries = real.filter((o) => names.has(bareName(o))).length;
  return countries > 0 && countries * 2 >= real.length;
}

/** Nationality / citizenship / country-of-residence questions, never a yes-or-no about a country. */
export function identityKind(field: Pick<FieldDescriptor, "label" | "options">): IdentityKind | null {
  const label = normalizeLabel(field.label).replace(/^\d+ /, "");
  if (YES_NO_LEAD_RE.test(label) || CITY_RE.test(label)) return null;
  const options = field.options.filter((o) => o.trim());
  if (options.length > 0 && !isCountryList(options)) return null;
  if (NATIONALITY_RE.test(label)) return "nationality";
  if (RESIDENCE_RE.test(label) || /^国$/.test(label)) return "residence";
  return null;
}

/** The ways a form may write the home country: "India", "Indian", "Indien". */
export function homeNames(homeCountry: string): string[] {
  const country = homeCountry.trim();
  if (!country) return [];
  const demonym = DEMONYMS[normalizeLabel(country)];
  return [country, ...(demonym ? [demonym] : []), ...localCountryNames(country)];
}

/** True when the text is the home country (or its people) and nothing else: "British Indian Ocean Territory" is not India. */
export function namesHome(text: string, homeCountry: string): boolean {
  const bare = bareName(text);
  return Boolean(bare) && homeNames(homeCountry).some((name) => normalizeLabel(name) === bare);
}

/**
 * The row of a country list the applicant means: home for "India" / "Indian" / "Gurugram, India",
 * else a country whose whole name is in `wanted` ("Germany" for "Berlin, Germany"). "Indian" never
 * matches "British Indian Ocean Territory". Null when no row is that country.
 */
export function countryRow(wanted: string, options: string[], homeCountry: string): string | null {
  const words = new Set(normalizeLabel(wanted).split(" "));
  const homeMeant = namesHome(wanted, homeCountry) || [...words].some((w) => namesHome(w, homeCountry));
  if (homeCountry && homeMeant) {
    const home = options.find((o) => namesHome(o, homeCountry));
    if (home) return home;
  }
  const rows = options.filter((o) => {
    const name = bareName(o);
    return name && allCountryNames().has(name) && name.split(" ").every((w) => words.has(w));
  });
  return rows.length === 1 ? rows[0] : null;
}

/**
 * The answer for an identity question, or a park reason. Text boxes get the demonym for a
 * nationality and the country for residence; a list gets the home row or nothing.
 */
export function identityAnswer(
  field: Pick<FieldDescriptor, "label" | "options" | "control">,
  kind: IdentityKind,
  homeCountry: string,
): { action: RecipeAction } | { park: string } {
  const names = homeNames(homeCountry);
  if (names.length === 0) return { park: `No home country on file for: ${field.label.slice(0, 80)}` };
  const options = field.options.filter((o) => o.trim());
  if (options.length === 0) {
    const value = kind === "nationality" ? (names[1] ?? names[0]) : names[0];
    return { action: field.control === "combobox" ? { type: "option", value: names[0] } : { type: "literal", value } };
  }
  const home = options.find((o) => namesHome(o, homeCountry));
  if (home) return { action: { type: "option", value: home } };
  return { park: `No ${names[0]} choice for: ${field.label.slice(0, 80)}` };
}

/**
 * Pre-submit check: an identity answer that does not name the home country. Null when it does,
 * or when the question is not an identity question.
 */
export function identityProblem(
  field: Pick<FieldDescriptor, "label" | "options">,
  shown: string,
  homeCountry: string,
): string | null {
  if (!identityKind(field) || !shown.trim() || !homeCountry.trim()) return null;
  if (namesHome(shown, homeCountry)) return null;
  return `"${field.label.slice(0, 60)}" shows "${shown.slice(0, 40)}", not ${homeCountry}`;
}
