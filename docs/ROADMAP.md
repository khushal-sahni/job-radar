# ROADMAP.md
> High-level direction. Not a sprint board — just where we're going.
> Keep this coarse. Fine-grained tasks live in the session conversation.

---

## 🎯 Goal

A personal job radar that replaces scrolling LinkedIn: upload resume, set compound rules (salary + location + visa), and get a filtered feed of backend/full-stack roles from clean legal sources. Built product-ready so auth, gating, and payments can be added later without a rewrite.

**v1 "done enough"**: A non-technical person can start on Mac/Linux/Windows via the setup dialog, daily find runs while the app is open, feed shows matched jobs with accurate rule explanations, resume fit scoring works, auto-apply is opt-in, zero LinkedIn risk.

---

## Milestones

### M0 — Foundation `[x]`
> Project scaffolded and runnable locally

- [x] Next.js + TypeScript + Tailwind scaffold
- [x] Prisma schema + Postgres adapter
- [x] Environment config (`.env.example`)
- [x] AGENTS.md + docs/ from template, adapted for Job Radar
- [ ] Database connected and schema pushed (blocked on user setting `DATABASE_URL`)

---

### M1 — Core Domain (Phase 1 MVP) `[x]`
> The minimum thing that makes this project *this* project

- [x] Job source adapters (Arbeitnow, RemoteOK, Greenhouse, Adzuna)
- [x] Enrichment: salary, visa, remote scope, INR normalization
- [x] Compound rules engine (4-branch OR logic)
- [x] Resume upload + fit scoring
- [x] Feed UI with match cards and explanations
- [x] Manual ingest via API / UI button
- [ ] First successful ingest with real DB (pending Neon setup)

---

### M2 — Daily Driver (Phase 2) `[~]`
> Actually useful every morning without manual work

- [ ] Japan Dev adapter (respectful, low-frequency)
- [x] Expand Greenhouse company list + Lever/Ashby adapters
- [x] Dead job cleanup (mark inactive when not refreshed for 14d)
- [x] Scheduled ingestion via launchd 08:00 (Inngest deferred for local)
- [ ] New-match alerts (Telegram bot or email digest — TBD)
- [ ] Editable rules form in `/settings` (not just JSON view)
- [x] Scheduled auto-apply after ingest: saved-answer ladder, questions modal on the feed, daily cap
- [ ] Auto-apply on Naukri verified live (needs one-time login)

---

### M3 — Productize (Phase 3) `[ ]`
> The money-making machine — only after match quality is proven

- [ ] Auth.js login (schema already has `User`)
- [ ] Gate ~30% of results for anonymous users (blur + login prompt)
- [ ] Stripe: free tier (10 results/day) + paid unlimited + alerts
- [ ] Landing page with value prop
- [x] Optional passive LinkedIn companion extension (user-initiated page reads only, default-off)

---

### M4+ — Future Ideas `[ ]`
> Backlog — nice to have, not blocking

- Lever / Ashby adapters (done 2026-09-14) — Workable still backlog
- Company WLB score overlay (manual research layer, not auto)
- "Applied" / "Saved" / "Rejected" tracking
- Salary estimate confidence scores
- Shareable rule presets ("Remote India 35L+", "Germany visa")
- Browser extension for any job page (not just LinkedIn)

---

## What We're NOT Building (Scope Cuts)

- **No LinkedIn scraping or automation** — user's account/brand is non-negotiable
- **No recruiter spam or mass-apply**: auto-apply is personal and paced (daily cap of 15, matched jobs only, LinkedIn never), and anything sensitive or uncertain waits for the user. See DECISIONS 2026-10-06
- **No mobile app** — web-first
- **No admin panel** — personal tool until M3
- **No WLB scoring automation** — user researches companies separately
- **No i18n** — English UI, multi-currency salary display only
- **No TheirStack or paid B2B APIs** — free/legal sources only for personal use
