import { NextResponse } from "next/server";
import {
  getGmailUser,
  getSecrets,
  hasOpenRouterKey,
  updateSecrets,
} from "@/lib/secrets";
import { validateOpenRouterKey } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    hasOpenRouterKey: hasOpenRouterKey(),
    gmailUser: getGmailUser() ?? "",
    hasGmailAppPassword: Boolean(getSecrets().gmailAppPassword || process.env.GMAIL_APP_PASSWORD),
  });
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      openRouterApiKey?: string;
      gmailUser?: string;
      gmailAppPassword?: string;
      clearGmail?: boolean;
    };

    if (body.openRouterApiKey != null && body.openRouterApiKey.trim()) {
      const check = await validateOpenRouterKey(body.openRouterApiKey);
      if (!check.ok) {
        return NextResponse.json({ error: check.message }, { status: 400 });
      }
      updateSecrets({ openRouterApiKey: body.openRouterApiKey });
    }

    if (body.clearGmail) {
      updateSecrets({ gmailUser: "", gmailAppPassword: "" });
    } else if (body.gmailUser != null || body.gmailAppPassword != null) {
      updateSecrets({
        gmailUser: body.gmailUser,
        gmailAppPassword: body.gmailAppPassword,
      });
    }

    return NextResponse.json({
      hasOpenRouterKey: hasOpenRouterKey(),
      gmailUser: getGmailUser() ?? "",
      hasGmailAppPassword: Boolean(getSecrets().gmailAppPassword || process.env.GMAIL_APP_PASSWORD),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save secrets";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
