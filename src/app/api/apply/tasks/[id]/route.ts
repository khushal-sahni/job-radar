import { NextResponse } from "next/server";
import { resolveNeedsYou } from "@/lib/apply/task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set(["applied", "dismiss", "retry"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { action?: unknown };
    if (typeof body.action !== "string" || !ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "action must be applied, dismiss, or retry" }, { status: 400 });
    }
    await resolveNeedsYou(id, body.action as "applied" | "dismiss" | "retry");
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    const status = message === "Task not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
