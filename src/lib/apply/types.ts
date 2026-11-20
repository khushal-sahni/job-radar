export type ApplyVendor =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "workday"
  | "naukri"
  | "generic";

export type FieldControl =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "combobox"
  | "file";

/** One form control as seen by the page bridge. */
export interface FieldDescriptor {
  /** `data-jr-id` stamped on the control (or the group's first input). */
  id: string;
  label: string;
  control: FieldControl;
  options: string[];
  required: boolean;
  maxLength: number | null;
  /** Free-text box where a written answer (not a fact) fits. */
  freeText: boolean;
  /** A checkbox group where several choices may be checked. */
  multi?: boolean;
}

export const PROFILE_KEYS = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "location",
  "city",
  "country",
  "linkedInUrl",
  "githubUrl",
  "portfolioUrl",
  "currentCompany",
  "noticePeriod",
  "expectedCtc",
  "resumeSummary",
  "yearsOfExperience",
] as const;

export type ProfileKey = (typeof PROFILE_KEYS)[number];

export type ProfileValues = Record<ProfileKey, string>;

export type RecipeAction =
  | { type: "profile"; key: ProfileKey }
  | { type: "option"; value: string }
  | { type: "options"; values: string[] }
  | { type: "literal"; value: string }
  | { type: "compose"; text: string }
  | { type: "skip" };

export type RecipeSourceName = "heuristic" | "cheap_model" | "strong_model" | "user";

export type FactType = "boolean" | "text" | "number" | "list";
export type FactValue = boolean | string | number | string[];

/** What a form question asks. Decided by the classify call; never carries an answer. */
export type QuestionKind = "fact" | "preference" | "written" | "demographic" | "consent" | "instruction" | "derived";

export interface Classification {
  kind: QuestionKind;
  /** The applicant fact that answers it; null for written, consent and instruction questions. */
  factKey: string | null;
  /** Neutral wording and type for a fact nobody has yet. */
  question?: string;
  type?: FactType;
  /** The one item a yes/no asks about ("Node.js" in "Have you used Node.js?"), for list facts. */
  item?: string;
  /** "At least N" in a yes/no about a number ("3+ years of Go?"). */
  atLeast?: number;
  /** Asks about ties to the employer asking ("worked here before?"): the item is that company, the fact a list of companies. */
  employer?: boolean;
  model?: string | null;
}
