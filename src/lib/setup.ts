import { getChromeStatus } from "@/lib/chrome";
import { ensureDb } from "@/lib/db";
import {
  ensureEmbeddedDatabase,
  hasExternalDatabaseUrl,
  probeDatabase,
  pushPrismaSchema,
} from "@/lib/embedded-db";
import { getUserProfile } from "@/lib/profile";
import { hasOpenRouterKey } from "@/lib/secrets";

export type SetupStepId = "database" | "chrome" | "openrouter" | "profile" | "rules" | "schedule";

export type StepStatus = "pending" | "running" | "done" | "error" | "needs_action";

export interface SetupStatus {
  configured: boolean;
  database: {
    status: StepStatus;
    embedded: boolean;
    message: string;
    log?: string;
  };
  chrome: {
    status: StepStatus;
    message: string;
    downloadUrl: string;
  };
  openRouter: {
    status: StepStatus;
    hasKey: boolean;
    message: string;
  };
  profile: {
    status: StepStatus;
    hasEmail: boolean;
    message: string;
  };
}

const CHROME_DOWNLOAD = "https://www.google.com/chrome/";

export async function getSetupStatus(): Promise<SetupStatus> {
  let database: SetupStatus["database"] = {
    status: "pending",
    embedded: !hasExternalDatabaseUrl(),
    message: "Not started",
  };

  try {
    const ensured = await ensureEmbeddedDatabase();
    const reachable = await probeDatabase(ensured.connectionString);
    if (!reachable) {
      database = {
        status: "error",
        embedded: ensured.embedded,
        message: "The local database did not start.",
      };
    } else {
      await ensureDb();
      database = {
        status: "done",
        embedded: ensured.embedded,
        message: ensured.embedded
          ? "Jobs will be saved on this computer."
          : "Using the database from DATABASE_URL.",
      };
    }
  } catch (err) {
    database = {
      status: "error",
      embedded: !hasExternalDatabaseUrl(),
      message: err instanceof Error ? err.message : "Database setup failed",
    };
  }

  const chrome = await getChromeStatus();
  let chromeStatus: SetupStatus["chrome"];
  if (!chrome.installed) {
    chromeStatus = {
      status: "needs_action",
      message: "Install Google Chrome, then continue.",
      downloadUrl: CHROME_DOWNLOAD,
    };
  } else if (chrome.isGoogleChrome) {
    chromeStatus = {
      status: "done",
      message: "Google Chrome is ready.",
      downloadUrl: CHROME_DOWNLOAD,
    };
  } else {
    chromeStatus = {
      status: "needs_action",
      message: chrome.note,
      downloadUrl: CHROME_DOWNLOAD,
    };
  }

  const hasKey = hasOpenRouterKey();
  const openRouter: SetupStatus["openRouter"] = {
    status: hasKey ? "done" : "pending",
    hasKey,
    message: hasKey ? "OpenRouter key is saved." : "Paste your OpenRouter key.",
  };

  let hasEmail = false;
  let profileMessage = "Add your name and email.";
  if (database.status === "done") {
    try {
      const profile = await getUserProfile();
      hasEmail = Boolean(profile.email.trim());
      profileMessage = hasEmail ? "Profile is ready." : "Add your name and email.";
    } catch {
      profileMessage = "Profile will be available after the database is ready.";
    }
  }

  const configured = database.status === "done" && hasKey && hasEmail;

  return {
    configured,
    database,
    chrome: chromeStatus,
    openRouter,
    profile: {
      status: hasEmail ? "done" : "pending",
      hasEmail,
      message: profileMessage,
    },
  };
}

export async function runDatabaseSetup(): Promise<SetupStatus["database"]> {
  try {
    const ensured = await ensureEmbeddedDatabase();
    const pushed = pushPrismaSchema();
    if (!pushed.ok) {
      return {
        status: "error",
        embedded: ensured.embedded,
        message: pushed.error,
        log: pushed.log,
      };
    }
    await ensureDb();
    const reachable = await probeDatabase(ensured.connectionString);
    if (!reachable) {
      return {
        status: "error",
        embedded: ensured.embedded,
        message: "Tables were created, but the database did not respond.",
      };
    }
    return {
      status: "done",
      embedded: ensured.embedded,
      message: ensured.embedded
        ? "Jobs will be saved on this computer."
        : "Using the database from DATABASE_URL.",
    };
  } catch (err) {
    return {
      status: "error",
      embedded: !hasExternalDatabaseUrl(),
      message: err instanceof Error ? err.message : "Database setup failed",
    };
  }
}

export async function validateOpenRouterKey(apiKey: string): Promise<{
  ok: boolean;
  message: string;
}> {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: "Paste an OpenRouter API key." };

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "That key was refused. Check it on openrouter.ai." };
    }
    if (!res.ok) {
      return {
        ok: false,
        message: `OpenRouter returned HTTP ${res.status}. Try again in a moment.`,
      };
    }
    return { ok: true, message: "OpenRouter key works." };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Could not reach OpenRouter.",
    };
  }
}
