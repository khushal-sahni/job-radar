# DECISIONS.md
> Durable product rules for the public tree. Personal session decisions live in `journal/DECISIONS.md`.

---

### 2026-11-20 — Single-user local app with embedded database

- **Decision**: Job Radar runs on one person's computer. New installs use embedded Postgres (PGlite) in the OS user-data folder. `DATABASE_URL` remains an optional override.
- **Why**: Docker and a hand-edited `.env` are too much friction for a non-technical first run.
- **Consequences**: Leave the app open for the daily schedule. No multi-user auth in this version.

### 2026-11-20 — Setup dialog owns first-run technical work

- **Decision**: A browser setup dialog starts the database, checks Chrome, validates the OpenRouter key, then collects profile, rules, and schedule. Starters on Mac / Windows / Linux only install deps and open the app.
- **Why**: The person should not type shell commands for a normal install.
- **Consequences**: Node.js is still a one-time system install the app cannot perform for them.

### 2026-11-20 — Auto-apply is opt-in

- **Decision**: Scheduled apply defaults off. The find schedule can run alone. Turning apply on asks for confirmation and states that real applications will be submitted (never on LinkedIn).
- **Why**: Auto-submit is powerful and easy to misunderstand.
- **Consequences**: **Apply now** on the feed stays a manual action and does not depend on the schedule.

### 2026-10-06 — No LinkedIn automation

- **Decision**: Never scrape, automate, or call LinkedIn APIs for the user's account. Auto-apply skips LinkedIn URLs.
- **Why**: Account risk is non-negotiable.
- **Consequences**: Career-site ATS boards and opt-in local sources only.

### 2026-09 — Salary-gated branches fail without listed pay

- **Decision**: Jobs without a listed salary fail salary-gated rule branches.
- **Why**: Guessing pay produces false matches.
- **Consequences**: Do not loosen this unless the user explicitly asks.
