import { describe, expect, it } from "vitest";
import { globToRegExp, pathLiterals, routeMatches, ruleUnits, select, shardCount, splitTopLevel, titlesOf } from "../scripts/e2e-select.mjs";
import { collectTests, renderSummary, shardTimings } from "../scripts/e2e-report.mjs";
import { serverCount, workersFromArgv } from "../e2e/servers";

type Unit = { spec: string; grep: string; files: Set<string>; tests: "all" | number; titles?: string[] };

const unit = (spec: string, files: string[], titles?: string[]): Unit => ({
  spec,
  grep: titles ? ` ${spec.replace(/\./g, "\\.")} (?:${titles.join("|")})` : ` ${spec.replace(/\./g, "\\.")} `,
  files: new Set(files),
  tests: titles ? titles.length : "all",
  titles,
});

const map = {
  maxFraction: 0.6,
  fullSuite: { why: "shared", files: ["package.json", "e2e/fixtures/**", "components/ui/**"] },
  ignore: { why: "docs", files: ["docs/**", "**/*.md"] },
  rules: [
    { why: "skylight", files: ["components/skylight/**"], specs: ["skylight-*.spec.ts"] },
    { why: "chrome", replaceGraph: true, files: ["components/coordinator/**"], specs: ["coord.spec.ts"], titles: { "visual.spec.ts": "coordinator" } },
  ],
  smoke: { why: "always", grep: ["chat\\.spec\\.ts send"] },
};

// 10 selectable units; app/(shell) chrome reaches none of them by the graph.
const units: Unit[] = [
  unit("home.spec.ts", ["components/home/Now.tsx", "server/home.ts"]),
  unit("finance.spec.ts", ["components/finance/Nav.tsx"]),
  unit("skylight-write.spec.ts", ["integrations/skylight/write.ts"]),
  unit("skylight-zz.spec.ts", []),
  unit("coord.spec.ts", []),
  unit("chat.spec.ts", []),
  unit("work.spec.ts", ["server/work/store.ts"]),
  unit("people.spec.ts", ["server/work/store.ts"]),
  unit("visual.spec.ts", ["components/home/Now.tsx"], ["visual: home"]),
  unit("visual.spec.ts", [], ["visual: coordinator pane \\(.*\\)"]),
];
const shell = new Set(["components/navigation/Sidebar.tsx"]);

