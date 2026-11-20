#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed."
  echo "Opening https://nodejs.org/ — install the LTS version, then run this again."
  echo ""
  open "https://nodejs.org/"
  read -r -p "Press Enter to close…"
  exit 1
fi
npx tsx scripts/start.ts
read -r -p "Press Enter to close…"
