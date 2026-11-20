# Job Radar Extension

Manifest V3 Chrome extension with two parts:

1. **Apply to this page**: sends the job page you are on to Job Radar's apply runner
2. **LinkedIn match scanner** (default **off**, viewport-only, no LinkedIn network calls)

## Setup

1. Start Job Radar locally (`npm run dev` at repo root).
2. Fill your profile at Settings and upload a resume PDF.
3. Chrome → **Extensions** → **Manage extensions** → enable **Developer mode**.
4. **Load unpacked** → select this `extension/` folder.
5. Click the extension icon → **Sync from Job Radar** (the LinkedIn scanner uses your rules and resume skills).

If you loaded an older unpacked copy, click **Reload** on the extension card after pulling these files.

## Apply to this page

On any job posting or application form (Greenhouse, Lever, Ashby, Workable, Workday, Naukri, Pinpoint, or a plain career-site form):

- Press **Ctrl+Shift+J** (change it at `chrome://extensions/shortcuts`), or
- Click the extension icon → **Apply to this page**.

The tab's URL goes to `POST /api/apply/from-url`. Job Radar opens the job in its own Chrome and applies with the same runner as **Apply now** on the feed: facts, audits, captcha wait, confirmation check. Nothing is typed into the tab you are on. A link not in Job Radar is added as a job first.

### Fill without submitting

- Press **Ctrl+Shift+K**, or
- Click the extension icon → **Fill this page (no submit)**.

Sends the URL with `fill: true`. Job Radar fills the form in its own Chrome, steps through Next, stops before Submit and leaves the tab open. You check it and send it yourself, then press **I applied** in the feed. Nothing counts against the daily cap. While another run is going the fill is refused, never queued, because a queued job would be submitted.

The toolbar badge shows the result for a few seconds; hover it for the reason:

- `GO` — run started
- `Q` — another run is going; the job is queued for the next run
- `!` — not started (already applied, LinkedIn, cap reached, or Job Radar not running)

LinkedIn pages are always refused.

Both work without the extension: paste the link into the field in the feed's Auto-apply panel and press **Apply** or **Fill**.

## LinkedIn scanner (opt-in)

It does **not** `fetch` LinkedIn APIs or click Apply / list cards. After you open a job, it waits ~1s then clicks the visible **… more** on that description so salary/YoE/stack can be scored from the full text.

1. Open the popup and enable **Scan LinkedIn jobs**.
2. Open [linkedin.com/jobs](https://www.linkedin.com/jobs/) (search, search-results, or a single job).
3. Cards in the **viewport** get a high-contrast badge (works on light theme), paced at **~1.2s per card**, **max 5 queued**.
4. Click a card: after a short pause the extension expands **… more** on the open job, then re-scores.

### Safety rules

- No `fetch` to linkedin.com, no auto-scroll, no clicking Apply or other cards
- One delayed **… more** click on the job you already opened
- Scan does nothing until the popup toggle is on
- IntersectionObserver + 1.0–1.6s delay + 5s backoff on errors
- Prefs live in `chrome.storage.local` (synced from your local Job Radar)

### Badge

- Green `82% · 4/4` — YoE, stack, location, title look good
- Yellow `58% · 2/4` — partial / missing salary
- Red `Excluded` — `staff` in title or exclusive avoided stack (default Java-only)
- Chips: `YOE` · `Stack` · `Loc` · `Salary ?` — `?` means the card didn’t say
- Selected job also gets a match banner under the title (full description after … more)

## Runner scripts kept here

`fill.js` and `extractors/` are no longer loaded by the extension. The apply runner (`src/lib/apply/browser-fill.ts`) injects them into the form as its first fill pass, so keep them.

## Configuration

Default API URL: `http://localhost:3001`. The popup auto-detects 3000/3001/3002.
