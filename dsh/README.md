# DSH experiment — retired

This folder was an experiment using DeepSeek Harness (`dsh`) to web-search for
jobs and POST them into Job Radar. The **intent** was right (more coverage +
daily schedule). The **implementation** was not: overlapping schedulers, a
5-minute poll daemon, a broken launchd plist, and a hard dependency on Next.js
being up — plus thin search-snippet jobs that recreate the Adzuna quality problem.

## What replaced it

Job Radar now does this natively:

1. **First-party ATS adapters** — Greenhouse (expanded), Lever, Ashby — plus
   Arbeitnow and RemoteOK. No LinkedIn scraping, no DeepSeek CLI.
2. **Recency + stale cleanup** — skip enriching jobs older than 30 days; deactivate
   listings not refreshed for 14 days.
3. **Once-daily launchd** — `npm run ingest:install` installs
   `com.jobradar.ingest` with `StartCalendarInterval` at 08:00 local. If the Mac
   was asleep, launchd fires the job when it wakes. No 5-minute checkers.

```bash
# Manual run (Postgres only — Next.js not required)
npm run ingest:daily

# Force even if last run was < 20h ago
npm run ingest:daily -- --force

# Install / reinstall the LaunchAgent
npm run ingest:install
```

Logs: `~/Library/Logs/job-radar-ingest.log`

## Archaeology

Files left here for reference only — **not wired**:

| File | Was |
|------|-----|
| `job-radar.instruct.md` | Agent search/query instructions |
| `job-watcher.cordis.yml` | DSH schedule plugin overlay |
| `run-watcher.sh` | Cron/DSH CLI runner |
| `watcher-daemon.js` | 5-minute poll loop (do not use) |
| `com.jobradar.watcher.plist` | Broken LaunchAgent (pointed at missing `run-watcher.js`) |
| `cleanup-jobs.js` | Ad-hoc SQL stale cleanup (now inside `src/lib/ingest.ts`) |

`POST /api/ingest-web` remains as a manual dump hatch if you ever want to POST
structured jobs by hand. Daily discovery does not use it.
