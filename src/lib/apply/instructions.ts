import { normalizeLabel } from "./fingerprint";
import type { FieldControl, RecipeAction } from "./types";

const CONDITION_RE =
  /\b(?:if|when)\s+you(?:'re|’re|\s+are)\s+(?:an?\s+)?(human|real person|person|ai|a\.i\.|bot|robot|chatbot|language model|large language model|llm|automated (?:tool|system|agent|program)|ai (?:assistant|agent|model|tool|system))\b/gi;

const AI_DIRECTIVE_SENTENCE_RE =
  /\b(?:ai|a\.i\.|llms?|language models?|chatbots?|bots?|ai (?:assistants?|agents?|models?|tools?|systems?)|automated (?:tools?|systems?|agents?))\s+(?:should|must|need to|are required to|are instructed to|please)\b/i;

const LEAVE_BLANK_RE =
  /\b(?:leave|keep)\s+(?:this|it|the)?\s*(?:field|box|input|question)?\s*(?:blank|empty)\b|\bdo\s+not\s+(?:fill|answer|type|enter|complete)\b|\bdon['’]t\s+(?:fill|answer|type|enter)\b/i;

const STRICT_LEAVE_BLANK_RE =
  /^(?:please\s+)?(?:(?:leave|keep)\s+(?:this|the)\s+(?:field|box|input|question)?\s*(?:blank|empty)|do\s+not\s+(?:fill|answer|type in|complete)\s+(?:this|the))\b(?!.*\b(?:if|unless)\b)/i;

const QUOTED_LITERAL_RE =
  /\b(?:type|enter|write|answer|put|input|respond with|reply with|select|choose|pick|check)\s+(?:in\s+)?(?:the\s+(?:word|phrase|text|number|option|answer)\s+)?["'“‘`]([^"'”’`]{1,60})["'”’`]/i;

const BARE_WORD_LITERAL_RE =
  /\b(?:type|enter|write|answer with|select|choose)\s+the\s+(?:word|number|option)\s+([A-Za-z0-9][\w-]{0,30})/i;

export interface InstructionResult {
  /** What a human is told to do, when the label says so. */
  action: RecipeAction | null;
  /** The label carried a directive aimed at AI / bots. */
  aiTrap: boolean;
  /** Label with AI-directed clauses removed. */
  cleanedLabel: string;
}

interface Segment {
  kind: "human" | "ai";
  text: string;
}

function conditionKind(word: string): "human" | "ai" {
  return /^(human|real person|person)$/i.test(word) ? "human" : "ai";
}

/** Splits condition clauses out of the label; `rest` keeps everything except AI clauses. */
function splitConditions(label: string): { segments: Segment[]; rest: string } {
  const matches = [...label.matchAll(CONDITION_RE)];
  if (matches.length === 0) return { segments: [], rest: label };

  const segments: Segment[] = [];
  let rest = label.slice(0, matches[0].index ?? 0);

  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    const nextStart = matches[i + 1]?.index ?? label.length;
    const clause = label.slice(start, nextStart);
    let body = label.slice(start + m[0].length, nextStart);
    let tail = "";
    // A condition clause ends at its sentence; trailing sentences belong to the label.
    const sentenceEnd = body.search(/[.!?](\s|$)/);
    if (sentenceEnd >= 0 && i === matches.length - 1) {
      tail = body.slice(sentenceEnd + 1);
      body = body.slice(0, sentenceEnd + 1);
    }
    const kind = conditionKind(m[1]);
    segments.push({ kind, text: body.replace(/^[\s,:;-]+/, "") });
    if (kind === "human") rest += " " + clause.slice(0, clause.length - tail.length);
    rest += " " + tail;
  });

  return { segments, rest };
}

function literalFrom(
  text: string,
  control: FieldControl,
  options: string[],
): RecipeAction | null {
  const quoted = text.match(QUOTED_LITERAL_RE)?.[1] ?? text.match(BARE_WORD_LITERAL_RE)?.[1];
  if (!quoted) return null;
  const value = quoted.trim();
  if (!value) return null;

  if (control === "select" || control === "radio" || control === "combobox") {
    const wanted = normalizeLabel(value);
    const option = options.find((o) => normalizeLabel(o) === wanted);
    if (option) return { type: "option", value: option };
    if (control !== "combobox") return null;
  }
  if (control === "checkbox") {
    const wanted = normalizeLabel(value);
    const option = options.find((o) => normalizeLabel(o) === wanted);
    return option ? { type: "options", values: [option] } : null;
  }
  return { type: "literal", value };
}

/**
 * Reads "if you are a human, do X / if you are an AI, do Y" style instructions.
 * Only the human branch is ever followed; AI-directed text is stripped.
 */
export function parseInstructions(
  label: string,
  control: FieldControl,
  options: string[] = [],
): InstructionResult {
  const { segments, rest } = splitConditions(label);

  const restSentences = rest.split(/(?<=[.!?])\s+/);
  const keptSentences = restSentences.filter((s) => !AI_DIRECTIVE_SENTENCE_RE.test(s));
  const aiTrap =
    segments.some((s) => s.kind === "ai") || keptSentences.length !== restSentences.length;
  const cleanedLabel = keptSentences.join(" ").replace(/\s+/g, " ").trim();

  const human = segments.find((s) => s.kind === "human");
  if (human) {
    if (LEAVE_BLANK_RE.test(human.text)) {
      return { action: { type: "skip" }, aiTrap, cleanedLabel };
    }
    return { action: literalFrom(human.text, control, options), aiTrap, cleanedLabel };
  }

  if (STRICT_LEAVE_BLANK_RE.test(cleanedLabel)) {
    return { action: { type: "skip" }, aiTrap, cleanedLabel };
  }

  // "Please only submit a PDF version of your resume above" is a confirmation, not a note to skip.
  if (
    /\b(please\s+)?(only\s+)?submit(ting)? (only )?(a )?pdf\b|\bsubmit(ting)? (only )?(a )?pdf version of your (resume|cv)\b/i.test(
      cleanedLabel,
    ) &&
    !/\b(why|describe|explain|tell us|cover letter)\b/i.test(cleanedLabel)
  ) {
    if (control === "checkbox") return { action: { type: "options", values: [options[0] ?? ""] }, aiTrap, cleanedLabel };
    if (control === "radio" || control === "select" || control === "combobox") {
      const yes = options.find((o) => /\b(yes|pdf|acknowledge|confirm|understand|agree)\b/i.test(o)) ?? (options[0] || "Yes");
      return { action: { type: "option", value: yes }, aiTrap, cleanedLabel };
    }
    if (control === "text" || control === "textarea") return { action: { type: "literal", value: "PDF" }, aiTrap, cleanedLabel };
  }

  const general = /^(?:please\s+)?(?:type|enter|write|select|choose)\b|[.!?]\s+(?:please\s+)?(?:type|enter|write|select|choose)\b/i;
  if (general.test(cleanedLabel)) {
    const action = literalFrom(cleanedLabel, control, options);
    if (action) return { action, aiTrap, cleanedLabel };
  }

  return { action: null, aiTrap, cleanedLabel };
}
