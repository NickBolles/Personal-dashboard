#!/usr/bin/env node
// Markdown summary of a merged Playwright run (docs/ci.md): pass/fail/flaky/skipped counts, wall time, per-shard
// timing, slowest tests, failing/flaky tests with links to the report and their traces/screenshots. Used for the
// job summary and the sticky PR comment, same shape as momentumbets/mb-stack's "E2E Tests" comment.
//
//   node scripts/e2e-report.mjs --results results.json [--jobs jobs.json] [--report-url URL] [--run-url URL]
//                               [--selection "full suite"|...] [--out summary.md]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- jarvis-e2e-report -->";

const fmt = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** Flatten the JSON reporter's suites into one row per test (all projects). */
export function collectTests(report) {
  const rows = [];
  const walk = (suite, titles) => {
    const t = suite.title && !suite.title.endsWith(".ts") ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results.at(-1);
        rows.push({
          file: spec.file,
          line: spec.line,
          title: [...t, spec.title].join(" › "),
          project: test.projectName,
          status: test.status, // expected | unexpected | flaky | skipped
          duration: results.reduce((n, r) => n + (r.duration ?? 0), 0),
          retries: Math.max(0, results.length - 1),
          error: (last?.error?.message ?? results.find((r) => r.error)?.error?.message ?? "").split("\n")[0].replace(/\u001b\[[0-9;]*m/g, ""),
          attachments: results.flatMap((r) => (r.attachments ?? []).filter((a) => a.path).map((a) => ({ name: a.name, path: a.path }))),
        });
      }
    for (const s of suite.suites ?? []) walk(s, t);
  };
  for (const s of report.suites ?? []) walk(s, []);
  return rows;
}

/** Shard jobs from `gh api .../runs/<id>/attempts/<n>/jobs`: name, wall time, test step time. */
export function shardTimings(jobs) {
  return (jobs?.jobs ?? jobs ?? [])
    .filter((j) => /playwright/i.test(j.name) && /shard/i.test(j.name))
    .map((j) => {
      const wall = j.started_at && j.completed_at ? Date.parse(j.completed_at) - Date.parse(j.started_at) : undefined;
      const step = (j.steps ?? []).find((s) => /run playwright/i.test(s.name));
      const tests = step?.started_at && step?.completed_at ? Date.parse(step.completed_at) - Date.parse(step.started_at) : undefined;
      return { name: j.name, conclusion: j.conclusion ?? j.status, wall, tests, url: j.html_url };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function renderSummary({ report, jobs, reportUrl, runUrl, selection, artifactNote }) {
  const stats = report.stats ?? {};
  const tests = collectTests(report);
  const n = (k) => stats[k] ?? tests.filter((t) => t.status === k).length;
  const failed = tests.filter((t) => t.status === "unexpected");
  const flaky = tests.filter((t) => t.status === "flaky");
  const passed = n("expected") > 0 || failed.length === 0;
  const ok = failed.length === 0 && passed;
  const lines = [MARKER, `## ${ok ? "✅" : "❌"} E2E Tests ${ok ? "passed" : "failed"}`, ""];
  lines.push(
    `**Results:** ${n("expected")} passed, ${n("unexpected")} failed, ${n("flaky")} flaky, ${n("skipped")} skipped · ${tests.length} test runs · Playwright wall time ${fmt(stats.duration ?? 0)}`,
  );
  if (selection) lines.push(`**Selection:** ${selection}`);
  lines.push("");
  if (reportUrl) lines.push(`📊 **[Playwright report](${reportUrl})**${artifactNote ? ` ${artifactNote}` : ""}`);
  if (runUrl) lines.push(`🔗 **[Workflow run](${runUrl})**`);
  lines.push("");

  const testLine = (t) => {
    const traces = t.attachments.filter((a) => a.name === "trace").length;
    const shots = t.attachments.filter((a) => /screenshot|actual|diff/.test(a.name)).length;
    const extra = [traces && `${traces} trace${traces > 1 ? "s" : ""}`, shots && `${shots} image${shots > 1 ? "s" : ""}`].filter(Boolean).join(", ");
    return `- \`[${t.project}] ${t.file}:${t.line}\` ${t.title}${t.error ? ` — ${t.error.slice(0, 160)}` : ""}${extra ? ` _(${extra} in the report)_` : ""}`;
  };
  const section = (rows, icon, label, open) =>
    rows.length
      ? [
          `<details${open ? " open" : ""}>`,
          `<summary>${icon} ${label} (${rows.length})</summary>`,
          "",
          ...rows.slice(0, 50).map(testLine),
          rows.length > 50 ? `- … ${rows.length - 50} more in the report` : "",
          "</details>",
          "",
        ]
      : [];
  const snapshot = failed.filter((t) => /toHaveScreenshot|toMatchSnapshot|screenshot/i.test(t.error));
  lines.push(
    ...section(
      failed,
      "❌",
      snapshot.length ? `Failed tests — ${failed.length - snapshot.length} functional, ${snapshot.length} snapshot` : "Failed tests",
      true,
    ),
  );
  lines.push(...section(flaky, "⚠️", "Flaky tests (passed on retry)", true));

  const shards = shardTimings(jobs);
  if (shards.length) {
    const longest = Math.max(...shards.map((s) => s.wall ?? 0));
    lines.push(
      "<details open>",
      `<summary>⏱️ Shards (${shards.length}) · slowest ${fmt(longest)}</summary>`,
      "",
      "| Shard | Result | Job wall | Playwright step |",
      "| --- | --- | --- | --- |",
    );
    for (const s of shards) lines.push(`| [${s.name}](${s.url}) | ${s.conclusion} | ${s.wall ? fmt(s.wall) : "–"} | ${s.tests ? fmt(s.tests) : "–"} |`);
    lines.push("", "</details>", "");
  }

  const slow = [...tests].sort((a, b) => b.duration - a.duration).slice(0, 10);
  if (slow.length) {
    lines.push("<details>", "<summary>🐢 Slowest tests</summary>", "", "| Time | Test |", "| --- | --- |");
    for (const t of slow) lines.push(`| ${fmt(t.duration)} | \`[${t.project}] ${t.file}\` ${t.title.replace(/\|/g, "\\|")} |`);
    lines.push("", "</details>", "");
  }
  if (!ok)
    lines.push(
      "<sub>Open a failing test in the report for its trace (opens in the Playwright trace viewer), screenshots and diff. Visual mismatches: run the *Update visual baselines* workflow on the branch.</sub>",
    );
  return { markdown: lines.join("\n"), ok, failed: failed.length, flaky: flaky.length, total: tests.length };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resultsPath = arg("results") ?? "results.json";
  const report = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, "utf8")) : { suites: [], stats: {} };
  const jobsPath = arg("jobs");
  const jobs = jobsPath && fs.existsSync(jobsPath) ? JSON.parse(fs.readFileSync(jobsPath, "utf8")) : undefined;
  const out = renderSummary({
    report,
    jobs,
    reportUrl: arg("report-url"),
    runUrl: arg("run-url"),
    selection: arg("selection"),
    artifactNote: arg("report-note"),
  });
  if (arg("out")) fs.writeFileSync(arg("out"), `${out.markdown}\n`);
  else process.stdout.write(`${out.markdown}\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${out.ok}\nfailed=${out.failed}\nflaky=${out.flaky}\ntotal=${out.total}\n`);
}
