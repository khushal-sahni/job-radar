#!/usr/bin/env bash
# Install (or reinstall) the Job Radar daily LaunchAgent.
# Fires at 08:00 local time and then hourly; each wake only runs the steps that are due
# (not done in 20h, or a failed step whose retry backoff has passed). Fires on wake if asleep.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.jobradar.ingest"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
OLD_LABEL="com.jobradar.watcher"
OLD_PLIST="$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
LOG_PATH="$HOME/Library/Logs/job-radar-ingest.log"

NODE_BIN="$(command -v node)"
NPX_BIN="$(command -v npx)"

if [[ -z "$NODE_BIN" || -z "$NPX_BIN" ]]; then
  echo "node/npx not found on PATH. Install Node or open a shell where they are available."
  exit 1
fi

# Unload legacy DSH watcher if present
if [[ -f "$OLD_PLIST" ]]; then
  launchctl bootout "gui/$(id -u)/${OLD_LABEL}" 2>/dev/null || true
  launchctl unload "$OLD_PLIST" 2>/dev/null || true
  rm -f "$OLD_PLIST"
  echo "Removed legacy ${OLD_LABEL}"
fi

# Unload existing agent before rewriting
if [[ -f "$PLIST_PATH" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

mkdir -p "$(dirname "$PLIST_PATH")"
mkdir -p "$(dirname "$LOG_PATH")"
touch "$LOG_PATH"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NPX_BIN}</string>
        <string>tsx</string>
        <string>${PROJECT_ROOT}/scripts/daily-ingest.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
EOF

if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  echo "Loaded ${LABEL} via launchctl bootstrap"
elif launchctl load -w "$PLIST_PATH" 2>/dev/null; then
  echo "Loaded ${LABEL} via launchctl load"
else
  echo "Wrote ${PLIST_PATH} but could not load it automatically."
  echo "Run: launchctl bootstrap gui/\$(id -u) ${PLIST_PATH}"
  exit 1
fi

echo ""
echo "Installed daily ingest:"
echo "  Plist:  ${PLIST_PATH}"
echo "  Log:    ${LOG_PATH}"
echo "  Schedule: 08:00 local, then hourly for due steps and retries (fires on wake if Mac was asleep)"
echo "  Manual:   npm run ingest:daily"
echo "  Force:    npm run ingest:daily -- --force"
echo ""
echo "To uninstall:"
echo "  launchctl bootout gui/\$(id -u)/${LABEL}"
echo "  rm ${PLIST_PATH}"
