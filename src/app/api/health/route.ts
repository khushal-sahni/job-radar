import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function corsHeaders(origin: string | null): HeadersInit {
  const allowed =
    origin &&
    (origin.startsWith("chrome-extension://") ||
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1:"));

  return {
    "Access-Control-Allow-Origin": allowed ? origin : "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  return NextResponse.json(
    { ok: true, app: "job-radar" },
    { headers: corsHeaders(origin) },
  );
}
