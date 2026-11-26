#!/usr/bin/env bash
# Isolated production-build browser evidence runner. Requires shepherd's immutable marker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="/opt/data/worktrees/jarvis-in-this-chat-SOURCE-READY"
LOCK="/opt/data/worktrees/.jarvis-heavy-lock"
OUT="${BOARD_DIR:-$ROOT/test-results/in-this-chat-evidence}"
if [[ ! -f "$MARKER" ]]; then
  echo "SOURCE_READY marker is required before build: $MARKER" >&2
  exit 3
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "heavy build lock already held: $LOCK" >&2
  exit 4
fi
cleanup() { rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
printf 'pid=%s\nstarted=%s\nmarker=%s\n' "$$" "$(date -Is)" "$(cat "$MARKER")" > "$LOCK/owner"
mkdir -p "$OUT"
BROWSER="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
if [[ -z "$BROWSER" ]]; then
  echo "system Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH to an installed Chromium" >&2
  exit 5
fi
export GOMAXPROCS=2 CIRCLE_NODE_TOTAL=2 TOKIO_WORKER_THREADS=2 RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2
export E2E_WORKERS=1 E2E_PORT=3276 E2E_MOCK_PORT=4076 PLAYWRIGHT_CHROMIUM_PATH="$BROWSER" BOARD_DIR="$OUT"
unset GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET HA_BASE_URL HA_TOKEN HERMES_API_KEY HERMES_BASE_URL HERMES_DASHBOARD_URL MONARCH_API_URL MONARCH_TOKEN PAPERCLIP_API_KEY PAPERCLIP_BASE_URL PAPERCLIP_API_URL SKYLIGHT_REFRESH_TOKEN GH_TOKEN
unset JARVIS_MOCK_UPSTREAM_URL JARVIS_ANTHROPIC_BASE_URL JARVIS_GITHUB_API_URL JARVIS_ENABLE_DRIVE_EXPORT JARVIS_DRIVE_CLIENT_SECRET JARVIS_HERMES_KEY_MOMENTUMCHIEF
cd "$ROOT"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  nice -n 19 npm run build
else
  echo "SKIP_BUILD=1: using the just-completed source-ready production build"
fi
nice -n 19 npx playwright test e2e/in-this-chat.spec.ts --workers=1
printf 'board_dir=%s\nsource_ready=%s\n' "$OUT" "$(cat "$MARKER")"
