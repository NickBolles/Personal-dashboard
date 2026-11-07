# Scheduled jobs: worker S verification

Worktree: `/opt/data/worktrees/jarvis-p4-wS`, branch `wip/p4-away-srv`, base `9f53585`.

No builds, dev servers, Playwright, installs, pushes, deployments, live Hermes calls or live upstream writes were run. Test Hermes calls use injected functions or the in-process mock handler (no sockets). All shared `lib/away.ts` exports and shapes remain unchanged. The existing strict MCP update schema already rejects all area settings; the new test verifies this with an actual synthetic agent-token MCP request.

## Targeted scheduler and route tests

Exact command:

```sh
env -u HA_BASE_URL -u HA_TOKEN -u HERMES_API_KEY -u HERMES_BASE_URL -u HERMES_DASHBOARD_URL -u PAPERCLIP_API_KEY -u PAPERCLIP_API_URL -u PAPERCLIP_BASE_URL -u SKYLIGHT_REFRESH_TOKEN -u GH_TOKEN -u GITHUB_TOKEN -u MONARCH_TOKEN -u MONARCH_API_URL -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET npx vitest run --maxWorkers=1 --no-isolate test/away-scheduler.test.ts test/away-routes.test.ts
```

Result: 2 files passed, 50 tests passed. Cold wall time 10.69 seconds. This narrowly misses the requested <10-second wall-time target on this host; Vitest reports 48% transform and 26% import overhead. Tests use one migrated in-memory DB per file with rollback savepoints and mock the assistant facade to avoid loading provider SDKs.

## Contract and mock compatibility

Exact command:

```sh
env -u HA_BASE_URL -u HA_TOKEN -u HERMES_API_KEY -u HERMES_BASE_URL -u HERMES_DASHBOARD_URL -u PAPERCLIP_API_KEY -u PAPERCLIP_API_URL -u PAPERCLIP_BASE_URL -u SKYLIGHT_REFRESH_TOKEN -u GH_TOKEN -u GITHUB_TOKEN -u MONARCH_TOKEN -u MONARCH_API_URL -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET npx vitest run --maxWorkers=1 --no-isolate test/away-contract.test.ts test/away-scheduler.test.ts test/away-routes.test.ts test/away-mock.test.ts
```

Result: 4 files passed, 64 tests passed, 11.28 seconds. The mock tests submit a run to the mock's handler and read its terminal status back, verifying the exact requested proposal output and `NOTHING_NEW` without opening a server.

## Affected existing suites and regressions

Exact command:

```sh
env -u HA_BASE_URL -u HA_TOKEN -u HERMES_API_KEY -u HERMES_BASE_URL -u HERMES_DASHBOARD_URL -u PAPERCLIP_API_KEY -u PAPERCLIP_API_URL -u PAPERCLIP_BASE_URL -u SKYLIGHT_REFRESH_TOKEN -u GH_TOKEN -u GITHUB_TOKEN -u MONARCH_TOKEN -u MONARCH_API_URL -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET npx vitest run --maxWorkers=2 test/away-contract.test.ts test/away-scheduler.test.ts test/away-routes.test.ts test/away-mock.test.ts test/agent-access.test.ts test/agent-runs.test.ts test/work.test.ts test/work-hub-2.test.ts test/work-hub-3.test.ts test/work-from-jarvis.test.ts test/areas.test.ts test/areas-structure.test.ts test/areas-digest.test.ts test/activity.test.ts test/capture.test.ts test/people.test.ts test/security.test.ts test/mock-dates.test.ts test/quick-actions.test.ts test/ai-runner.test.ts test/push-fallback.test.ts test/coordinator-chat.test.ts test/global-coordinator.test.ts
```

Result: 23 files passed, 361 tests passed, 87.81 seconds.

## Static checks

- `nice -n 19 npx tsc --noEmit -p .`: passed.
- `npx eslint` on every changed TypeScript/MJS file: passed.
- `node node_modules/prettier/bin/prettier.cjs --write` on changed TypeScript/MJS/Markdown/JSON files: passed (Drizzle metadata follows the repository's ignore rules).
- `git diff --check`: passed.

## Integrator handoff

Apply additive migration `drizzle/0039_scheduled_jobs.sql` (plus its generated snapshot and journal entry). Schedules ship disabled. The integrator owns UI integration, build, CI, Playwright and any deployment. One functional safeguard beyond the API minimum: changing a running job's area or deleting it returns 409 until it finishes, preventing reconciliation from applying old output in a newly selected area.
