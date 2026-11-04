#!/usr/bin/env bash
# Doctine · install dev tools exactly as locked. There is no fallback to `npm install`: a missing or out-of-date
# lockfile fails here with a clear message instead of silently installing different versions.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f package-lock.json ]; then
  echo "::error::package-lock.json is missing. Run 'npm install' locally (Node 20), commit package-lock.json, and push again." >&2
  exit 1
fi
npm ci --no-audit --no-fund
