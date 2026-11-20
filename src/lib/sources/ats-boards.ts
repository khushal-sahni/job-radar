import fs from "node:fs";
import path from "node:path";

export type AtsVendor = "greenhouse" | "lever" | "ashby" | "workable";

export interface AtsBoard {
  vendor: AtsVendor;
  slug: string;
}

interface AtsBoardFile {
  version: number;
  updatedAt?: string;
  notes?: string;
  boards: AtsBoard[];
  /** Slugs demoted after 404 — never re-added from seed until manually cleared. */
  demoted?: Array<{ vendor: AtsVendor; slug: string; at: string }>;
  /** Slugs harvested from apply URLs or probe. */
  promoted?: Array<{ vendor: AtsVendor; slug: string; at: string; source?: string }>;
}

const VENDORS: AtsVendor[] = ["greenhouse", "lever", "ashby", "workable"];

const URL_PATTERNS: Array<{ vendor: AtsVendor; regex: RegExp }> = [
  {
    vendor: "greenhouse",
    regex: /(?:boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?|job-boards\.greenhouse\.io\/)([a-z0-9_-]+)/i,
  },
  {
    vendor: "lever",
    regex: /(?:jobs|api)\.lever\.co\/(?:v0\/postings\/)?([a-z0-9_-]+)/i,
  },
  {
    vendor: "ashby",
    regex: /(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([a-z0-9_-]+)/i,
  },
  {
    vendor: "workable",
    regex: /apply\.workable\.com\/(?!j\/|api\/)([a-z0-9_-]+)/i,
  },
];

function seedPath(): string {
  return path.join(process.cwd(), "src/lib/sources/ats-boards.json");
}

function overlayPath(): string {
  return path.join(process.cwd(), ".cache/ats-boards.json");
}

function boardKey(board: AtsBoard): string {
  return `${board.vendor}:${board.slug.toLowerCase()}`;
}

function slugKey(slug: string): string {
  return slug.toLowerCase();
}

function readJsonFile(filePath: string): AtsBoardFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as AtsBoardFile;
  } catch {
    return null;
  }
}

function emptyOverlay(): AtsBoardFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    boards: [],
    demoted: [],
    promoted: [],
  };
}

function loadOverlay(): AtsBoardFile {
  return readJsonFile(overlayPath()) ?? emptyOverlay();
}

function writeOverlay(overlay: AtsBoardFile): void {
  const dir = path.dirname(overlayPath());
  fs.mkdirSync(dir, { recursive: true });
  overlay.updatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(overlayPath(), JSON.stringify(overlay, null, 2) + "\n");
}

function normalizeBoard(board: AtsBoard): AtsBoard | null {
  if (!VENDORS.includes(board.vendor)) return null;
  const slug = board.slug?.trim().toLowerCase();
  if (!slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return null;
  return { vendor: board.vendor, slug };
}

/**
 * Merge committed seed + runtime overlay.
 * - Demoted boards are excluded.
 * - Promoted boards are added.
 * - A slug is assigned to at most one vendor (first wins: seed order, then promoted).
 */
export function getAtsBoards(vendor?: AtsVendor): AtsBoard[] {
  const seed = readJsonFile(seedPath());
  const overlay = loadOverlay();

  const demoted = new Set(
    (overlay.demoted ?? []).map((d) => boardKey({ vendor: d.vendor, slug: d.slug })),
  );
  const usedSlugs = new Set<string>();
  const result: AtsBoard[] = [];

  const candidates: AtsBoard[] = [
    ...(seed?.boards ?? []),
    ...(overlay.promoted ?? []).map((p) => ({
      vendor: p.vendor,
      slug: p.slug,
    })),
    ...(overlay.boards ?? []),
  ];

  for (const raw of candidates) {
    const board = normalizeBoard(raw);
    if (!board) continue;
    if (demoted.has(boardKey(board))) continue;
    if (usedSlugs.has(slugKey(board.slug))) continue;
    if (vendor && board.vendor !== vendor) continue;

    usedSlugs.add(slugKey(board.slug));
    result.push(board);
  }

  return result;
}

export function getAtsSlugs(vendor: AtsVendor): string[] {
  return getAtsBoards(vendor).map((b) => b.slug);
}

/** Record a 404 so daily ingest stops retrying this board. */
export function demoteAtsBoard(
  vendor: AtsVendor,
  slug: string,
  reason = "404",
): void {
  const board = normalizeBoard({ vendor, slug });
  if (!board) return;

  const overlay = loadOverlay();
  const key = boardKey(board);
  overlay.demoted = overlay.demoted ?? [];
  if (!overlay.demoted.some((d) => boardKey(d) === key)) {
    overlay.demoted.push({
      vendor: board.vendor,
      slug: board.slug,
      at: new Date().toISOString(),
    });
  }

  // Also drop from promoted/boards lists if present
  overlay.promoted = (overlay.promoted ?? []).filter(
    (p) => boardKey(p) !== key,
  );
  overlay.boards = (overlay.boards ?? []).filter((b) => boardKey(b) !== key);

  writeOverlay(overlay);
  console.warn(`[ats-boards] demoted ${vendor}/${board.slug} (${reason})`);
}

/** Add a live board discovered via probe or apply-URL harvest. */
export function promoteAtsBoard(
  vendor: AtsVendor,
  slug: string,
  source = "harvest",
): boolean {
  const board = normalizeBoard({ vendor, slug });
  if (!board) return false;

  // Already active?
  const existing = getAtsBoards().find(
    (b) => slugKey(b.slug) === slugKey(board.slug),
  );
  if (existing) {
    // Same vendor already present — nothing to do
    if (existing.vendor === board.vendor) return false;
    // Different vendor owns the slug — do not steal
    return false;
  }

  const overlay = loadOverlay();
  const key = boardKey(board);

  // Clear demotion if we're explicitly promoting again
  overlay.demoted = (overlay.demoted ?? []).filter((d) => boardKey(d) !== key);
  overlay.promoted = overlay.promoted ?? [];
  if (!overlay.promoted.some((p) => boardKey(p) === key)) {
    overlay.promoted.push({
      vendor: board.vendor,
      slug: board.slug,
      at: new Date().toISOString(),
      source,
    });
    writeOverlay(overlay);
    console.log(`[ats-boards] promoted ${vendor}/${board.slug} via ${source}`);
    return true;
  }

  return false;
}

/** Extract ATS board slugs from job apply/hosted URLs. */
export function harvestAtsBoardsFromUrls(urls: string[]): number {
  let added = 0;
  const seen = new Set<string>();

  for (const url of urls) {
    if (!url) continue;
    for (const { vendor, regex } of URL_PATTERNS) {
      const match = url.match(regex);
      if (!match?.[1]) continue;
      const slug = match[1].toLowerCase();
      // Skip path segments that are not board tokens
      if (slug === "v1" || slug === "v0" || slug === "postings" || slug === "embed") {
        continue;
      }
      const key = `${vendor}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (promoteAtsBoard(vendor, slug, "url-harvest")) {
        added += 1;
      }
    }
  }

  return added;
}

/** Write probe results into the runtime overlay (promoted list). */
export function applyProbeResults(
  boards: AtsBoard[],
  source = "probe",
): { promoted: number; skipped: number } {
  let promoted = 0;
  let skipped = 0;
  for (const board of boards) {
    if (promoteAtsBoard(board.vendor, board.slug, source)) {
      promoted += 1;
    } else {
      skipped += 1;
    }
  }
  return { promoted, skipped };
}

export function isAtsVendor(value: string): value is AtsVendor {
  return VENDORS.includes(value as AtsVendor);
}
