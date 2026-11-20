import { NextResponse } from "next/server";
import { saveAnswers } from "@/lib/apply/question-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { answers?: unknown };
    if (!Array.isArray(body.answers)) {
      return NextResponse.json({ error: "answers must be an array" }, { status: 400 });
    }
    const answers = body.answers
      .filter(
        (a): a is { fingerprint: string; answer: string; complete?: unknown } =>
          typeof a?.fingerprint === "string" &&
          typeof a?.answer === "string" &&
          // An empty complete list is an answer: none of them.
          (a.answer.trim() !== "" || a.complete === true),
      )
      .map((a) => ({
        fingerprint: a.fingerprint,
        answer: a.answer,
        ...(typeof a.complete === "boolean" ? { complete: a.complete } : {}),
      }));

    const result = await saveAnswers(answers);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save answers";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
