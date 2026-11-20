import { NextResponse, after } from "next/server";
import { refreshResumeFacts } from "@/lib/apply/resume-facts";
import { extensionCorsHeaders } from "@/lib/extension-cors";
import { ResumeInputError, importResumePdf, latestResumeSummary } from "@/lib/resume-store";

export const runtime = "nodejs";
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
  return NextResponse.json({ resume: await latestResumeSummary() }, { headers: extensionCorsHeaders(origin) });
}

export async function POST(request: Request) {
  try {
    const file = (await request.formData()).get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "PDF file required" }, { status: 400 });
    }

    const { resume, rawText } = await importResumePdf(file.name, Buffer.from(await file.arrayBuffer()));

    after(async () => {
      try {
        const res = await refreshResumeFacts(rawText);
        console.log(`[resume] facts from resume: ${res.saved} saved, ${res.removed} removed`);
      } catch (err) {
        console.error(`[resume] fact extraction failed: ${err instanceof Error ? err.message : err}`);
      }
    });

    const { id, filename, skills, seniority, roles } = resume;
    return NextResponse.json({ id, filename, skills, seniority, roles });
  } catch (error) {
    if (error instanceof ResumeInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