describe("e2e selection", () => {
  it("globs: ** spans dirs, * stays in a segment", () => {
    expect(globToRegExp("components/ui/**").test("components/ui/kit/Button.tsx")).toBe(true);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("lib/ui*").test("lib/ui-tokens.ts")).toBe(true);
    expect(globToRegExp("lib/ui*").test("lib/ui/x.ts")).toBe(false);
    expect(globToRegExp("skylight-*.spec.ts").test("skylight-zz-everywhere.spec.ts")).toBe(true);
  });

  it("finds URL literals and matches them to app routes (dynamic segments, template cuts, sub-pages)", () => {
    const lits = pathLiterals('goto("/areas?item=x"); request.get(`/api/work/items/${id}`); x = "/"; y = `/${a}`');
    expect(lits).toEqual([
      { path: "/areas", cut: false },
      { path: "/api/work/items", cut: true },
    ]);
    expect(routeMatches(["api", "work", "items", "[id]"], { path: "/api/work/items", cut: true })).toBe(true);
    // A cut literal may also be `/items${query}`: matching the list route too only over-selects.
    expect(routeMatches(["api", "work", "items"], { path: "/api/work/items", cut: true })).toBe(true);
    expect(routeMatches(["api", "work"], { path: "/api/work/items", cut: true })).toBe(false);
    expect(routeMatches(["chat", "[sessionId]"], { path: "/chat/sess_1", cut: false })).toBe(true);
    expect(routeMatches(["finance", "accounts"], { path: "/finance", cut: false })).toBe(false);
    expect(routeMatches(["finance", "accounts"], { path: "/finance", cut: true })).toBe(true);
    expect(routeMatches(["docs", "[...slug]"], { path: "/docs/a/b", cut: false })).toBe(true);
  });

  it("splits a parallel spec into tests and turns template titles into regexes", () => {
    const blocks = splitTopLevel(
      [
        'import { test } from "@playwright/test";',
        "const H = 1;",
        "test.beforeEach(async () => {});",
        'test("visual: home", async () => {',
        '  await page.goto("/home");',
        "});",
        'for (const s of ["light", "dark"]) {',
        "  test(`visual: inbox (${s})`, async () => {});",
        "}",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["shared", "shared", "hook", "test", "test"]);
    expect(titlesOf(blocks[3].text)).toEqual(["visual: home"]);
    expect(titlesOf(blocks[4].text)).toEqual(["visual: inbox \\(.*\\)"]);
  });

  it("push, nightly and dispatch always run the full suite; so does the full-e2e label", () => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) expect(select({ changed: [], event, map, units }).mode).toBe("full");
    expect(select({ changed: ["docs/ci.md"], labels: ["full-e2e"], map, units }).mode).toBe("full");
    expect(select({ changed: undefined, map, units }).mode).toBe("full");
  });

  it("shared files force the full suite, but their unit tests don't", () => {
    const r = select({ changed: ["e2e/fixtures/home.ts"], map, units, shell });
    expect(r.mode).toBe("full");
    expect(r.reasons.at(-1)).toMatch(/shared file changed/);
    expect(select({ changed: ["components/ui/kit.test.tsx"], map, units, shell }).mode).toBe("subset");
  });

  it("docs-only PRs run just the smoke set", () => {
    const r = select({ changed: ["docs/ci.md", "README.md"], map, units, shell });
    expect(r).toMatchObject({ mode: "subset", specs: [] });
    expect(r.grep).toBe("(?: chat\\.spec\\.ts send)");
  });

  it("a page component selects the specs and the visual tests that reach it, plus smoke", () => {
    const r = select({ changed: ["components/home/Now.tsx"], map, units, shell });
    expect(r.mode).toBe("subset");
    expect(r.specs).toEqual(["home.spec.ts", "visual.spec.ts"]);
    expect(r.grep).toContain("(?: home\\.spec\\.ts )");
    expect(r.grep).toContain("visual: home");
    expect(r.grep).not.toContain("coordinator");
    expect(r.grep).toContain("chat\\.spec\\.ts send");
  });

  it("changed specs run as they are; rules add specs the graph can't see", () => {
    const r = select({ changed: ["e2e/finance.spec.ts", "components/skylight/Row.tsx"], map, units, shell });
    expect(r.specs).toEqual(["finance.spec.ts", "skylight-write.spec.ts", "skylight-zz.spec.ts"]);
  });

  it("replaceGraph rules narrow app-shell chrome; un-ruled chrome runs everything", () => {
    const r = select({ changed: ["components/coordinator/Tray.tsx"], map, units, shell });
    expect(r.specs).toEqual(["coord.spec.ts", "visual.spec.ts"]);
    expect(ruleUnits(map.rules[1], units).map((u) => u.grep)).toEqual([" coord\\.spec\\.ts ", " visual\\.spec\\.ts (?:visual: coordinator pane \\(.*\\))"]);
    const chrome = select({ changed: ["components/navigation/Sidebar.tsx"], map, units, shell });
    expect(chrome.mode).toBe("full");
    expect(chrome.reasons.at(-1)).toMatch(/app-shell chrome/);
  });

  it("falls back to the full suite above maxFraction", () => {
    const r = select({
      changed: ["components/home/Now.tsx", "server/work/store.ts", "e2e/finance.spec.ts", "e2e/chat.spec.ts", "integrations/skylight/write.ts"],
      map,
      units,
      shell,
    });
    expect(r.mode).toBe("full");
    expect(r.reasons.at(-1)).toMatch(/covers 70% of the suite \(> 60%\)/);
  });

  it("uses fewer shards for small selections", () => {
    expect(shardCount({ mode: "full", fraction: 1 }, 4)).toBe(4);
    expect(shardCount({ mode: "subset", fraction: 0.1 }, 4)).toBe(1);
    expect(shardCount({ mode: "subset", fraction: 0.3 }, 4)).toBe(2);
    expect(shardCount({ mode: "subset", fraction: 0.5 }, 4)).toBe(4);
  });
});

