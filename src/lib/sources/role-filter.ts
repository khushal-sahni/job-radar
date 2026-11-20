/** Shared title filter for ATS adapters — backend / full-stack / platform roles. */
export const BACKEND_TITLE_PATTERN =
  /\b(backend|back-end|full[\s-]?stack|platform[\s-]*(engineer|engineering)|(engineer|engineering)[\s-]*platform|infrastructure[\s-]*(engineer|engineering)|(engineer|engineering)[\s-]*infrastructure|api|distributed|software engineer|software development engineer|sde\d?|systems engineer|sre|devops engineer)\b/i;

/**
 * Applied AI / LLM / agent product roles — not research ML or data science.
 * Do not match bare "agent" (customer success, real estate, etc.).
 */
export const APPLIED_AI_TITLE_PATTERN =
  /\b(ai\s+engineer|llm\s+engineer|applied\s+ai|applied\s+llm|genai\s+engineer|generative\s+ai\s+engineer|ai\s+application\s+engineer|agent\s+engineer)\b/i;

/** Backend/platform OR applied-AI titles for ATS ingest and probe. */
export const ROLE_TITLE_PATTERN = new RegExp(
  `(?:${BACKEND_TITLE_PATTERN.source}|${APPLIED_AI_TITLE_PATTERN.source})`,
  "i",
);
