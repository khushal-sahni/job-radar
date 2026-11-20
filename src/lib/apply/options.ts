/** Pure checks for choices scraped off a page, shared by the runner and tests. */

const YEARS_LABEL_RE = /\b(how many years|years of (professional |work |relevant )?experience|years experience|jahre)\b/i;
const DURATION_RE = /^\s*(<|>|less than|more than|under|over|up to|fresher|none|no experience|0)?\s*\d*\s*(\+|-|–|to)?\s*\d*\s*(\+)?\s*(years?|yrs?|months?|jahre?)?\s*(\+)?\s*$/i;

const YES_NO_RE = /^(yes|no|ja|nein)\b/i;

/** "1", "2+", "3-5", "< 1 year", "5+ years", "Fresher". */
export function isDurationOption(option: string): boolean {
  const t = option.trim();
  if (!t) return false;
  if (/^(fresher|none|no experience)$/i.test(t)) return true;
  return /\d/.test(t) && DURATION_RE.test(t);
}

/** A years question whose choices are not durations got someone else's choices (a skills menu): drop them. */
export function cleanOptionsForLabel(label: string, options: string[]): string[] {
  const kept = options.map((o) => o.trim()).filter(Boolean);
  if (kept.length === 0) return [];
  const answers = (o: string) => isDurationOption(o) || YES_NO_RE.test(o);
  if (YEARS_LABEL_RE.test(label) && !kept.some(answers)) return [];
  return kept;
}

const GREETING_RE = /^(hi|hello|hey|dear|welcome|thank you|thanks)\b/i;
const BUTTON_WORDS_RE = /\s*\b(save|send|submit|skip|next)\s*$/i;

/**
 * The question inside a Naukri chatbot bubble: the last sentence ending in "?", with
 * trailing button text removed. Null for a greeting or a bubble with no question.
 */
export function naukriQuestion(message: string): string | null {
  let text = message.replace(/\s+/g, " ").trim();
  while (BUTTON_WORDS_RE.test(text)) text = text.replace(BUTTON_WORDS_RE, "").trim();
  if (!text) return null;
  const questions = text.split(/(?<=[.!?])\s+/).filter((s) => s.endsWith("?"));
  if (questions.length > 0) {
    const last = questions[questions.length - 1].trim();
    return last.length > 2 ? last : null;
  }
  if (GREETING_RE.test(text)) return null;
  return text.length <= 200 ? text : null;
}
