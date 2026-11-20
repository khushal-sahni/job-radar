import type { Prisma } from "@/generated/prisma/client";
import type { RuleBranch } from "./types";

export function rulesToJson(rules: RuleBranch[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(rules)) as Prisma.InputJsonValue;
}
