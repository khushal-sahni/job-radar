import { NextResponse } from "next/server";
import {
  DEFAULT_AVOID_IF_EXCLUSIVE_LANGUAGES,
  DEFAULT_DAILY_APPLY_CAP,
  DEFAULT_EXCLUDE_TITLE_KEYWORDS,
  DEFAULT_SCHEDULE_HOUR,
  DEFAULT_YEARS_OF_EXPERIENCE,
  getPreferences,
  updatePreferences,
} from "@/lib/preferences";
import { extensionCorsHeaders } from "@/lib/extension-cors";

export const dynamic = "force-dynamic";

function prefsJson(prefs: Awaited<ReturnType<typeof getPreferences>>) {
  return {
    yearsOfExperience: prefs.yearsOfExperience,
    excludeTitleKeywords: prefs.excludeTitleKeywords,
    avoidIfExclusiveLanguages: prefs.avoidIfExclusiveLanguages,
    findScheduleEnabled: prefs.findScheduleEnabled,
    applyScheduleEnabled: prefs.applyScheduleEnabled,
    scheduleHour: prefs.scheduleHour,
    dailyApplyCap: prefs.dailyApplyCap,
    naukriEnabled: prefs.naukriEnabled,
  };
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: extensionCorsHeaders(origin),
  });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  const prefs = await getPreferences();
  return NextResponse.json(prefsJson(prefs), {
    headers: extensionCorsHeaders(origin),
  });
}

export async function PUT(request: Request) {
  const origin = request.headers.get("origin");
  try {
    const body = (await request.json()) as {
      yearsOfExperience?: number;
      excludeTitleKeywords?: string[];
      avoidIfExclusiveLanguages?: string[];
      findScheduleEnabled?: boolean;
      applyScheduleEnabled?: boolean;
      scheduleHour?: number;
      dailyApplyCap?: number;
      naukriEnabled?: boolean;
    };

    const prefs = await updatePreferences({
      yearsOfExperience: body.yearsOfExperience,
      excludeTitleKeywords: body.excludeTitleKeywords,
      avoidIfExclusiveLanguages: body.avoidIfExclusiveLanguages,
      findScheduleEnabled: body.findScheduleEnabled,
      applyScheduleEnabled: body.applyScheduleEnabled,
      scheduleHour: body.scheduleHour,
      dailyApplyCap: body.dailyApplyCap,
      naukriEnabled: body.naukriEnabled,
    });

    // Keep defaults available for partial clients that omit fields.
    void DEFAULT_YEARS_OF_EXPERIENCE;
    void DEFAULT_EXCLUDE_TITLE_KEYWORDS;
    void DEFAULT_AVOID_IF_EXCLUSIVE_LANGUAGES;
    void DEFAULT_SCHEDULE_HOUR;
    void DEFAULT_DAILY_APPLY_CAP;

    return NextResponse.json(prefsJson(prefs), {
      headers: extensionCorsHeaders(origin),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json(
      { error: message },
      { status: 400, headers: extensionCorsHeaders(origin) },
    );
  }
}
