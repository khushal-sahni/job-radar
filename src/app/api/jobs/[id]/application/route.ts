import { NextResponse } from "next/server";
import {
  parseApplicationStatus,
  setJobApplication,
} from "@/lib/applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { status?: unknown };
    const status = parseApplicationStatus(body.status ?? null);

    if (body.status != null && status === null && body.status !== null) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const result = await setJobApplication(id, status);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const result = await setJobApplication(id, null);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
