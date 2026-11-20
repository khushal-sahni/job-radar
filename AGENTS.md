<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md
> AI agent instructions for this project. Read this before writing any code.

---

## Project Overview

- **Name**: Job Radar
- **Purpose**: Personal job-matching engine — upload resume, set compound salary/location/visa rules, get backend/full-stack roles that actually match (no LinkedIn scraping). Single-user local app with a setup dialog for non-technical onboarding.
- **Stack**: Next.js 16 (App Router), TypeScript, Tailwind CSS 4, React 19
- **Database**: PostgreSQL via Prisma 7 (`@prisma/adapter-pg` + `pg`). New installs use embedded PGlite in the OS user-data folder; `DATABASE_URL` overrides when set.
- **Background jobs**: In-app scheduler while the app is running; Inngest stub remains unused
- **Key External Services**: Arbeitnow API, RemoteOK, Greenhouse/Lever/Ashby/Workable ATS boards, OpenRouter (enrichment + apply), open.er-api.com (FX rates). Optional Gmail for emailed codes.

---

## Architecture

### Pattern
Next.js App Router with a **thin route layer** and **domain logic in `src/lib/`**. No class-based service/repository layers — use focused modules and plain functions.

### Directory Structure
```
src/
├── app/                    # Routes, pages, API handlers
│   ├── feed/               # Main job feed (server component + client shell)
│   ├── setup/              # First-run setup dialog
│   ├── settings/           # Preference rules UI
│   └── api/
│       ├── setup/          # Database + OpenRouter setup
│       ├── ingest/         # POST — pull jobs from all sources
│       ├── matches/        # GET — matched jobs JSON
│       ├── resume/         # POST/GET — PDF upload + profile
│       ├── rules/          # GET/PUT — preference rules
│       └── inngest/        # Inngest serve endpoint (stub)
├── components/             # React UI components
├── inngest/                # Inngest client + scheduled functions (future)
├── generated/prisma/       # Prisma client (generated — do not edit)
└── lib/
    ├── sources/            # Job source adapters (arbeitnow, adzuna, remoteok, greenhouse)
    ├── db.ts               # Prisma singleton
    ├── ingest.ts           # Ingestion orchestrator
    ├── enrich.ts           # Salary/visa/remote extraction (heuristics + optional LLM)
    ├── rules.ts            # Compound rules engine (OR logic across branches)
    ├── match.ts            # Resume fit scoring
    ├── matches.ts          # Server-side match fetching
    ├── fx.ts               # Currency conversion + formatting
    └── types.ts            # Shared types + DEFAULT_RULES
```

### Data Flow
```
Sources (APIs) → normalize RawJob → enrich (salary/visa/remote/INR) → upsert Job
                                                                    ↓
User rules (RuleSet) + Resume → rules engine → matched feed + fit score
```

### Strict Layer Rules
- **API routes** parse request/response only — call `lib/` functions, no inline business logic
- **Pages** fetch via server components where possible; client components only for interactivity
- **Source adapters** fetch + normalize only — no rule evaluation, no DB writes
- **`lib/ingest.ts`** orchestrates fetch → enrich → upsert
- **`lib/rules.ts`** is pure — no DB, no HTTP
- **No LinkedIn access** — never scrape or automate LinkedIn. Passive opt-in companion may read DOM on pages the user opened, and may click the visible “… more” on the selected job only (see DECISIONS).

---

## Domain Rules (Product Logic)

A job **matches if ANY rule branch passes** (OR logic):

| Branch | Criteria |
|---|---|
| `remote-india` | Remote, eligible from India, ≥₹35 LPA |
| `india-onsite` | Non-remote India, ≥₹40 LPA **base** (rejects CTC/total comp) |
| `germany` | Germany, ≥€70k, visa sponsorship confirmed |
| `japan` | Japan, ≥¥8M, visa sponsorship confirmed |

Jobs without listed salary **fail** salary-gated branches — intentional, not a bug.

Default rules live in `src/lib/types.ts` as `DEFAULT_RULES`. Persisted copy in `RuleSet` table.

---

## Coding Standards

### TypeScript
- **Strict mode is on** — avoid `any`; prefer explicit return types on exported functions
- Shared types in `src/lib/types.ts`
- Use `interface` for data shapes; keep functions small and focused

### Naming
| Thing | Convention | Example |
|---|---|---|
| Files (lib) | kebab-case or descriptive | `rules.ts`, `arbeitnow.ts` |
| React components | PascalCase | `JobCard.tsx` |
| Functions | camelCase, verb-first | `fetchMatches`, `evaluateJob` |
| Constants | SCREAMING_SNAKE | `DEFAULT_RULES` |
| DB models | PascalCase (Prisma) | `RuleSet`, `Job` |

### Next.js Conventions
- Server Components by default; `"use client"` only when needed
- API routes that use Node APIs (PDF parse, Prisma): `export const runtime = "nodejs"`
- Dynamic data routes: `export const dynamic = "force-dynamic"`
- Prisma client import: `@/generated/prisma/client`

### Error Handling
- API routes return `{ error: string }` with appropriate HTTP status
- Ingestion collects per-source errors in result object — don't fail entire batch on one source
- Never swallow errors silently in ingestion pipeline

---

## What NOT to Do

- ❌ No LinkedIn scraping, automation, bulk page reads, or LinkedIn API calls — user's account is off-limits. Opt-in extension may read already-rendered DOM and click “… more” on the job the user already opened — never list cards, Apply, or fetches.
- ❌ No aggressive scraping — respect rate limits (Greenhouse: 300ms delay between boards)
- ❌ No business logic in React components — keep it in `lib/`
- ❌ No direct DB access from components — use API routes or server lib functions
- ❌ No editing `src/generated/prisma/` — run `npm run db:generate` instead
- ❌ No hardcoded secrets — OpenRouter/Gmail go in the user-data secrets file or optional `.env` (see `.env.example`)
- ❌ Don't loosen salary rules to "include jobs without salary" unless explicitly requested
- ❌ Don't put personal session notes in public `docs/` — use gitignored `journal/`

---

## Testing Expectations

- No test suite yet — add when requested or when stabilizing for productization
- When adding tests: unit test `lib/rules.ts` and `lib/enrich.ts` first (highest value, pure logic)
- Manual smoke test: `npm run build`, `POST /api/ingest`, check `/feed`

---

## Session Instructions for AI Agent

At the **start** of each session:
1. Read `docs/STATUS.md` to understand current project state
2. Read `docs/ROADMAP.md` to understand what's next
3. Optionally read `journal/STATUS.md` for personal session context (gitignored)
4. Confirm scope with the engineer before large changes

During the session:
- Follow all rules in this file
- Match existing patterns in `src/lib/` — don't introduce new abstractions for one-offs
- Keep diffs focused — this is a personal tool first, product second
- When adding a new job source: adapter in `src/lib/sources/`, register in `index.ts`, document in STATUS

At the **end** of every session, before closing:
1. Update public `docs/STATUS.md` / `docs/CHANGELOG.md` / `docs/DECISIONS.md` for anything that belongs in the open-source tree
2. Append personal session detail to `journal/STATUS.md` and `journal/CHANGELOG.md`
3. Note any new tech debt under tech debt in the public STATUS or journal as appropriate
