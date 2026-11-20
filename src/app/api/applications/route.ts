import { NextResponse } from "next/server";
import {
  parseApplicationStatus,
  setManyJobApplications,
} from "@/lib/applications";
import { isApplicationStatus } from "@/lib/application-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      jobIds?: unknown;
      status?: unknown;
    };

    if (!Array.isArray(body.jobIds) || body.jobIds.length === 0) {
      return NextResponse.json(
        { error: "jobIds must be a non-empty array" },
        { status: 400 },
      );
    }

    const jobIds = body.jobIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (jobIds.length === 0) {
      return NextResponse.json(
        { error: "jobIds must contain string ids" },
        { status: 400 },
      );
    }

    // null clears status (back to "To apply"); otherwise must be a valid status
    let status: ReturnType<typeof parseApplicationStatus> = null;
    if (body.status !== null && body.status !== undefined) {
      if (!isApplicationStatus(body.status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      status = body.status;
    } else if (body.status === undefined) {
      return NextResponse.json(
        { error: "status is required (use null to clear)" },
        { status: 400 },
      );
    }

    const result = await setManyJobApplications(jobIds, status);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
