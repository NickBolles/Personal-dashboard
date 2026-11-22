#!/usr/bin/env node
// Duration-balanced e2e shards (docs/ci.md, "Balanced shards").
//
//   node scripts/e2e-shards.mjs --shard 3/7 --out tests.txt [--grep <re>] [--timings e2e/timings.json] [--from-list list.json]
//   node scripts/e2e-shards.mjs --record results.json --out e2e/timings.json [--source "run 123"]
//
// Playwright's own `--shard` cuts the test list into equal COUNTS, so the slow tests (desktop a11y at 200% text
// zoom, 17-26 s each) land together and one shard runs a minute and a half longer than the rest. This plans the
// shards by recorded DURATION instead and writes the current shard's tests as a Playwright `--test-list` file.
//
// - The plan is a pure function of the test list, the timings file and the shard count, so every shard computes
//   the same plan on its own and each test lands in exactly one shard.
// - A spec file runs whole on one shard (per project), as Playwright groups it, except the files that opt into
//   `mode: "parallel"` (a11y, visual): those split test by test (a top-level describe stays together).
// - Tests the timings file does not know (new ones) count as the median of their file, else of the suite.
// - `*.setup.ts` tests are not listed: their project is every other project's dependency, so Playwright runs it
//   on every shard anyway.
// - A test the list format cannot name (a title with "›", a file that reads as file:line) makes the planner
//   exit 2: the workflow then falls back to `--shard` for the whole run, with a warning, and nothing is skipped.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEP = " › ";
const PARALLEL = /^test\.describe\.configure\(\{\s*mode:\s*["']parallel["']\s*\}\)/m;

/** @typedef {{ project: string, file: string, titles: string[], ms?: number }} Test */

/**
 * Every test in a Playwright JSON report (a `--list` or a finished run): project, file (relative to the test dir), title path, first-attempt time.
 * @returns {Test[]}
 */
export function testsOf(report) {
  const out = [];
  const walk = (suite, file, titles) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) out.push({ project: t.projectName, file, titles: [...titles, spec.title], ms: t.results?.[0]?.duration });
    for (const child of suite.suites ?? []) walk(child, file, [...titles, child.title]);
  };
  for (const fileSuite of report.suites ?? []) walk(fileSuite, fileSuite.file, []);
  return out.filter((t) => !/\.setup\.[cm]?[jt]s$/.test(t.file));
}

/** The `--test-list` line for a test. */
export const lineFor = (t) => [`[${t.project}]`, t.file, ...t.titles].join(SEP);

/**
 * Whether Playwright reads the line back as this same test (playwright/lib/runner/loadUtils.js loadTestList):
 * it splits on "›", trims each token, reads `[project]`, and parses the file token as file[:line[:col]].
 */
export function expressible(t) {
  const tokens = lineFor(t)
    .split("›")
    .map((x) => x.trim());
  return (
    tokens.length === t.titles.length + 2 &&
    tokens[0] === `[${t.project}]` &&
    !t.project.includes("]") &&
    tokens[1] === t.file &&
    !/:\d+$/.test(t.file) &&
    t.titles.every((x, i) => x !== "" && tokens[i + 2] === x)
  );
}

const timingKey = (t) => t.titles.join(SEP);
const median = (xs) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Split `tests` into `shards` lists by recorded time (longest group first, each to the least loaded shard).
 * `parallelFiles`: files whose tests may run on different shards. Returns the shards' tests and estimated ms.
 */
export function plan(tests, { shards, timings = {}, parallelFiles = new Set() }) {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`bad shard count: ${shards}`);
  const bad = tests.filter((t) => !expressible(t));
  if (bad.length) {
    const err = new Error(`cannot name ${bad.length} test(s) in a --test-list file, e.g. ${lineFor(bad[0])}`);
    err.code = "INEXPRESSIBLE";
    throw err;
  }
  const known = (t) => timings[t.project]?.[t.file]?.[timingKey(t)];
  const all = tests.map(known).filter((x) => typeof x === "number");
  const byFile = new Map();
  for (const t of tests) {
    const ms = known(t);
    if (typeof ms !== "number") continue;
    const k = `${t.project}|${t.file}`;
    byFile.set(k, [...(byFile.get(k) ?? []), ms]);
  }
  const fallback = median(all) ?? 1000;
  const cost = (t) => known(t) ?? median(byFile.get(`${t.project}|${t.file}`) ?? []) ?? fallback;

  // Playwright runs a file in order on one worker unless it opted into parallel mode.
  const groups = new Map();
  for (const t of tests) {
    const split = parallelFiles.has(t.file);
    const key = `${t.project}|${t.file}|${split ? (t.titles.length > 1 ? t.titles[0] : t.titles.join(SEP)) : ""}`;
    const g = groups.get(key) ?? { key, ms: 0, tests: [] };
    g.ms += cost(t);
    g.tests.push(t);
    groups.set(key, g);
  }
  const order = [...groups.values()].sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  /** @type {{ ms: number, tests: Test[] }[]} */
  const out = Array.from({ length: shards }, () => ({ ms: 0, tests: [] }));
  for (const g of order) {
    let best = 0;
    for (let i = 1; i < shards; i++) if (out[i].ms < out[best].ms) best = i;
    out[best].ms += g.ms;
    out[best].tests.push(...g.tests);
  }
  for (const s of out) s.tests.sort((a, b) => (lineFor(a) < lineFor(b) ? -1 : 1));
  return out;
}

