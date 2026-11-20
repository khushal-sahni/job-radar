import { NextResponse } from "next/server";
import { ingestPushedJobs } from "@/lib/ingest";
import type { RawJob } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.INGEST_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { jobs: RawJob[] };
    if (!Array.isArray(body.jobs)) {
      return NextResponse.json({ error: "Expected { jobs: RawJob[] }" }, { status: 400 });
    }
    const result = await ingestPushedJobs(body.jobs);
    return NextResponse.json({
      received: result.fetched,
      upserted: result.upserted,
      enriched: result.enriched,
      skipped: result.skipped,
      keywordSkipped: result.keywordSkipped,
      unchanged: result.unchanged,
      errors: result.errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
