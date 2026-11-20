import { NextResponse } from "next/server";
import { extensionCorsHeaders, isAllowedOrigin } from "@/lib/extension-cors";
import { startApplyRun } from "@/lib/apply/launch";
import { prepareUrlRun } from "@/lib/apply/manual-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: extensionCorsHeaders(request.headers.get("origin")) });
}

/**
 * `{ url, fill? }`: applies to one job link from the feed field or the extension shortcut, in a
 * watched run. `fill: true` fills the form and leaves it open without submitting. Links not in
 * Job Radar are added as jobs first. LinkedIn is refused.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = extensionCorsHeaders(origin);
  // Any open web page can send a simple POST to localhost; only the app and the extension may start a run.
  if ((origin && !isAllowedOrigin(origin)) || !request.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403, headers });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { url?: unknown; fill?: unknown };
    if (typeof body.url !== "string") return NextResponse.json({ error: "Paste a job link" }, { status: 400, headers });
    const root = process.cwd();
    const prepared = await prepareUrlRun(root, body.url, { fill: body.fill === true });
    if ("skip" in prepared) return NextResponse.json({ started: false, reason: prepared.skip }, { headers });
    if ("queued" in prepared) return NextResponse.json({ started: false, queued: true, reason: prepared.queued }, { headers });
    const run = startApplyRun(root, prepared.plan);
    return NextResponse.json({ ...run, company: prepared.company, title: prepared.title }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start the apply run";
    return NextResponse.json({ error: message }, { status: 500, headers });
  }
}
