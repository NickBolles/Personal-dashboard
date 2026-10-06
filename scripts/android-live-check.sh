#!/usr/bin/env bash
# Runs the Android client (LiveServerTest) against a real Jarvis server + mock upstreams.
# Needs a production build (npm run build) and the Android SDK (ANDROID_HOME).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-3300}; MOCK_PORT=${MOCK_PORT:-4030}
BASE="http://127.0.0.1:$PORT"; MOCK="http://127.0.0.1:$MOCK_PORT"
MOCK_PORT=$MOCK_PORT MOCK_SPEED=40 node mock-upstreams/server.mjs > /tmp/jarvis-live-mock.log 2>&1 & MOCK_PID=$!
PORT=$PORT JARVIS_MOCK_UPSTREAM_URL=$MOCK JARVIS_SETUP_CODE=LIVE-CHECK JARVIS_WORKER_INTERVAL_MS=3600000 JARVIS_SECURE_COOKIES=false TZ=America/Chicago \
  node scripts/e2e-server.mjs > /tmp/jarvis-live-server.log 2>&1 & SERVER_PID=$!
trap 'kill $SERVER_PID $MOCK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "$BASE/api/health" > /dev/null && break; sleep 1; done

JAR=$(mktemp)
H=(-H "content-type: application/json" -H "x-jarvis-csrf: 1" -H "origin: $BASE")
curl -sf -c "$JAR" "${H[@]}" -X POST "$BASE/api/auth/setup" -d '{"setupCode":"LIVE-CHECK","name":"Nick","passcode":"live-check-pass","timezone":"America/Chicago"}' > /dev/null
# Connect every integration to the mock upstreams, like onboarding's "Use demo values".
node -e '
const [base, jar] = process.argv.slice(1);
const cookie = require("fs").readFileSync(jar, "utf8").split("\n").find((l) => l.includes("jarvis_session")).split("\t").pop();
const h = { "content-type": "application/json", "x-jarvis-csrf": "1", origin: base, cookie: `jarvis_session=${cookie}` };
(async () => {
  const { presets } = await (await fetch(`${base}/api/integrations/demo`, { headers: h })).json();
  for (const [kind, p] of Object.entries(presets)) {
    const r = await fetch(`${base}/api/integrations/${kind}`, { method: "PUT", headers: h, body: JSON.stringify({ enabled: true, ...p }) });
    if (!r.ok) throw new Error(`${kind}: ${r.status} ${await r.text()}`);
  }
})();' "$BASE" "$JAR"
CODE=$(curl -sf -b "$JAR" "${H[@]}" -X POST "$BASE/api/devices/pairing" | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')
echo "[live] pairing code $CODE"
cd android && JARVIS_LIVE_URL=$BASE JARVIS_LIVE_CODE=$CODE ./gradlew --no-daemon testDebugUnitTest --tests '*LiveServerTest' --rerun
