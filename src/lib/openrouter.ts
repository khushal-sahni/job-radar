export interface LlmEnrichmentResponse {
  country?: string;
  isRemote?: boolean;
  remoteScope?: string;
  visaSponsorship?: boolean | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  isBaseSalary?: boolean | null;
  salaryEstimated?: boolean;
  tags?: string[];
  requiredYearsMin?: number | null;
  requiredYearsMax?: number | null;
}

export class EnrichmentError extends Error {
  readonly attempts: string[];

  constructor(message: string, attempts: string[]) {
    super(message);
    this.name = "EnrichmentError";
    this.attempts = attempts;
  }
}

/** HTTP 402 from OpenRouter: the account has no credits, so every model in the chain will fail the same way. */
export class OutOfCreditsError extends Error {
  constructor(detail: string) {
    super(`AI provider is out of credits: ${detail}`);
    this.name = "OutOfCreditsError";
  }
}

export function isOutOfCredits(err: unknown): err is OutOfCreditsError {
  return err instanceof OutOfCreditsError;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TOKENS = 800;
const CHAIN_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CHAIN_LENGTH = 4;
/** Max prompt price per million tokens for paid Flash models ($). */
const MAX_PAID_PROMPT_PER_M = 0.5;

const LAST_RESORT_ALIASES = [
  "~google/gemini-flash-lite-latest",
  "~google/gemini-flash-latest",
] as const;

const GEMINI_FLASH_RE = /google\/gemini-.*flash/i;
const FLASH_LITE_RE = /flash-lite/i;

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  expiration_date?: string | null;
  architecture?: {
    output_modalities?: string[];
  };
}

interface CatalogCache {
  models: string[];
  expiresAt: number;
}

let catalogCache: CatalogCache | null = null;
let catalogPromise: Promise<string[]> | null = null;

function getTimeoutMs(): number {
  const parsed = Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function pricePerMillion(raw: string | undefined): number {
  if (raw == null || raw === "") return Number.POSITIVE_INFINITY;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken)) return Number.POSITIVE_INFINITY;
  return perToken * 1_000_000;
}

function isFreeModel(model: OpenRouterModel): boolean {
  if (model.id.endsWith(":free")) return true;
  const prompt = pricePerMillion(model.pricing?.prompt);
  const completion = pricePerMillion(model.pricing?.completion);
  return prompt === 0 && completion === 0;
}

function isExpired(model: OpenRouterModel): boolean {
  if (!model.expiration_date) return false;
  const expires = Date.parse(model.expiration_date);
  return Number.isFinite(expires) && expires < Date.now();
}

function isTextOutput(model: OpenRouterModel): boolean {
  const modalities = model.architecture?.output_modalities;
  if (!modalities || modalities.length === 0) return true;
  return modalities.includes("text");
}

function isGeminiFlash(model: OpenRouterModel): boolean {
  return GEMINI_FLASH_RE.test(model.id);
}

function flashLiteRank(id: string): number {
  // Prefer flash-lite over full flash when both exist.
  return FLASH_LITE_RE.test(id) ? 0 : 1;
}

function pickFreeFlash(models: OpenRouterModel[]): string[] {
  return models
    .filter((m) => isGeminiFlash(m) && isFreeModel(m))
    .sort((a, b) => {
      const lite = flashLiteRank(a.id) - flashLiteRank(b.id);
      if (lite !== 0) return lite;
      return a.id.localeCompare(b.id);
    })
    .map((m) => m.id);
}

function pickCheapPaidFlash(models: OpenRouterModel[]): string[] {
  return models
    .filter((m) => {
      if (!isGeminiFlash(m) || isFreeModel(m)) return false;
      const prompt = pricePerMillion(m.pricing?.prompt);
      return prompt < MAX_PAID_PROMPT_PER_M;
    })
    .sort((a, b) => {
      const price =
        pricePerMillion(a.pricing?.prompt) - pricePerMillion(b.pricing?.prompt);
      if (price !== 0) return price;
      const lite = flashLiteRank(a.id) - flashLiteRank(b.id);
      if (lite !== 0) return lite;
      return a.id.localeCompare(b.id);
    })
    .map((m) => m.id);
}

function envPreferences(): string[] {
  const prefs: string[] = [];
  const free = process.env.OPENROUTER_MODEL_FREE?.trim();
  const fallback = process.env.OPENROUTER_MODEL_FALLBACK?.trim();
  if (free) prefs.push(free);
  if (fallback) prefs.push(fallback);
  return prefs;
}

function buildChainFromCatalog(models: OpenRouterModel[]): string[] {
  const liveIds = new Set(models.map((m) => m.id));
  const free = pickFreeFlash(models);
  const paid = pickCheapPaidFlash(models);

  const chain: string[] = [];
  const push = (id: string): void => {
    if (chain.length >= MAX_CHAIN_LENGTH) return;
    if (!chain.includes(id)) chain.push(id);
  };

  // Env preferences only if they appear in the live catalog.
  for (const pref of envPreferences()) {
    if (liveIds.has(pref)) push(pref);
  }

  for (const id of free) push(id);
  for (const id of paid) push(id);

  return chain;
}

async function fetchCatalogModels(apiKey: string): Promise<OpenRouterModel[]> {
  const url =
    "https://openrouter.ai/api/v1/models?supported_parameters=response_format&output_modalities=text";
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Catalog HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data?: OpenRouterModel[] };
  const models = data.data ?? [];
  return models.filter((m) => !isExpired(m) && isTextOutput(m));
}

