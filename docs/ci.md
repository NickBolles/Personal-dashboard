# CI

`.github/workflows/ci.yml` runs on **pull requests** (`pull_request`), on **push to main**, **nightly** (09:17 UTC) and on
manual dispatch. Branch pushes without a PR don't run CI; a newer push to the same PR cancels the older run.

```
verify ─────────────── typecheck · lint · prettier · unit (coverage) · audit · compose config ──► docker (image + smoke)
build ──┐              next build once · bundle secret scan · standalone server packed as an artifact
select ─┴─► e2e shard 1..N (Playwright container, E2E_WORKERS isolated stacks each) ──► Playwright report
```

| Job               | What it does                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| verify            | `npm ci`, audit, typecheck, lint, format check, vitest with coverage, docker compose config                                   |
| build             | the only `next build`; runs `secrets:scan` on the bundles, packs `.next/standalone` (assets copied in) as `next-build`        |
| select            | decides what the e2e shards run (see _Smart selection_)                                                                       |
| e2e (matrix)      | `npx playwright test --shard i/N --workers $E2E_WORKERS [--grep <selection>]` in `mcr.microsoft.com/playwright:v1.56.1-noble` |
| Playwright report | merges the shards' blob reports into one HTML report + JSON, writes the job summary and a sticky PR comment, gates the run    |
| docker            | demo image build, health/readiness, persistence + backup drill                                                                |

The shard count (`E2E_SHARDS`, 5) and workers per runner (`E2E_WORKERS`, 3) are the `env` at the top of `ci.yml`; a manual
dispatch can override both (`gh workflow run ci.yml --ref <branch> -f e2e_shards=4 -f e2e_workers=3`).

### Timings (full suite, PR #279, Nov 2026)

| Layout                   | Workflow wall | Slowest shard (job / tests) | Billable min                              | Notes                                                          |
| ------------------------ | ------------- | --------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| before: 1 job, 1 worker  | 47m09s        | 46m50s / 44m15s             | ~57 (×2 per PR push: push + pull_request) | main run 43260901319                                           |
| 4 shards × 3 workers     | 10m07–10m36s  | 7m46–8m02s / 6m19–6m34s     | 36–42                                     | 3 runs green                                                   |
| 3 shards × 4 workers     | 12m09s        | 9m12s / 7m48s               | ~40                                       | slower per test (CPU bound), 1 order-dependent failure (fixed) |
| **5 shards × 3 workers** | 8m47s         | 6m44s / 5m16s               | ~41                                       | default                                                        |

Per shard ~1.5 min is fixed cost (container 25 s, `npm ci` 48 s, artifact, 3 servers + onboarding ~10 s). Shards are split by
test count (Playwright `--shard`), so the desktop-heavy shard runs longest.

## Isolated workers (one app + mock per Playwright worker)

`playwright.config.ts` starts **one app server + one mock upstream per worker** (`e2e/servers.ts`). Worker _i_
(`TEST_PARALLEL_INDEX`) talks to app `E2E_PORT + i` (default 3200) and mock `E2E_MOCK_PORT + i` (default 4020), each with a
fresh data dir, its own Hermes usage file and its own signed-in state `e2e/.auth/state-<i>.json` (the setup project
onboards every server, side by side). Playwright loads the config again inside each worker with `TEST_PARALLEL_INDEX`
set, so `baseURL`, `storageState`, `MOCK_URL` (helpers) and `BASE_URL`/`MOCK_URL` (config exports) all point at that
worker's own stack. Nothing is shared between workers.

- Spec files keep running whole and in order on one worker (`fullyParallel: false`); `a11y.spec.ts` and `visual.spec.ts`
  are `mode: "parallel"` (their tests stub or seed what they check), so their tests spread across workers and shards.
- A spec file only sees server state left by the files that ran before it **on the same worker**. A new spec must not
  rely on another file's data — seed it in the test or stub it with `page.route`.
- Skylight writes are rate limited (12/min per user, per server). The write specs start with
  `freshSkylightBudget(request)` (e2e/helpers.ts): it waits until 61 s after this server's last Skylight write, i.e. only
  when another write spec just ran on the same worker, instead of a fixed minute.
- Serial-only specs (`test.describe.configure({ mode: "serial" })`): `ai-actions`, `ai-meter`, `capture` (unchanged).

Run locally (one heavy job at a time; `npm run build` first):

