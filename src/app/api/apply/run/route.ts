import { NextResponse } from "next/server";
import { startApplyRun } from "@/lib/apply/launch";
import { prepareRun, type RunScope } from "@/lib/apply/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES: Record<string, RunScope> = { answered: "answered", now: "now", look: "fill", fill: "fill" };

/**
 * `{ scope: "answered" }` (default, "Fill the rest"): tasks whose questions are all answered.
 * `{ scope: "now" }` ("Apply now"): the whole queue plus captcha-parked tasks, someone watching.
 * `{ scope: "fill", taskId? }` ("Fill these"): parked tasks filled and left open, never submitted.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { scope?: string; taskId?: string };
    const root = process.cwd();
    const scope = SCOPES[body.scope ?? "answered"] ?? "answered";
    const prepared = await prepareRun(root, scope, { taskId: typeof body.taskId === "string" ? body.taskId : undefined });
    if ("skip" in prepared) return NextResponse.json({ started: false, reason: prepared.skip });
    return NextResponse.json({ ...startApplyRun(root, prepared.plan), tasks: prepared.tasks, captcha: prepared.captcha });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start apply run";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