/** Recorded first-attempt times, by project → file → title path, rounded to 0.1 s (fewer meaningless diffs). */
export function recordTimings(report) {
  const ms = {};
  for (const t of testsOf(report)) {
    if (typeof t.ms !== "number") continue;
    ((ms[t.project] ??= {})[t.file] ??= {})[timingKey(t)] = Math.round(t.ms / 100) * 100;
  }
  const sorted = (o) =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, typeof o[k] === "object" ? sorted(o[k]) : o[k]]),
    );
  return sorted(ms);
}

/** Spec files that opt into parallel mode at the top level (their tests may split across shards). */
export function parallelFilesIn(dir, files) {
  return new Set(
    [...new Set(files)].filter((f) => {
      try {
        return PARALLEL.test(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return false;
      }
    }),
  );
}

function listTests(grep) {
  const cli = createRequire(path.join(ROOT, "package.json")).resolve("@playwright/test/cli");
  const args = [cli, "test", "--list", "--reporter=json", ...(grep ? ["--grep", grep] : [])];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`playwright --list failed (${r.status}): ${(r.stderr || "").slice(-2000)}`);
  return JSON.parse(r.stdout);
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const out = arg(argv, "--out");
  const record = arg(argv, "--record");
  if (record) {
    const report = JSON.parse(fs.readFileSync(record, "utf8"));
    const ms = recordTimings(report);
    const count = Object.values(ms).reduce((n, files) => n + Object.values(files).reduce((m, f) => m + Object.keys(f).length, 0), 0);
    const body = {
      $comment:
        "First-attempt test times (ms) for duration-balanced e2e shards (scripts/e2e-shards.mjs, docs/ci.md). Refresh from a full CI run's e2e-timings artifact.",
      source: arg(argv, "--source") ?? path.basename(record),
      ms,
    };
    fs.writeFileSync(out ?? "e2e-timings.json", `${JSON.stringify(body, null, 2)}\n`);
    console.log(`recorded ${count} test times → ${out ?? "e2e-timings.json"}`);
    return 0;
  }

  const m = /^(\d+)\/(\d+)$/.exec(arg(argv, "--shard") ?? "");
  if (!m || !out) {
    console.error("usage: e2e-shards.mjs --shard i/N --out tests.txt [--grep re] [--timings file] [--from-list list.json]");
    return 1;
  }
  const [current, total] = [Number(m[1]), Number(m[2])];
  if (current < 1 || current > total) {
    console.error(`shard ${current} is not in 1..${total}`);
    return 1;
  }
  const timingsFile = arg(argv, "--timings") ?? path.join(ROOT, "e2e/timings.json");
  let timings = {};
  try {
    timings = JSON.parse(fs.readFileSync(timingsFile, "utf8")).ms ?? {};
  } catch {
    console.warn(`[e2e-shards] no timings at ${timingsFile}: every test counts the same`);
  }
  const fromList = arg(argv, "--from-list");
  const report = fromList ? JSON.parse(fs.readFileSync(fromList, "utf8")) : listTests(arg(argv, "--grep"));
  const tests = testsOf(report);
  const rootDir = report.config?.rootDir ?? path.join(ROOT, "e2e");
  let shards;
  try {
    shards = plan(tests, {
      shards: total,
      timings,
      parallelFiles: parallelFilesIn(
        rootDir,
        tests.map((t) => t.file),
      ),
    });
  } catch (e) {
    console.error(`[e2e-shards] ${e.message}`);
    return e.code === "INEXPRESSIBLE" ? 2 : 1;
  }
  const listed = shards.reduce((n, s) => n + s.tests.length, 0);
  if (listed !== tests.length) {
    console.error(`[e2e-shards] planned ${listed} of ${tests.length} tests`);
    return 1;
  }
  const mine = shards[current - 1];
  fs.writeFileSync(out, mine.tests.map(lineFor).join("\n") + "\n");
  const min = (ms) => `${(ms / 60000).toFixed(1)} min`;
  console.log(`[e2e-shards] ${tests.length} tests on ${total} shards by recorded time (sum per shard, before ÷ workers):`);
  shards.forEach((s, i) => console.log(`  ${i + 1 === current ? "→" : " "} ${i + 1}/${total}: ${s.tests.length} tests, ${min(s.ms)}`));
  console.log(`[e2e-shards] wrote ${mine.tests.length} tests to ${out}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
