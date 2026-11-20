import { NextResponse } from "next/server";
import { getDailyCap, startOfLocalDay } from "@/lib/apply/queue";
import { OUT_OF_CREDITS_REASON, activeRunPid, readRunResult } from "@/lib/apply/lock";
import { getApplyInbox } from "@/lib/apply/inbox";
import { systemHealth } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const inbox = await getApplyInbox(startOfLocalDay());
    const running = activeRunPid(process.cwd()) != null;
    const lastRun = readRunResult(process.cwd());
    return NextResponse.json({
      ...inbox,
      dailyCap: await getDailyCap(),
      running,
      lastRun,
      outOfCredits: !running && lastRun?.skippedReason === OUT_OF_CREDITS_REASON,
      health: systemHealth(process.cwd()),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load auto-apply state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
