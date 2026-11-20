/**
 * Job Radar watcher daemon - runs every 5 minutes, checks if 12 hours passed,
 * and runs the DSH job if Job Radar is up.
 * 
 * Runs with launchd. No cron, no sudo, no wake events needed.
 * 
 * To start: launchctl load -w ~/Library/LaunchAgents/com.jobradar.watcher.plist
 * To stop: launchctl unload ~/Library/LaunchAgents/com.jobradar.watcher.plist
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Use the built dsh CLI directly instead of the bash script
const DSH_CLI = '/Users/khushalsahni/Documents/Projects/deepseek-harness/apps/cli/lib/bin.js';

// Store state in a file to track last run time (persistent across restarts)
const CACHE_DIR = path.join(__dirname, '.cache');
const STATE_FILE = path.join(CACHE_DIR, 'state.json');
const LOG_FILE = '/tmp/job-watcher-launchd.log';

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(LOG_FILE, `[${ts}] [daemon] ${msg}\n`);
}

function loadState() {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    log('State file missing. Starting fresh.');
    return { lastRun: 0 };
  }
}

function saveState(state) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { cwd: __dirname });
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.once('close', code => {
      if (code === 0) resolve(output);
      else reject(new Error(`Command failed with code ${code}: ${output}`));
    });
  });
}

async function isJobRadarRunning() {
  try {
    const response = await execAsync('curl -sf http://localhost:3001/api/health');
    return response.includes('ok');
  } catch {
    return false;
  }
}

async function runDshJob() {
  const prompt = `
Use web_search with 3-4 queries to find RECENTLY posted (within last 7 days) senior software engineer and backend engineer jobs in India and Japan.
CRITICAL RULES:
1. ONLY include jobs posted within the past 7 days. Reject anything older.
2. PREFER direct company career pages (google.com/careers, jobs.smartrecruiters.com, linkedin.com/jobs, companies' own career sites). AVOID aggregators like foundit.in, echojobs.io, fastapply.co, startup.jobs, scoutify.com, cutshort.io, naukri.com, nexisgrow.com, hiring.fm, mncjobsindia.com, ambitionbox.com, japan-dev.com, themuse.com.
3. Extract: title, company, url, location, country (IN/JP/DE/US), isRemote, salary if visible, tags for tech stack. Include postedAt date.
Use queries like:
- 'site:linkedin.com/jobs/view senior software engineer india posted past week'
- 'site:google.com/about/careers software engineer bengaluru OR hyderabad OR india'
- 'site:jobs.smartrecruiters.com linkedin senior software engineer bengaluru'
- "software engineer japan visa sponsorship hired lately"
POST each valid job to http://localhost:3001/api/ingest-web with source 'web-search'. Use unique externalId format: web-search-company-brief-title.
Report back total found, how many were recent, and which companies had openings.
`;

  const fullCmd = `node ${DSH_CLI} --profile headless "${prompt}" 2>&1`;
  log(`Running DSH job: ${fullCmd}`);
  try {
    const result = await execAsync(fullCmd);
    log(`DSH job completed:\n${result}`);
    return true;
  } catch (err) {
    log(`DSH job failed:\n${err.message}`);
    return false;
  }
}

async function main() {
  log('Daemon started. Running checks every 5 minutes.');
  let state = loadState();
  let lastCheck = Date.now();

  // Run once on startup
  await checkAndRun();
  lastCheck = Date.now();

  setInterval(async () => {
    await checkAndRun();
    lastCheck = Date.now();
  }, 5 * 60 * 1000); // Every 5 minutes
}

async function checkAndRun() {
  const now = Date.now();
  const state = loadState();
  const lastRun = state.lastRun || 0;
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;

  if ((now - lastRun) >= TWELVE_HOURS) {
    log(`12 hours passed since last run. Checking if Job Radar is up...`);
    const running = await isJobRadarRunning();
    if (running) {
      log('Job Radar is up. Running DSH job...');
      const success = await runDshJob();
      if (success) {
        state.lastRun = now;
        saveState(state);
        log('Job ran successfully. Next run in ~12 hours.');
      } else {
        log('Job failed. Will retry in 5 minutes.');
      }
    } else {
      log('Job Radar is not running. Will retry in 5 minutes.');
    }
  } else {
    // Check if we're due for a big delay
    if ((now - lastRun) >= 10 * 60 * 60 * 1000) {
      log('Long delay since last run. Checking if Mac was asleep...');
    }
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});