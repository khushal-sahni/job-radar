import { NextResponse } from "next/server";
import { activeRunPid } from "@/lib/apply/lock";
import { requeueParkedTasks } from "@/lib/apply/task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Puts every "needs a look" task back in the auto-apply queue. Nothing is started. */
export async function POST() {
  try {
    if (activeRunPid(process.cwd())) {
      return NextResponse.json({ error: "An apply run is in progress; kill it or wait for it to finish" }, { status: 409 });
    }
    return NextResponse.json({ requeued: await requeueParkedTasks() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Re-queue failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
