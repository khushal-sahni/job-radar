import { NextResponse } from "next/server";
import { deleteFact, editFact, listStoredFacts } from "@/lib/apply/fact-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ facts: await listStoredFacts() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load facts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Edit one fact's value. An edited fact is yours: the resume never overwrites it. */
export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { key?: unknown; value?: unknown; complete?: unknown };
    if (typeof body.key !== "string") return NextResponse.json({ error: "key is required" }, { status: 400 });
    const result = await editFact(body.key, body.value, typeof body.complete === "boolean" ? body.complete : undefined);
    if (result.ok) return NextResponse.json({ ok: true, value: result.value });
    if (result.error === "not_found") return NextResponse.json({ error: "Fact not found" }, { status: 404 });
    return NextResponse.json({ error: `That is not a valid ${result.type} value` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save fact";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const key = new URL(request.url).searchParams.get("key");
    if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
    if (!(await deleteFact(key))) return NextResponse.json({ error: "Fact not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete fact";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
