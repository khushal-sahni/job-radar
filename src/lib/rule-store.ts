import { db } from "./db";
import { parseRules } from "./rules";
import { rulesToJson } from "./rules-json";
import { DEFAULT_RULES, type RuleBranch } from "./types";

/** The saved preference rules (one default RuleSet row), created from DEFAULT_RULES on first use. */

async function defaultRuleSet() {
  return db.ruleSet.findFirst({ where: { isDefault: true }, orderBy: { updatedAt: "desc" } });
}

export async function ensureDefaultRules(): Promise<void> {
  if (await defaultRuleSet()) return;
  await db.ruleSet.create({
    data: { name: "Default preferences", rules: rulesToJson(DEFAULT_RULES), isDefault: true },
  });
}

/** Rules every matching run uses. */
export async function getActiveRules(): Promise<RuleBranch[]> {
  await ensureDefaultRules();
  const ruleSet = await defaultRuleSet();
  return parseRules(ruleSet?.rules ?? []);
}

/** For the settings form: the saved rules, or the defaults when nothing is saved yet. */
export async function getSavedRules(): Promise<{ rules: RuleBranch[]; id: string | null }> {
  const ruleSet = await defaultRuleSet();
  return { rules: parseRules(ruleSet?.rules ?? DEFAULT_RULES), id: ruleSet?.id ?? null };
}

export async function saveRules(rules: RuleBranch[]): Promise<{ rules: RuleBranch[]; id: string }> {
  const existing = await defaultRuleSet();
  const ruleSet = existing
    ? await db.ruleSet.update({ where: { id: existing.id }, data: { rules: rulesToJson(rules) } })
    : await db.ruleSet.create({ data: { name: "Default preferences", rules: rulesToJson(rules), isDefault: true } });
  return { rules: parseRules(ruleSet.rules), id: ruleSet.id };
}
