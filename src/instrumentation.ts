export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureEmbeddedDatabase } = await import("@/lib/embedded-db");
  const { ensureDb } = await import("@/lib/db");
  const { startScheduler } = await import("@/lib/scheduler");

  try {
    await ensureEmbeddedDatabase();
    // Schema push is owned by the setup dialog so a first-run failure is visible there.
    // Existing installs already have tables; ensureDb just opens the client.
    if (process.env.DATABASE_URL) {
      await ensureDb().catch(() => undefined);
    }
  } catch (err) {
    console.error(
      "[instrumentation] database start failed:",
      err instanceof Error ? err.message : err,
    );
  }

  startScheduler();
}
