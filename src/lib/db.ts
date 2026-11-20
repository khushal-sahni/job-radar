import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/generated/prisma/client";
import { ensureEmbeddedDatabase } from "@/lib/embedded-db";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaPromise: Promise<PrismaClient> | undefined;
};

function createPrismaClient(connectionString: string): PrismaClient {
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

/** Ensures the embedded or external database is up and returns a Prisma client. */
export async function ensureDb(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  if (!globalForPrisma.prismaPromise) {
    globalForPrisma.prismaPromise = (async () => {
      const { connectionString } = await ensureEmbeddedDatabase();
      const client = createPrismaClient(connectionString);
      globalForPrisma.prisma = client;
      return client;
    })();
  }
  return globalForPrisma.prismaPromise;
}

function syncClient(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "Database is not ready. Call ensureDb() first, or set DATABASE_URL.",
    );
  }
  const client = createPrismaClient(connectionString);
  globalForPrisma.prisma = client;
  return client;
}

/**
 * Prisma client. Prefer `await ensureDb()` at process start (instrumentation / setup).
 * After that, `db` works like before.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = syncClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
