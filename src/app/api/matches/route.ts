import { NextResponse } from "next/server";
import { fetchMatches, parseMatchQuery } from "@/lib/matches";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await fetchMatches(parseMatchQuery(new URL(request.url).searchParams)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
