import { NextResponse } from "next/server";
import { runDatabaseSetup } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await runDatabaseSetup();
    return NextResponse.json(result, { status: result.status === "done" ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database setup failed";
    return NextResponse.json(
      { status: "error", embedded: true, message },
      { status: 500 },
    );
  }
}
