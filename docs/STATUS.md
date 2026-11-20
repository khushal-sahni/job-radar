# STATUS.md
> Public project status. Personal session notes live in gitignored `journal/`.
> Last updated: `2026-11-20`

---

## What works

- Cross-platform starters (Mac / Windows / Linux) open the app without a terminal workflow
- Setup dialog creates an embedded Postgres (PGlite) database, checks Chrome, saves the OpenRouter key, and walks through profile / rules / schedule
- Existing installs with `DATABASE_URL` keep using that database
- Editable job branches (not raw JSON), find schedule, opt-in auto-apply, daily cap, optional Naukri
- In-app scheduler while the app is running (no launchd / systemd install required)
- Job sources, matching rules, feed, and auto-apply runner as before

## Known limits

- Node.js must be installed once by the user
- Auto-apply needs Google Chrome; some sites block bundled Chromium
- Gmail is optional; forms that need emailed codes park when it is missing

## How to run

See [README.md](../README.md).
