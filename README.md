# Job Radar

A local job-matching app for one person. Upload a resume, set salary and location rules, get matching backend and full-stack roles, and optionally auto-apply — never on LinkedIn.

## What you need

1. **Node.js** (LTS) from [nodejs.org](https://nodejs.org/)
2. **Google Chrome** (for auto-apply)
3. An **[OpenRouter](https://openrouter.ai/keys)** API key

You do not need Docker, Postgres, or a terminal for the normal path.

## Start

| System | Open this |
|---|---|
| Mac | `Start Job Radar.command` (double-click) |
| Windows | `Start Job Radar.bat` |
| Linux | `start-job-radar.sh` |

The starter installs dependencies if needed, starts the app, and opens your browser. A setup dialog:

1. Creates a local database on this computer
2. Checks for Google Chrome
3. Asks for your OpenRouter key
4. Collects your profile and resume
5. Lets you set job preferences
6. Asks whether to look for jobs daily, and whether to also auto-apply

Leave the starter window open while you use Job Radar. The daily schedule only runs while the app is open.

## Preferences

Open **Settings** anytime to change:

- Profile and resume
- OpenRouter key (and optional Gmail for emailed security codes)
- Years of experience and words to skip
- Job branches (Remote India, India onsite, Germany, Japan)
- Daily find schedule, auto-apply checkbox, daily cap, Naukri (optional)

Auto-apply is off until you turn it on. It submits real applications to career sites you already match; it never uses LinkedIn.

## Optional power-user notes

- Set `DATABASE_URL` in `.env` to use your own Postgres instead of the embedded database (see `.env.example`).
- `npm run ingest:daily -- --force` runs a find/apply cycle from the terminal.
- Naukri needs a one-time login from the feed panel.

## License

MIT — see [LICENSE](LICENSE).

## Privacy

Personal runtime data stays on your machine: `data/applicant.json`, `.env`, and `journal/` are gitignored. Only `data/applicant.example.json` is committed.