async function resolveModelChain(apiKey: string): Promise<string[]> {
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) {
    return catalogCache.models;
  }

  if (catalogPromise) {
    return catalogPromise;
  }

  catalogPromise = (async () => {
    try {
      const models = await fetchCatalogModels(apiKey);
      let chain = buildChainFromCatalog(models);
      if (chain.length === 0) {
        chain = [...LAST_RESORT_ALIASES];
      }
      catalogCache = {
        models: chain,
        expiresAt: Date.now() + CHAIN_CACHE_TTL_MS,
      };
      return chain;
    } catch {
      // Catalog unavailable — use stable family aliases, not pinned versions.
      const fallback = [...LAST_RESORT_ALIASES];
      catalogCache = {
        models: fallback,
        expiresAt: Date.now() + CHAIN_CACHE_TTL_MS,
      };
      return fallback;
    } finally {
      catalogPromise = null;
    }
  })();

  return catalogPromise;
}

function stripMarkdownFences(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseJsonReply<T>(content: string): T {
  const cleaned = stripMarkdownFences(content);
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`JSON parse failed: ${message}`);
  }
}

function buildPrompt(job: {
  title: string;
  company: string;
  location?: string;
  description: string;
}): string {
  return `Extract structured job data from this posting. Return JSON only.
Fields: country (ISO 2-letter), isRemote (bool), remoteScope (worldwide|india|europe|us|region_locked|unknown),
visaSponsorship (bool|null), salaryMin, salaryMax, salaryCurrency (ISO 4217), isBaseSalary (bool|null),
salaryEstimated (bool), requiredYearsMin (number|null), requiredYearsMax (number|null), tags (string[] tech keywords).
For remoteScope: US-only / "must be located in X" / "candidates in the US" is us or region_locked even if the post says fully remote. Use worldwide only for true work-from-anywhere / worldwide hiring.

Job title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? "unknown"}
Description excerpt: ${job.description.slice(0, 3000)}`;
}

const ENRICH_SYSTEM =
  "You extract job posting metadata. Respond with valid JSON only. Use null for unknown fields.";

async function callModelOnce<T = LlmEnrichmentResponse>(
  model: string,
  prompt: string,
  apiKey: string,
  system = ENRICH_SYSTEM,
  maxTokens = MAX_TOKENS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.OPENROUTER_SITE_URL ?? "http://localhost:3001",
        "X-Title": "Job Radar",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        provider: {
          require_parameters: true,
          allow_fallbacks: true,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 402) throw new OutOfCreditsError(body.slice(0, 200));
      const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Empty model response");
    }

    return parseJsonReply<T>(content);
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_STRONG_MODELS = ["~google/gemini-pro-latest", "~anthropic/claude-sonnet-latest"];

/**
 * Small JSON completion. `cheap` walks the same free/cheap Flash chain as enrichment;
 * `strong` uses OPENROUTER_MODEL_STRONG (comma list) or a pro-tier alias.
 */
export async function completeJson<T>(options: {
  tier: "cheap" | "strong";
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<{ data: T; model: string }> {
  const { getOpenRouterApiKey } = await import("@/lib/secrets");
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new EnrichmentError("OPENROUTER_API_KEY is not set", []);
  }

  const chain =
    options.tier === "cheap"
      ? await resolveModelChain(apiKey)
      : (process.env.OPENROUTER_MODEL_STRONG?.split(",").map((s) => s.trim()).filter(Boolean) ??
        DEFAULT_STRONG_MODELS);

  const attempts: string[] = [];
  for (const model of chain.length > 0 ? chain : DEFAULT_STRONG_MODELS) {
    try {
      const data = await callModelOnce<T>(
        model,
        options.prompt,
        apiKey,
        options.system,
        options.maxTokens ?? 400,
      );
      return { data, model };
    } catch (err) {
      if (isOutOfCredits(err)) throw err;
      attempts.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new EnrichmentError(`All ${options.tier} models failed: ${attempts.join(" | ")}`, attempts);
}

/** Call a model; on JSON parse failure retry the same model once. */
async function callModel(
  model: string,
  prompt: string,
  apiKey: string,
): Promise<LlmEnrichmentResponse> {
  try {
    return await callModelOnce(model, prompt, apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("JSON parse failed")) {
      throw err;
    }
    // Truncated / malformed JSON — one same-model retry, then caller tries next.
    return await callModelOnce(model, prompt, apiKey);
  }
}

export async function enrichWithOpenRouter(job: {
  title: string;
  company: string;
  location?: string;
  description: string;
}): Promise<{ data: LlmEnrichmentResponse; model: string }> {
  const { getOpenRouterApiKey } = await import("@/lib/secrets");
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new EnrichmentError(
      "OPENROUTER_API_KEY is not set — add it in Setup or Settings",
      [],
    );
  }

  const prompt = buildPrompt(job);
  const attempts: string[] = [];
  const chain = await resolveModelChain(apiKey);

  for (const model of chain) {
    try {
      const data = await callModel(model, prompt, apiKey);
      return { data, model };
    } catch (err) {
      if (isOutOfCredits(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      attempts.push(`${model}: ${message}`);
      // Any failure (404, 429, 5xx, timeout, empty, JSON) → try next model.
    }
  }

  throw new EnrichmentError(
    `All OpenRouter models failed. Attempts: ${attempts.join(" | ")}`,
    attempts,
  );
}
