import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  embeddedDbDir,
  embeddedDbPortFile,
  ensureUserDataDir,
  projectRoot,
} from "./paths";

const EMBEDDED_PORT_PREFERRED = 55_432;
const EMBEDDED_HOST = "127.0.0.1";

type EmbeddedHandle = {
  connectionString: string;
  stop: () => Promise<void>;
};

const globalForEmbedded = globalThis as unknown as {
  __jobRadarEmbedded?: EmbeddedHandle;
  __jobRadarEmbeddedPromise?: Promise<EmbeddedHandle>;
};

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, EMBEDDED_HOST);
  });
}

async function pickPort(): Promise<number> {
  const saved = (() => {
    try {
      const n = Number(fs.readFileSync(embeddedDbPortFile(), "utf-8").trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  })();

  for (const candidate of [saved, EMBEDDED_PORT_PREFERRED, 55_433, 55_434, 55_435]) {
    if (candidate == null) continue;
    if (!(await portInUse(candidate))) return candidate;
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, EMBEDDED_HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => {
        if (err || !port) reject(err ?? new Error("Could not pick a free port"));
        else resolve(port);
      });
    });
  });
}

function connectionStringFor(port: number): string {
  return `postgresql://postgres:postgres@${EMBEDDED_HOST}:${port}/postgres`;
}

/** True when the operator already pointed the app at an external Postgres. */
export function hasExternalDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function isUsingEmbeddedDatabase(): boolean {
  return Boolean(globalForEmbedded.__jobRadarEmbedded) && !hasExternalDatabaseUrl();
}

async function startEmbedded(): Promise<EmbeddedHandle> {
  ensureUserDataDir();
  const dataDir = embeddedDbDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await pickPort();
  fs.writeFileSync(embeddedDbPortFile(), `${port}\n`, "utf-8");

  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const db = await PGlite.create({ dataDir });
  const server = new PGLiteSocketServer({
    db,
    host: EMBEDDED_HOST,
    port,
  });
  await server.start();

  const connectionString = connectionStringFor(port);
  process.env.DATABASE_URL = connectionString;

  return {
    connectionString,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

/**
 * Ensures Postgres is reachable. Uses DATABASE_URL when set; otherwise starts
 * an embedded PGlite server in the user-data folder and sets DATABASE_URL.
 */
export async function ensureEmbeddedDatabase(): Promise<{
  connectionString: string;
  embedded: boolean;
}> {
  const existing = process.env.DATABASE_URL?.trim();
  if (existing) {
    return { connectionString: existing, embedded: false };
  }

  if (globalForEmbedded.__jobRadarEmbedded) {
    process.env.DATABASE_URL = globalForEmbedded.__jobRadarEmbedded.connectionString;
    return {
      connectionString: globalForEmbedded.__jobRadarEmbedded.connectionString,
      embedded: true,
    };
  }

  if (!globalForEmbedded.__jobRadarEmbeddedPromise) {
    globalForEmbedded.__jobRadarEmbeddedPromise = startEmbedded().then((handle) => {
      globalForEmbedded.__jobRadarEmbedded = handle;
      return handle;
    });
  }

  const handle = await globalForEmbedded.__jobRadarEmbeddedPromise;
  process.env.DATABASE_URL = handle.connectionString;
  return { connectionString: handle.connectionString, embedded: true };
}

/** Push the Prisma schema onto the current DATABASE_URL. */
export function pushPrismaSchema(): { ok: true } | { ok: false; error: string; log: string } {
  const root = projectRoot();
  const result = spawnSync("npx", ["prisma", "db", "push"], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env },
    shell: process.platform === "win32",
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    return {
      ok: false,
      error: "Could not create the local database tables.",
      log: log || `prisma db push exited with code ${result.status}`,
    };
  }
  return { ok: true };
}

export async function probeDatabase(connectionString: string): Promise<boolean> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** True when local Docker Postgres is the configured DATABASE_URL host:port. */
export function isLocalDockerDatabaseUrl(url = process.env.DATABASE_URL ?? ""): boolean {
  try {
    const parsed = new URL(url);
    const port = parsed.port || "5432";
    return (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      (port === "5433" || port === "5432")
    );
  } catch {
    return false;
  }
}

export function dockerComposeDir(): string | null {
  const root = projectRoot();
  // Prefer the older local-job-radar compose when present so existing volumes stay attached.
  const candidates = [
    path.join(root, "local-job-radar", "docker-compose.yml"),
    path.join(root, "docker-compose.yml"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return path.dirname(file);
  }
  return null;
}
