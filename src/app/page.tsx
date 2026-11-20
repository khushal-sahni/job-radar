import { redirect } from "next/navigation";
import { ensureDb } from "@/lib/db";
import { ensureEmbeddedDatabase } from "@/lib/embedded-db";
import { getUserProfile } from "@/lib/profile";
import { hasOpenRouterKey } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export default async function Home() {
  let ready = false;
  try {
    await ensureEmbeddedDatabase();
    await ensureDb();
    const profile = await getUserProfile();
    ready = hasOpenRouterKey() && Boolean(profile.email.trim());
  } catch {
    ready = false;
  }

  redirect(ready ? "/feed" : "/setup");
}
