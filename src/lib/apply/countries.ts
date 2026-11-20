import { normalizeLabel } from "./fingerprint";

/** What forms need to know about a country: its local names and phone format. */
interface CountryInfo {
  /** Names to type when a country list is in another language and the English name finds nothing. */
  localNames: string[];
  /** Only for countries whose national numbers have one fixed length. */
  phone?: { dialCode: string; nationalDigits: number };
}

const COUNTRIES: Record<string, CountryInfo> = {
  india: { localNames: ["Indien"], phone: { dialCode: "+91", nationalDigits: 10 } },
  germany: { localNames: ["Deutschland"] },
  "united states": { localNames: ["Vereinigte Staaten"], phone: { dialCode: "+1", nationalDigits: 10 } },
};

function country(name: string | null | undefined): CountryInfo | undefined {
  return name ? COUNTRIES[normalizeLabel(name)] : undefined;
}

export function localCountryNames(name: string): string[] {
  return country(name)?.localNames ?? [];
}

/** A local number with its country code ("09876543210", India → "+91 9876543210"), or null. */
export function internationalNumber(phone: string, countryName: string | null | undefined): string | null {
  const format = country(countryName)?.phone;
  const digits = phone.replace(/\D/g, "");
  if (!format || phone.trim().startsWith("+") || digits.length < format.nationalDigits) return null;
  return `${format.dialCode} ${digits.slice(-format.nationalDigits)}`;
}
