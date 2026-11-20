import { NextResponse } from "next/server";
import { startNaukriLogin } from "@/lib/apply/launch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Opens the Naukri login page in the Naukri Chrome; the login is saved once you finish. */
export async function POST() {
  try {
    return NextResponse.json(startNaukriLogin(process.cwd()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open the Naukri login";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
