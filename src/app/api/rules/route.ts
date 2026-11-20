import { NextResponse } from "next/server";
import { extensionCorsHeaders } from "@/lib/extension-cors";
import { getSavedRules, saveRules } from "@/lib/rule-store";
import { parseRules } from "@/lib/rules";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: extensionCorsHeaders(origin),
  });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  return NextResponse.json(await getSavedRules(), { headers: extensionCorsHeaders(origin) });
}

export async function PUT(request: Request) {
  const headers = extensionCorsHeaders(request.headers.get("origin"));
  try {
    const body = (await request.json()) as { rules: unknown };
    const rules = parseRules(body.rules);
    if (rules.length === 0) return NextResponse.json({ error: "Invalid rules" }, { status: 400, headers });
    return NextResponse.json(await saveRules(rules), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500, headers });
  }
}