```sh
npm run e2e -- --workers 3                      # 3 isolated stacks
npm run e2e -- e2e/home.spec.ts --workers 2     # any filter works
E2E_PORT=3290 E2E_MOCK_PORT=4090 npm run e2e    # other ports (worker i uses base + i)
```

`--workers` must be a number (each worker needs its server). `E2E_WORKERS=N` does the same as `--workers N`.

## Smart selection (pull requests)

`scripts/e2e-select.mjs` maps the PR's changed files (`gh pr diff --name-only`) to Playwright tests and prints its reasons in
the **E2E selection** job summary. Try it locally: `npm run e2e:select` (diffs against the merge-base with `origin/main`) or
`node scripts/e2e-select.mjs --files components/finance/FinanceNav.tsx --json`.

1. **Full suite** on push to main, the nightly run and manual dispatches; on PRs with the **`full-e2e` label** (adding it
   dispatches a full CI run on the PR branch right away, `full-e2e-label.yml`; later pushes keep running everything); when a
   shared file changes (`fullSuite` in `e2e/selection-map.json`: package files, Playwright/Next config, root and shell
   layouts, `globals.css`, `components/ui/**`, `lib/ui*`, `public/sw.js`, migrations and `server/db/**`, mock upstreams, the
   e2e harness and fixtures, the CI workflows); when one changed file is reached by more than `maxFraction` (60%) of the
   tests; when the selection would exceed 60% of the suite; or when the changed files can't be listed.
2. **Changed spec files** run whole; changed baselines run their spec.
3. Every other file goes through a **static graph**: imports (relative and `@/`), client `"/api/..."` literals → the API
   route handler, app routes (the page plus its non-shell layouts) → the specs whose `goto`/request URLs reach that route
   (a visited page also covers the pages under it). `a11y.spec.ts` and `visual.spec.ts` are split per test, so only their
   tests that visit an affected URL run.
4. **App-shell chrome** (code only `app/layout.tsx` / `app/(shell)/layout.tsx` reach: sidebar, palette, Chief of staff
   tray …) shows on every page: it runs the specs of a matching rule, otherwise the full suite.
5. **Rules** in `selection-map.json` add specs the graph can't see (e.g. Skylight chores on Today). A rule with
   `"replaceGraph": true` replaces the graph's answer for its files (used for chrome). `titles` picks a11y/visual tests by
   title regex.
6. The **smoke set** always runs: onboarding (setup project), sending a chat, the global coordinator sheet, the phone
   width guard and one shot of each main page.

Docs, unit tests (`test/**`, `*.test.ts(x)`), Android, Hermes skills and scripts are ignored (`ignore`). Small selections
run on fewer shards (≤20% → 1, ≤40% → 2). Misses are caught by the next main/nightly full run.

### Adding a map entry

```json
{
  "why": "Finance pages share the money formatter",
  "files": ["components/finance/money.tsx"],
  "specs": ["finance.spec.ts"],
  "titles": { "visual.spec.ts": "finance", "a11y.spec.ts": "finance" }
}
```

Globs: `**` any depth, `*` within a segment. Add `"replaceGraph": true` only for code that renders on every page. Run
`npx vitest run test/e2e-select.test.ts` after changing the selector.

## Report

Each shard uploads a blob report; **Playwright report** merges them (`playwright merge-reports --reporter html,json`), uploads
the HTML report as the `playwright-report` artifact (14 days; unzip and `npx playwright show-report <dir>`; failing tests
carry their trace, screenshots and diffs) and posts the same summary to the job summary and one sticky PR comment
(`<!-- jarvis-e2e-report -->`): passed/failed/flaky/skipped, Playwright wall time, per-shard job and test-step times,
the 10 slowest tests, failing (functional vs snapshot) and flaky tests. It fails if a shard failed or any test failed.

This follows momentumbets/mb-stack (blob per shard → merge → sticky comment + summary). mb-stack also publishes the
HTML report and traces to a public Cloudflare R2 bucket (`pr-reports/<pr>/<run>/`); Jarvis has no such bucket, so the
report is an artifact. Reports only contain mock data (no real credentials or personal data).

## Visual baselines

`visual-baselines.yml` (manual; `update: changed` by default re-records only shots that differ beyond the tolerance and
new ones, `all` re-records everything) builds once, records on 3 shards × `E2E_WORKERS`, and commits only the PNGs the
shards changed or added in one commit. Snapshot paths are unchanged (`e2e/__screenshots__/ci/<project>/<spec>/<name>.png`).
