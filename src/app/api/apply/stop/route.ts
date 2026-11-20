import { NextResponse } from "next/server";
import { stopApplyRun } from "@/lib/apply/lock";
import { requeueInterruptedTasks } from "@/lib/apply/task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kills the active apply run; tasks it left mid-apply go back in the queue with their try. */
export async function POST() {
  try {
    const stopped = await stopApplyRun(process.cwd());
    const requeued = stopped ? await requeueInterruptedTasks("Run was stopped") : 0;
    return NextResponse.json({ stopped, requeued });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not stop the run";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
