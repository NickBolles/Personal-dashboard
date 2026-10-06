@AGENTS.md

# Jarvis — notes for agents

- Spec: https://artifacts.ai.nickbolles.com/a/jarvis-dashboard-build-plan-20260929/ (summarised in docs/architecture.md).
- Run `npm run verify` before claiming done. E2E needs a build (`npm run build`) and uses mock upstreams on :4020 and the app on :3200.
- Upstream DTOs live only in `integrations/<source>/`; the UI consumes normalized types from `lib/contracts.ts` and `lib/hermes.ts`.
- Anything process-wide (token caches, locks, counters) must use `server/singleton.ts`: route handlers and the worker are separate bundles.
- Every mutation route goes through `api()` in `server/http/api.ts` (auth + CSRF + zod). Browser calls use `lib/client/api.ts`.
- Never cache `/api/*` in the service worker; never report upstream success without readback; never queue physical actions.
- Schema changes: edit `server/db/schema.ts`, then `npm run db:generate` (commit the migration).
- Android app lives in `android/` (Kotlin/Compose, no business logic: the server owns it). Kotlin models mirror `lib/contracts.ts`; when an API shape changes, update the models, then `UPDATE_API_FIXTURES=1 npx vitest run test/mobile.test.ts`. Android checks: `cd android && ./gradlew verifyRoborazziDebug` (record with `recordRoborazziDebug`), live: `scripts/android-live-check.sh`.
- Phone API calls authenticate with `Authorization: Bearer jdv_…` device tokens (server/devices.ts); `api()` skips CSRF for them and never falls back to cookies.
