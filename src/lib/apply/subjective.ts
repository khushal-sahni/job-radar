import { normalizeLabel } from "./fingerprint";
import type { FieldDescriptor } from "./types";

const SUBJECTIVE_RE =
  /\b(why|interest(ed|s)?|motivat\w*|excite\w*|tell us|describe|about (yourself|you)|introduce yourself|what makes you|what draws you|what attracts you|spike|strength|favou?rite|relevant experience|proud|anything else|what would you|how would you|cover letter|warum|wieso|motivation)\b/;

/**
 * Open questions about the applicant that should be written from known facts,
 * as opposed to free-text boxes that ask for a fact (zip code, a date, a list of employers).
 */
export function isSubjectiveQuestion(field: Pick<FieldDescriptor, "label" | "freeText">): boolean {
  return field.freeText && SUBJECTIVE_RE.test(normalizeLabel(field.label));
}

function squash(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

export function excerpt(text: string | null | undefined, max: number): string {
  const plain = squash(text ?? "");
  return plain.length > max ? `${plain.slice(0, max)}...` : plain;
}
