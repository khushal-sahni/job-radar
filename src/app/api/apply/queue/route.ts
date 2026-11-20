import { NextResponse } from "next/server";
import { queueFeedJobs, queueJobs } from "@/lib/apply/queue";
import { parseMatchQuery } from "@/lib/matches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ jobId }` queues one feed job; `{ filter }` (the feed's query params) queues every job those
 * filters show. Nothing is started; Apply now or the daily run picks them up.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; filter?: unknown };
    if (typeof body.jobId === "string") {
      return NextResponse.json(await queueJobs([body.jobId]));
    }
    if (body.filter && typeof body.filter === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body.filter as Record<string, unknown>)) {
        if (typeof value === "string") params.set(key, value);
      }
      const query = parseMatchQuery(params);
      return NextResponse.json(
        await queueFeedJobs(query.dateRange ?? "7d", {
          branchId: query.branchId ?? null,
          statusFilter: query.statusFilter ?? "open",
          country: query.country ?? "all",
        }),
      );
    }
    return NextResponse.json({ error: "Send a jobId or the feed filter" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue jobs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
