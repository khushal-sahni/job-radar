/** English wording for German application questions, so they match the profile and read in the modal. */

export const OFFICE_CITY_LABEL = "Office city for this role";

const PHRASES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/kündigungsfrist/, () => "What is your current notice period?"],
  [/in welcher stadt (lebst|wohnst) du/, () => "Which city do you currently live in?"],
  [/^standort\s*(\(stadt\))?$/, () => OFFICE_CITY_LABEL],
  [/kommunikationssprache|welche sprache bevorzugst du/, () => "Which language do you prefer to communicate in?"],
  [
    /wie (hast du|haben sie) von (dieser stelle|der stelle|uns) erfahren|wie bist du auf (uns|diese stelle) aufmerksam/,
    () => "How did you hear about this position?",
  ],
  [
    /falls du nicht in (.+?) wohnst.*(umzuziehen|umziehen)/,
    (m) => `If you do not live in ${titleCase(m[1])}, would you be willing to move there?`,
  ],
  [/gehaltswunsch|gehaltsvorstellung/, () => "What is your expected salary for this role?"],
  [/arbeitserlaubnis/, () => "Do you have a work permit for the country where this role is posted?"],
  [/^vorname$/, () => "First name"],
  [/^(nachname|familienname)$/, () => "Last name"],
  [/^(telefon|telefonnummer|handynummer|mobilnummer)$/, () => "Phone"],
  [/^e-?mail(-adresse)?$/, () => "Email"],
  [/^land$/, () => "Country"],
  [/^(stadt|wohnort)$/, () => "City"],
];

function titleCase(s: string): string {
  return s.trim().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** The English question for a German label; any other label comes back unchanged. */
export function englishLabel(label: string): string {
  const required = /[*✱]\s*$/.test(label);
  const text = label.replace(/[*✱]\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const [re, english] of PHRASES) {
    const m = text.match(re);
    if (m) return english(m) + (required ? "*" : "");
  }
  return label;
}
