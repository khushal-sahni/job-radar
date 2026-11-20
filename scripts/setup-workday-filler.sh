#!/usr/bin/env bash
# Installs the Workday filler Job Radar drives for myworkdayjobs.com applications.
# The upstream repo has no license, so it is cloned locally and never committed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/vendor/workday-copilot"
REPO="https://github.com/rifattahmid/workday-job-application-copilot.git"
COMMIT="83e9103a3a548ec8890d2610f810c52818e07862"

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
git -C "$DIR" fetch --quiet origin
git -C "$DIR" checkout --quiet "$COMMIT"

if [ ! -x "$DIR/.venv/bin/python" ]; then
  python3 -m venv "$DIR/.venv"
fi
"$DIR/.venv/bin/pip" install --quiet playwright
echo "Workday filler ready at $DIR"
