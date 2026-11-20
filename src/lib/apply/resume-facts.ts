import { completeJson } from "@/lib/openrouter";
import { replaceResumeFacts, type FactInput } from "./fact-store";
import { isFactKey, isFactType } from "./facts";

const SYSTEM_PROMPT = [
  "You read a resume and list facts about the applicant for job application forms. Reply with JSON only:",
  '{"facts":[{"key":"<dotted.snake_case>","question":"<the question this answers, addressed to the applicant as you>","type":"boolean|text|number|list","value":<value>,"quote":"<exact words copied from the resume>"}]}',
  "Every fact needs a quote copied character for character from the resume that states it. No quote, no fact.",
  "Only facts the resume states. Never infer skills, grades, years, or providers it does not name.",
  "Keys to use when the resume supports them:",
  "skill.<name>.professional (boolean: used it at a job), skill.<name>.years (number, only when stated),",
  "skills.professional (list of tools and languages used at work), llm_providers.professional (list, e.g. OpenAI),",
  "cloud_providers.professional (list), languages.spoken (list), education.bachelor.field (text),",
  "education.bachelor.result (text: CGPA or class, only when written), employment.latest.title (text),",
  "employment.latest.company (text), employment.latest.start (text, month and year),",
  "employment.latest.end (text, month and year, or present only when the resume says present), experience.leadership (text),",
  "employment.employers (list: every company that employed you; not personal projects or your own ventures),",
  "experience.ai_features_shipped (boolean), experience.llm_professional (boolean).",
  "<name> is lowercase letters and digits only: nodejs, python, aws, kafka.",
].join("\n");

interface RawFact {
  key?: unknown;
  question?: unknown;
  type?: unknown;
  value?: unknown;
  quote?: unknown;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}+#.%]+/gu, " ").trim();
}

/** Facts from the model whose quote really appears in the resume; everything else is dropped. */
export function verifiedResumeFacts(raw: RawFact[], resumeText: string): FactInput[] {
  const haystack = squash(resumeText);
  const out: FactInput[] = [];
  for (const f of raw) {
    if (!isFactKey(f.key) || !isFactType(f.type) || typeof f.quote !== "string") continue;
    const quote = squash(f.quote);
    if (quote.length < 2 || !haystack.includes(quote)) continue;
    out.push({
      key: f.key,
      question: typeof f.question === "string" ? f.question : f.key,
      type: f.type,
      value: f.value,
      complete: false,
      source: "resume",
      evidence: `Resume: "${f.quote.trim().slice(0, 200)}"`,
    });
  }
  return out;
}

const CHECK_PROMPT = [
  "Each line is a fact about a job applicant followed by the resume words given as proof.",
  "A fact is supported only when the quoted words say it outright, not when it is a guess from them.",
  'Reply with JSON only: {"unsupported":[<line numbers>]}',
].join("\n");

/** Drops facts whose quote does not state them outright (one cheap call). */
async function dropInferred(facts: FactInput[]): Promise<FactInput[]> {
  if (facts.length === 0) return facts;
  const lines = facts.map((f, i) => `${i + 1}. ${f.question} = ${JSON.stringify(f.value)} | proof: ${f.evidence}`);
  const res = await completeJson<{ unsupported?: unknown }>({
    tier: "cheap",
    system: CHECK_PROMPT,
    prompt: lines.join("\n"),
    maxTokens: 300,
  });
  const bad = new Set(Array.isArray(res.data?.unsupported) ? res.data.unsupported.map(Number) : []);
  return facts.filter((_, i) => !bad.has(i + 1));
}

/** One strong-model call per resume. Lists from a resume are never complete: absence is not a No. */
export async function extractResumeFacts(resumeText: string): Promise<FactInput[]> {
  const { getOpenRouterApiKey } = await import("@/lib/secrets");
  if (!resumeText.trim() || !getOpenRouterApiKey()) return [];
  const res = await completeJson<{ facts?: RawFact[] }>({
    tier: "strong",
    system: SYSTEM_PROMPT,
    prompt: resumeText.slice(0, 12_000),
    maxTokens: 3_000,
  });
  return dropInferred(verifiedResumeFacts(Array.isArray(res.data?.facts) ? res.data.facts : [], resumeText));
}

export async function refreshResumeFacts(resumeText: string): Promise<{ saved: number; removed: number }> {
  const facts = await extractResumeFacts(resumeText);
  if (facts.length === 0) return { saved: 0, removed: 0 };
  return replaceResumeFacts(facts);
}
