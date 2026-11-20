import { completeJson, isOutOfCredits } from "@/lib/openrouter";
import { bucket } from "./facts";
import { fieldKeys } from "./fingerprint";
import { countryRow, isCountryList } from "./identity";
import { matchOption } from "./profile-map";
import type { ResolveContext } from "./context";
import { findRecipe, saveRecipe } from "./recipe-store";

export interface OptionChoice {
  option: string;
  source: "recipe" | "match" | "cheap_model";
}

const SYSTEM_PROMPT = [
  "You pick one entry from a dropdown on a job application, filled on behalf of the applicant.",
  'Reply with JSON only: {"index": <1-based number of the option>} or {"index": null} when no option is the same thing the applicant means.',
  "A place must be the same place (same city and country), not a similar name. A country must be that country, not a territory or region containing its name.",
].join("\n");

/**
 * Picks one of the options a dropdown showed after typing `query`, cheapest first:
 * the saved pick for this label + query + home country, a unique whole-word match, then one
 * cheap-model call whose pick is saved. Null when nothing fits; the caller must not guess.
 */
export async function chooseOption(input: {
  label: string;
  query: string;
  /** What the applicant means, e.g. the full profile location "Gurugram, India". */
  wanted: string;
  options: string[];
  ctx: ResolveContext;
}): Promise<OptionChoice | null> {
  const { label, query, wanted, options, ctx } = input;
  if (options.length === 0) return null;
  const home = ctx.profile.country || "";
  const keys = fieldKeys({
    vendor: ctx.vendor,
    control: "combobox",
    label: `${label} @ ${query}`,
    options: [home],
    company: ctx.company,
  });

  // A country is matched by name or not at all: a model once picked "Bangladesh" for "Indian" and it was saved and replayed.
  if (isCountryList(options)) {
    const option = countryRow(wanted, options, home);
    return option ? { option, source: "match" } : null;
  }
  // A number goes in the range that holds it; a model once put 4 years in "0 - 1.5 years".
  if (/^\d+(\.\d+)?$/.test(wanted.trim())) {
    const option = bucket(Number(wanted.trim()), options) ?? matchOption(wanted, options);
    return option ? { option, source: "match" } : null;
  }

  const saved = await findRecipe(keys).catch(() => null);
  if (saved?.action.type === "option") {
    const option = matchOption(saved.action.value, options);
    if (option) return { option, source: "recipe" };
  }

  const match = matchOption(wanted, options, home);
  if (match) return { option: match, source: "match" };

  const { getOpenRouterApiKey } = await import("@/lib/secrets");
  if (!getOpenRouterApiKey()) return null;
  const list = options.slice(0, 40);
  try {
    const res = await completeJson<{ index: number | null }>({
      tier: "cheap",
      system: SYSTEM_PROMPT,
      prompt: JSON.stringify({
        field: label,
        applicantMeans: wanted,
        applicantCountry: home || undefined,
        options: list.map((text, i) => `${i + 1}. ${text}`),
      }),
      maxTokens: 60,
    });
    const index = Number(res.data?.index);
    const option = Number.isInteger(index) && index >= 1 && index <= list.length ? list[index - 1] : null;
    if (!option) return null;
    await saveRecipe({ keys, label: `${label} @ ${query}`, action: { type: "option", value: option }, source: "cheap_model", model: res.model });
    return { option, source: "cheap_model" };
  } catch (err) {
    if (isOutOfCredits(err)) throw err;
    ctx.log?.(`  option model failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    return null;
  }
}
