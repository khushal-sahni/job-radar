import { NextResponse } from "next/server";
import {
  getUserProfile,
  updateUserProfile,
  type UserProfilePayload,
} from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function corsHeaders(origin: string | null): HeadersInit {
  const allowed =
    origin &&
    (origin.startsWith("chrome-extension://") ||
      origin === "http://localhost:3000" ||
      origin === "http://127.0.0.1:3000");

  return {
    "Access-Control-Allow-Origin": allowed ? origin : "http://localhost:3000",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  const { searchParams } = new URL(request.url);
  const includeResume = searchParams.get("includeResume") === "true";

  try {
    const profile = await getUserProfile({ includeResumePdf: includeResume });
    return NextResponse.json(profile, { headers: corsHeaders(origin) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load profile";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: corsHeaders(origin) },
    );
  }
}

export async function PUT(request: Request) {
  const origin = request.headers.get("origin");

  try {
    const body = (await request.json()) as Partial<UserProfilePayload>;
    const profile = await updateUserProfile(body);
    return NextResponse.json(profile, { headers: corsHeaders(origin) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json(
      { error: message },
      { status: 400, headers: corsHeaders(origin) },
    );
  }
}
