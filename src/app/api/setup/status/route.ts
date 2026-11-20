import { NextResponse } from "next/server";
import { getSetupStatus } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getSetupStatus();
    return NextResponse.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup status failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
