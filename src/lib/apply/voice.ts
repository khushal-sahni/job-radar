import type { FieldDescriptor } from "./types";

const BANNED_PHRASES = [
  "i am excited",
  "i'm excited",
  "excited to",
  "passionate",
  "passion for",
  "leverage",
  "leveraging",
  "delve",
  "robust",
  "cutting-edge",
  "cutting edge",
  "aligns with",
  "align with",
  "aligned with",
  "thrilled",
  "not only",
  "furthermore",
  "moreover",
  "in today's",
  "fast-paced",
  "synergy",
  "spearhead",
  "seamless",
  "tapestry",
  "testament",
  "elevate",
  "game-changer",
  "game changer",
  "eager to",
  "keen to",
  "honed",
  "showcase",
  "embark",
  "my journey",
  "landscape",
  "resonates",
  "great fit",
  "perfect fit",
  "ideal candidate",
  "as an ai",
  "i believe i would",
  "look forward to the opportunity",
  "unique opportunity",
  "dynamic team",
  "deeply",
  "invaluable",
];

export const BANNED_PHRASES_FOR_PROMPT: readonly string[] = BANNED_PHRASES;

export interface VoiceLimits {
  sentences: number;
  words: number;
  /** The field's own character limit, when it has one. */
  chars: number | null;
}

export const SHORT_LIMITS: VoiceLimits = { sentences: 3, words: 70, chars: null };
export const LONG_LIMITS: VoiceLimits = { sentences: 8, words: 200, chars: null };
const SHORT_BOX_CHARS = 280;

/** A text area without a tight character limit gets room to answer a question with several parts. */
export function limitsFor(field: Pick<FieldDescriptor, "control" | "maxLength">): VoiceLimits {
  const long = field.control === "textarea" && (field.maxLength == null || field.maxLength > SHORT_BOX_CHARS);
  return { ...(long ? LONG_LIMITS : SHORT_LIMITS), chars: field.maxLength };
}

function countSentences(text: string): number {
  return text
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/**
 * Problems with a composed answer. Empty list means it can be filled.
 * Rejects em dashes, stock AI wording, and anything longer than a few sentences.
 */
export function checkVoice(text: string, limits: VoiceLimits = SHORT_LIMITS): string[] {
  const problems: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return ["empty answer"];

  if (/[—―]|\s–\s|\s--\s/.test(trimmed)) problems.push("uses an em dash");

  const lower = trimmed.toLowerCase().replace(/[’]/g, "'");
  const hits = BANNED_PHRASES.filter((p) => lower.includes(p));
  if (hits.length > 0) problems.push(`AI phrasing: ${hits.join(", ")}`);

  if (countSentences(trimmed) > limits.sentences) {
    problems.push(`longer than ${limits.sentences} sentences`);
  }
  const words = trimmed.split(/\s+/).length;
  if (words > limits.words) problems.push(`over ${limits.words} words`);
  if (limits.chars != null && trimmed.length > limits.chars) {
    problems.push(`over the field limit of ${limits.chars} characters`);
  }
  return problems;
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*(\s+|$)/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * Mechanical fix for a composed answer that failed the voice check: dashes become commas,
 * sentences with stock phrases are dropped, then it is cut to the sentence, word and character limits.
 * Returns null when nothing usable is left.
 */
export function repairVoice(text: string, limits: VoiceLimits = SHORT_LIMITS): string | null {
  const dashless = text.replace(/\s*[—―]\s*|\s+–\s+|\s+--\s+/g, ", ").trim();
  const clean = splitSentences(dashless).filter((s) => {
    const lower = s.toLowerCase().replace(/[’]/g, "'");
    return !BANNED_PHRASES.some((p) => lower.includes(p));
  });

  const kept: string[] = [];
  let words = 0;
  for (const sentence of clean.slice(0, limits.sentences)) {
    const count = sentence.split(/\s+/).length;
    if (words + count > limits.words) break;
    if (limits.chars != null && [...kept, sentence].join(" ").length > limits.chars) break;
    kept.push(sentence);
    words += count;
  }
  const result = kept.join(" ");
  return result && checkVoice(result, limits).length === 0 ? result : null;
}
