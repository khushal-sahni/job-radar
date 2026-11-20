/** Place names that give a job's country away, checked in order (India first). */
const PLACE_COUNTRIES: Array<[string, string]> = [
  ["india", "IN"],
  ["bengaluru", "IN"],
  ["bangalore", "IN"],
  ["mumbai", "IN"],
  ["delhi", "IN"],
  ["hyderabad", "IN"],
  ["germany", "DE"],
  ["berlin", "DE"],
  ["munich", "DE"],
  ["frankfurt", "DE"],
  ["japan", "JP"],
  ["tokyo", "JP"],
  ["osaka", "JP"],
  ["united kingdom", "GB"],
  ["london", "GB"],
  ["united states", "US"],
  ["san francisco", "US"],
  ["new york", "US"],
];

/** ISO country code for the first known place named in the text, or undefined. */
export function countryFromText(text: string | null | undefined): string | undefined {
  const haystack = (text ?? "").toLowerCase();
  return PLACE_COUNTRIES.find(([place]) => haystack.includes(place))?.[1];
}

/** Countries a rule branch can match, in the order the branches are tried. */
export type TargetCountry = "IN" | "DE" | "JP";

/**
 * Names that put a place in a target country. For Germany and Japan the order is the pick order
 * when a list offers several: where an Indian newcomer finds sponsoring employers and community first.
 */
const TARGET_PLACES: Array<[TargetCountry, string[]]> = [
  [
    "IN",
    [
      "india", "gurugram", "gurgaon", "delhi", "new delhi", "noida", "bengaluru", "bangalore", "mumbai",
      "pune", "hyderabad", "chennai", "kolkata", "ahmedabad",
    ],
  ],
  [
    "DE",
    ["berlin", "munich", "münchen", "frankfurt", "hamburg", "stuttgart", "cologne", "köln", "düsseldorf", "dusseldorf", "germany", "deutschland"],
  ],
  ["JP", ["tokyo", "osaka", "kyoto", "yokohama", "fukuoka", "japan"]],
];

/** Sources whose `location` is the posting's full list of hiring places, joined with "; ". */
const CLOSED_LIST_SOURCES = new Set(["ashby", "workable"]);

const OPEN_PLACE_RE = /^(remote|anywhere|worldwide|global|globally|work from anywhere)$/i;

/** Country names a one-line list ("Anywhere in France, Belgium, Spain") can be made of. */
const COUNTRY_NAMES = new Set([
  "india", "germany", "deutschland", "japan",
  "united kingdom", "uk", "ireland", "france", "belgium", "spain", "portugal", "italy", "netherlands",
  "luxembourg", "austria", "switzerland", "poland", "czechia", "czech republic", "romania", "bulgaria",
  "greece", "croatia", "hungary", "slovakia", "slovenia", "estonia", "latvia", "lithuania", "denmark",
  "sweden", "norway", "finland", "iceland", "malta", "cyprus", "serbia", "ukraine", "turkey",
  "united states", "usa", "us", "canada", "mexico", "brazil", "argentina", "chile", "colombia", "peru", "uruguay",
  "singapore", "australia", "new zealand", "south korea", "philippines", "vietnam", "indonesia", "malaysia",
  "thailand", "israel", "united arab emirates", "uae", "south africa", "nigeria", "kenya", "egypt",
]);
const LIST_LEAD_RE = /^(anywhere|remote|based|located)( (in|within|across|from))?\s*[:-]?\s*/i;

/** "Anywhere in France, Belgium, Spain" → its countries; null unless every part is a country. */
function countryList(location: string): string[] | null {
  const parts = location
    .replace(LIST_LEAD_RE, "")
    .split(/,|\/|&|\band\b|\bor\b/i)
    .map((p) => p.replace(/\(remote\)/i, "").trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts.every((p) => COUNTRY_NAMES.has(p.toLowerCase())) ? parts : null;
}

function names(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, "iu").test(text);
}

/** The target country a place is in, or null ("London", "Remote"). */
export function placeTarget(place: string): TargetCountry | null {
  for (const [country, list] of TARGET_PLACES) {
    if (list.some((name) => names(place, name))) return country;
  }
  return null;
}

/**
 * The hiring places of a posting whose source lists every one of them, or null when the location
 * is not such a list. One place is left alone: it is often the headquarters, not the only choice.
 */
export function closedLocationList(source: string | null | undefined, location: string | null | undefined): string[] | null {
  if (!source || !CLOSED_LIST_SOURCES.has(source.toLowerCase())) return null;
  if (location && !location.includes(";")) return countryList(location);
  const places = (location ?? "")
    .replace(/^remote\s+-\s+/i, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (places.length < 2 || places.some((p) => OPEN_PLACE_RE.test(p))) return null;
  return places;
}

/**
 * Where to apply from a fixed list of places: India when offered, else the best German city,
 * else the best Japanese city, else null (the list rules the applicant out).
 */
export function pickTargetPlace(places: readonly string[]): { country: TargetCountry; place: string } | null {
  for (const [country, list] of TARGET_PLACES) {
    const inCountry = places.filter((p) => placeTarget(p) === country);
    if (inCountry.length === 0) continue;
    if (country === "IN") return { country, place: inCountry[0] };
    for (const name of list) {
      const place = inCountry.find((p) => names(p, name));
      if (place) return { country, place };
    }
  }
  return null;
}

/**
 * The one country a closed hiring list lets this job match: undefined when the posting has no
 * closed list, null when the list has none of India, Germany or Japan.
 */
export function closedListTarget(job: { source?: string | null; location?: string | null }): TargetCountry | null | undefined {
  const places = closedLocationList(job.source, job.location);
  if (!places) return undefined;
  return pickTargetPlace(places)?.country ?? null;
}
