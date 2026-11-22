# CI

`.github/workflows/ci.yml` runs on **pull requests** (`pull_request`), on **push to main**, **nightly** (09:17 UTC) and on
manual dispatch. Branch pushes without a PR don't run CI; a newer push to the same PR cancels the older run.

```
verify ─────────────── typecheck · lint · prettier · audit · compose config
unit ───────────────── vitest with coverage
docker ─────────────── demo image build · health/readiness · persistence + backup drill
build ──┐              next build once (warm from main's cache) · bundle secret scan · standalone server packed as an artifact
select ─┴─► e2e shard 1..N (Playwright container, E2E_WORKERS isolated stacks each) ──► Playwright report
```

Nothing waits on anything except the e2e shards (on `build` and `select`) and the report (on the shards), so the run is as
long as its longest path: build, then the slowest shard, then the report.

| Job               | What it does                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| verify            | `npm ci`, audit, typecheck, lint, format check, docker compose config                                                                                                        |
| unit              | `npm ci`, vitest with coverage                                                                                                                                               |
| build             | the only `next build`; runs `secrets:scan` on the bundles, packs `.next/standalone` (assets copied in) as `next-build`                                                       |
| select            | decides what the e2e shards run (see _Smart selection_)                                                                                                                      |
| e2e (matrix)      | plans its shard by recorded time, then `npx playwright test --test-list <shard> --workers $E2E_WORKERS [--grep <selection>]` in `mcr.microsoft.com/playwright:v1.56.1-noble` |
| Playwright report | merges the shards' blob reports into one HTML report + JSON, writes the job summary and a sticky PR comment, gates the run                                                   |
| docker            | demo image build, health/readiness, persistence + backup drill (alongside the checks, not after them)                                                                        |

The shard count (`E2E_SHARDS`, 7) and workers per runner (`E2E_WORKERS`, 3) are the `env` at the top of `ci.yml`; a manual
dispatch can override both (`gh workflow run ci.yml --ref <branch> -f e2e_shards=4 -f e2e_workers=3`).

**Build cache.** Turbopack keeps its build cache in `.next/cache` (on by default since Next 16.3). The build job restores
the newest cache main saved this week for the current lockfile, so a pull request builds warm (30 s against 94 s cold on a
laptop). Only runs on main save one (keyed by commit, at the end of the job): the shards wait for the build job, so a pull
request never spends time saving. The cache grows with every build it is carried through, so the ISO week is part of the
key: the first main build of a week, and the first after a lockfile change, starts cold. The cache is not part of the
packed artifact.

### Timings (full suite, PR #279, Nov 2026)

| Layout                   | Workflow wall | Slowest shard (job / tests) | Billable min                              | Notes                                                            |
| ------------------------ | ------------- | --------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| before: 1 job, 1 worker  | 47m09s        | 46m50s / 44m15s             | ~57 (×2 per PR push: push + pull_request) | main run 43260901319                                             |
| 4 shards × 3 workers     | 10m07–10m36s  | 7m46–8m02s / 6m19–6m34s     | 36–42                                     | 3 runs green                                                     |
| 3 shards × 4 workers     | 12m09s        | 9m12s / 7m48s               | ~40                                       | slower per test (CPU bound), 1 order-dependent failure (fixed)   |
| 5 shards × 3 workers     | 8m47s         | 6m44s / 5m16s               | ~41                                       | default until Nov 2026                                           |
| **7 shards × 3 workers** | 7m56s         | 5m42s / 4m48s               | ~46                                       | run 45040797431, build cold; checks, unit and docker in parallel |

Per shard ~1 min is fixed cost (container 27 s, `npm ci` 9–18 s, artifact, listing the tests to plan the shard, 3 servers +
onboarding ~10 s). Shards are split by recorded time (see _Balanced shards_).

### Where the time went (5 shards, run 45035831824, Nov 2026)

| Path                           | Time                                                       |
| ------------------------------ | ---------------------------------------------------------- |
| build → slowest shard → report | 1m36s + (57 s setup + 3m12s–4m42s tests, green) + 20 s     |
| verify (all checks in one job) | 4m55s (typecheck 34 s, lint 52 s, format 22 s, unit 158 s) |
| verify → docker                | 4m55s + 2m12s = 7m07s                                      |

The e2e path and the docker path were about as long as each other, so shortening one alone would not have shortened the
run. Since then: the unit tests are their own job, docker no longer waits for the checks, the build starts warm, and the
default is **7 shards × 3 workers**. Measure a full run after a change here and add it to the table.

### After (7 shards, run 45040797431)

| Path                           | Time                                          |
| ------------------------------ | --------------------------------------------- |
| build → slowest shard → report | 1m47s (cold) + 5m42s + 18 s = the run's 7m56s |
| verify                         | 2m20s                                         |
| unit                           | 2m42s                                         |
| docker                         | 2m14s                                         |

The run is now the e2e path alone. It cost about five more billable minutes (two more runners, one more job) for 51 s less
wall time; a warm build should take another half minute off, and that first shows on the pull request after this one
merges.

The shards were uneven: their Playwright steps took 4m11s, 2m31s, 2m57s, 3m23s, 2m46s, 4m48s and 2m29s (3m18s on average).
Playwright's `--shard` splits by test count, and the slow tests (desktop a11y at 200% text zoom, 17–26 s each) sat together.
That is what _Balanced shards_ fixes. Estimated from that run's times (3 workers per shard), the slowest shard's tests go
from about 4.4 minutes to about 3.3.

## Balanced shards

`scripts/e2e-shards.mjs` plans the shards by recorded test time instead of count. Each shard lists the tests
(`playwright test --list`, with the PR's `--grep` if any), computes the same plan from `e2e/timings.json`, and runs its part
with `--test-list`.

- Longest group first, each to the shard with the least recorded time so far. A spec file runs whole on one shard (per
  project), as Playwright runs it; files that opt into `mode: "parallel"` (a11y, visual) split test by test, a top-level
  describe staying together.
- A test the timings do not know (a new one) counts as the median of its file, else of the suite, so a stale file only makes
  the balance a little worse.
- `*.setup.ts` tests are not listed: the setup project is every project's dependency, so it runs on every shard anyway.
- A test the `--test-list` format cannot name (a title with `›`, or leading/trailing spaces) stops the planner, and the
  workflow falls back to `--shard` for that run with a warning: nothing is skipped. Keep `›` out of test titles.

**Refreshing the times.** Every full run (main, nightly, `full-e2e`) uploads an `e2e-timings` artifact. When the shards drift
apart (the report's per-shard table), download it over `e2e/timings.json` and commit:

```sh
gh run download <run id> -n e2e-timings && mv e2e-timings.json e2e/timings.json
```

Try a plan locally: `npx playwright test --list --reporter=json > list.json`, then
`node scripts/e2e-shards.mjs --shard 1/7 --out shard.txt --from-list list.json` (it prints every shard's estimate).
`npx vitest run test/e2e-shards.test.ts` after changing the planner.

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
