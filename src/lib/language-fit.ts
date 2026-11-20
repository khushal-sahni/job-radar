const LANGUAGE_PATTERNS: Array<{ canonical: string; pattern: RegExp }> = [
  { canonical: "typescript", pattern: /\btypescript\b/gi },
  { canonical: "javascript", pattern: /\bjavascript\b|\bnode\.?js\b|\bnodejs\b/gi },
  { canonical: "python", pattern: /\bpython\b/gi },
  { canonical: "csharp", pattern: /\bc#\b|\bcsharp\b|\bc-sharp\b/gi },
  { canonical: "kotlin", pattern: /\bkotlin\b/gi },
  { canonical: "rust", pattern: /\brust\b/gi },
  { canonical: "ruby", pattern: /\bruby\b/gi },
  { canonical: "scala", pattern: /\bscala\b/gi },
  { canonical: "php", pattern: /\bphp\b/gi },
  { canonical: "go", pattern: /\bgolang\b|\bgo\b/gi },
  { canonical: "java", pattern: /\bjava\b/gi },
];

const ALIASES: Record<string, string> = {
  java: "java",
  typescript: "typescript",
  javascript: "javascript",
  js: "javascript",
  "node.js": "javascript",
  nodejs: "javascript",
  node: "javascript",
  python: "python",
  go: "go",
  golang: "go",
  rust: "rust",
  kotlin: "kotlin",
  ruby: "ruby",
  php: "php",
  csharp: "csharp",
  "c#": "csharp",
  scala: "scala",
};

const ANY_LANGUAGE_CLAUSE =
  /\bany\s+(?:[\w-]+\s+){0,4}languages?\b|\b(?:polyglot|language[-\s]?agnostic)\b/i;

const HARD_REQUIREMENT =
  /\b(?:required|must have|mandatory|expertise in|strong (?:hands[-\s]?on )?experience (?:in|with)|hands[-\s]?on expertise in|\d+\+?\s*years?(?:\s+of)?)\b/i;

export function canonicalizeLanguage(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return ALIASES[key] ?? null;
}

export function extractLanguages(text: string): Set<string> {
  const found = new Set<string>();
  if (!text) return found;

  for (const { canonical, pattern } of LANGUAGE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.add(canonical);
  }

  return found;
}

export function languagesFromSkills(skills: string[]): Set<string> {
  const found = new Set<string>();
  for (const skill of skills) {
    const aliased = canonicalizeLanguage(skill);
    if (aliased) {
      found.add(aliased);
      continue;
    }
    for (const lang of extractLanguages(skill)) found.add(lang);
  }
  return found;
}

function isExclusiveAvoidedSet(
  languages: Set<string>,
  avoid: Set<string>,
): boolean {
  if (languages.size === 0) return false;
  for (const lang of languages) {
    if (!avoid.has(lang)) return false;
  }
  return true;
}

function hasHardExclusiveRequirement(text: string, avoid: Set<string>): boolean {
  const lower = text.toLowerCase();
  for (const lang of avoid) {
    const escaped = lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    for (const match of lower.matchAll(re)) {
      const idx = match.index ?? 0;
      const window = lower.slice(Math.max(0, idx - 80), idx + lang.length + 80);
      if (!HARD_REQUIREMENT.test(window)) continue;

      const others = extractLanguages(window);
      others.delete(lang);
      if (others.size > 0) continue;
      return true;
    }
  }
  return false;
}

/**
 * True when the job's required stack is only avoided languages
 * (e.g. Java-only) and the resume does not list that language.
 * Polyglot postings (Java / TypeScript / any language) pass.
 *
 * Title + tags are the primary signal so a Java shop that mentions
 * JavaScript once in boilerplate still counts as exclusive Java.
 */
export function isExclusiveAvoidedLanguageJob(input: {
  title: string;
  description: string;
  tags: string[];
  resumeSkills: string[];
  avoidLanguages: string[];
}): boolean {
  const avoid = new Set<string>();
  for (const raw of input.avoidLanguages) {
    const canonical = canonicalizeLanguage(raw) ?? raw.trim().toLowerCase();
    if (canonical) avoid.add(canonical);
  }
  if (avoid.size === 0) return false;

  const userLangs = languagesFromSkills(input.resumeSkills);
  for (const lang of avoid) {
    if (userLangs.has(lang)) return false;
  }

  const haystack = `${input.title}\n${input.description}`;
  if (ANY_LANGUAGE_CLAUSE.test(haystack)) return false;

  const primary = extractLanguages(`${input.title} ${input.tags.join(" ")}`);
  if (isExclusiveAvoidedSet(primary, avoid)) return true;
  if (primary.size > 0) return false;

  const body = extractLanguages(input.description);
  if (isExclusiveAvoidedSet(body, avoid)) return true;

  return (
    body.size === 0 && hasHardExclusiveRequirement(haystack, avoid)
  );
}