describe("per-worker e2e servers", () => {
  it("reads the worker count from E2E_WORKERS or a numeric --workers", () => {
    expect(workersFromArgv(["node", "playwright", "test", "--workers", "3"])).toBe(3);
    expect(workersFromArgv(["--workers=4"])).toBe(4);
    expect(workersFromArgv(["-j2"])).toBe(2);
    expect(workersFromArgv(["test", "e2e/a.spec.ts"])).toBeUndefined();
    expect(() => workersFromArgv(["--workers", "50%"])).toThrow(/numeric worker count/);
    expect(serverCount({ E2E_WORKERS: "2" }, ["--workers", "3"])).toBe(2);
    expect(serverCount({}, ["--workers", "3"])).toBe(3);
    expect(serverCount({}, [])).toBe(1);
  });
});

describe("e2e report summary", () => {
  const report = {
    stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 0, duration: 125_000 },
    suites: [
      {
        title: "a.spec.ts",
        specs: [
          { title: "ok", file: "a.spec.ts", line: 3, tests: [{ projectName: "mobile", status: "expected", results: [{ duration: 1000 }] }] },
          {
            title: "breaks",
            file: "a.spec.ts",
            line: 9,
            tests: [
              {
                projectName: "desktop",
                status: "unexpected",
                results: [
                  {
                    duration: 4000,
                    error: { message: "Error: expect(page).toHaveScreenshot() failed\nmore" },
                    attachments: [{ name: "trace", path: "/t/trace.zip" }],
                  },
                ],
              },
            ],
          },
        ],
        suites: [
          {
            title: "group",
            specs: [
              {
                title: "flips",
                file: "a.spec.ts",
                line: 20,
                tests: [{ projectName: "mobile", status: "flaky", results: [{ duration: 2000 }, { duration: 1500 }] }],
              },
            ],
          },
        ],
      },
    ],
  };

  it("collects tests with their describe path, retries and attachments", () => {
    const rows = collectTests(report);
    expect(rows.map((r) => [r.title, r.status, r.retries])).toEqual([
      ["ok", "expected", 0],
      ["breaks", "unexpected", 0],
      ["group › flips", "flaky", 1],
    ]);
    expect(rows[1].attachments).toEqual([{ name: "trace", path: "/t/trace.zip" }]);
  });

  it("renders counts, failing/flaky tests, shard timing and the slowest tests", () => {
    const jobs = {
      jobs: [
        {
          name: "Playwright shard 2/2",
          conclusion: "success",
          started_at: "2026-11-12T10:00:00Z",
          completed_at: "2026-11-12T10:06:30Z",
          steps: [{ name: "Run Playwright (shard 2/2)", started_at: "2026-11-12T10:01:00Z", completed_at: "2026-11-12T10:06:00Z" }],
        },
        { name: "Playwright shard 1/2", conclusion: "failure", started_at: "2026-11-12T10:00:00Z", completed_at: "2026-11-12T10:08:00Z", steps: [] },
        { name: "Build", conclusion: "success" },
      ],
    };
    expect(shardTimings(jobs).map((s) => [s.name, s.wall, s.tests])).toEqual([
      ["Playwright shard 1/2", 480_000, undefined],
      ["Playwright shard 2/2", 390_000, 300_000],
    ]);
    const { markdown, ok, failed, flaky } = renderSummary({ report, jobs, reportUrl: "https://r", runUrl: "https://run", selection: "full suite" });
    expect({ ok, failed, flaky }).toEqual({ ok: false, failed: 1, flaky: 1 });
    expect(markdown).toContain("<!-- jarvis-e2e-report -->");
    expect(markdown).toContain("2 passed, 1 failed, 1 flaky, 0 skipped");
    expect(markdown).toContain("Playwright wall time 2m 05s");
    expect(markdown).toContain("Failed tests — 0 functional, 1 snapshot");
    expect(markdown).toContain("`[desktop] a.spec.ts:9` breaks — Error: expect(page).toHaveScreenshot() failed _(1 trace in the report)_");
    expect(markdown).toContain("slowest 8m 00s");
    expect(markdown).toContain("| 4s | `[desktop] a.spec.ts` breaks |");
  });
});
