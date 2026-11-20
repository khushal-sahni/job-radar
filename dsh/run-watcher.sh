#!/bin/bash
# Job Radar Watcher - runs web search via DSH and ingests into Job Radar
# Runs at 6am and 6pm daily via cron
#
# Put DEEPSEEK_API_KEY in dsh/.env (gitignored). Do not inline it here.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_RADAR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DSH_HARNESS_DIR="/Users/khushalsahni/Documents/Projects/deepseek-harness"
INGEST_URL="http://localhost:3001/api/ingest-web"
LOG_FILE="/tmp/job-watcher.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "[$TIMESTAMP] DEEPSEEK_API_KEY is not set. Add it to $SCRIPT_DIR/.env (not committed)." >> "$LOG_FILE"
  exit 1
fi

if ! curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
  echo "[$TIMESTAMP] Job Radar is not running, skipping" >> "$LOG_FILE"
  exit 0
fi

# Step 1: Clean up stale jobs older than 30 days
echo "[$TIMESTAMP] Cleaning up stale jobs..." >> "$LOG_FILE"
cd "$JOB_RADAR_DIR" && node dsh/cleanup-jobs.js >> "$LOG_FILE" 2>&1
cd "$SCRIPT_DIR"

# Step 2: Run web search for fresh jobs
echo "[$TIMESTAMP] Starting job search..." >> "$LOG_FILE"

cd "$DSH_HARNESS_DIR" && \
  node --import tsx/esm apps/cli/src/bin.ts --profile headless \
  "Use web_search with 3-4 queries to find RECENTLY posted (within last 7 days) senior software engineer and backend engineer jobs in India and Japan.

CRITICAL RULES:
1. ONLY include jobs posted within the past 7 days. Reject anything older.
2. PREFER direct company career pages (google.com/careers, jobs.smartrecruiters.com, linkedin.com/jobs, companies' own career sites). AVOID aggregators like foundit.in, echojobs.io, fastapply.co, startup.jobs, scoutify.com, cutshort.io, naukri.com, nexisgrow.com, hiring.fm, mncjobsindia.com, ambitionbox.com, japan-dev.com, themuse.com.
3. Extract: title, company, url, location, country (IN/JP/DE/US), isRemote, salary if visible, tags for tech stack. Include postedAt date.

Use queries like:
- 'site:linkedin.com/jobs/view senior software engineer india posted past week'
- 'site:google.com/about/careers software engineer bengaluru OR hyderabad OR india'
- 'site:jobs.smartrecruiters.com linkedin senior software engineer bengaluru'
- '\"software engineer\" japan visa sponsorship hired lately'

POST each valid job to $INGEST_URL with source 'web-search'. Use unique externalId format: web-search-company-brief-title.
Report back total found, how many were recent, and which companies had openings." \
  >> "$LOG_FILE" 2>&1

echo "[$TIMESTAMP] Job search complete" >> "$LOG_FILE"
