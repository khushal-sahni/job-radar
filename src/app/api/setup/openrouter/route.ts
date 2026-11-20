import { NextResponse } from "next/server";
import { updateSecrets } from "@/lib/secrets";
import { validateOpenRouterKey } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { apiKey?: string };
    const apiKey = body.apiKey?.trim() ?? "";
    const check = await validateOpenRouterKey(apiKey);
    if (!check.ok) {
      return NextResponse.json({ error: check.message }, { status: 400 });
    }
    updateSecrets({ openRouterApiKey: apiKey });
    return NextResponse.json({ ok: true, message: check.message });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save key";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
