import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { expressible, lineFor, parallelFilesIn, plan, recordTimings, testsOf } from "../scripts/e2e-shards.mjs";

type T = { project: string; file: string; titles: string[] };
const t = (project: string, file: string, ...titles: string[]): T => ({ project, file, titles });

/** A JSON report (as `--list` or a finished run writes it) holding these tests, with optional first-attempt times. */
function report(tests: (T & { ms?: number })[]) {
  const files = new Map<string, { file: string; title: string; specs: unknown[]; suites: unknown[] }>();
  for (const x of tests) {
    type S = { title: string; specs: unknown[]; suites: S[] };
    let suite = files.get(x.file) as unknown as S | undefined;
    if (!suite) {
      const fresh = { file: x.file, title: x.file, specs: [], suites: [] };
      files.set(x.file, fresh);
      suite = fresh as unknown as S;
    }
    for (const d of x.titles.slice(0, -1)) {
      let c: S | undefined = suite.suites.find((s) => s.title === d);
      if (!c) suite.suites.push((c = { title: d, specs: [], suites: [] }));
      suite = c;
    }
    suite.specs.push({ title: x.titles.at(-1), tests: [{ projectName: x.project, results: x.ms === undefined ? [] : [{ duration: x.ms }] }] });
  }
  return { config: { rootDir: "e2e" }, suites: [...files.values()] };
}

describe("e2e shards by recorded time", () => {
  it("reads every test from a report and leaves the setup project to Playwright", () => {
    const r = report([
      t("setup", "onboarding.setup.ts", "server 0 onboarding"),
      t("mobile", "home.spec.ts", "Home", "shows Now"),
      t("desktop", "a.spec.ts", "one"),
    ]);
    expect(testsOf(r).map(lineFor)).toEqual(["[mobile] › home.spec.ts › Home › shows Now", "[desktop] › a.spec.ts › one"]);
  });

  it("puts every test on exactly one shard, the same way every time", () => {
    const tests = Array.from({ length: 60 }, (_, i) => t(i % 2 ? "mobile" : "desktop", `f${i % 9}.spec.ts`, `test ${i}`));
    const timings = { mobile: { "f1.spec.ts": { "test 1": 9000 } } };
    const a = plan(tests, { shards: 5, timings });
    const b = plan([...tests].reverse(), { shards: 5, timings });
    expect(a.map((s) => s.tests.map(lineFor))).toEqual(b.map((s) => s.tests.map(lineFor)));
    const lines = a.flatMap((s) => s.tests.map(lineFor));
    expect(lines).toHaveLength(60);
    expect(new Set(lines).size).toBe(60);
  });

  it("keeps a spec file whole per project, and splits only parallel files", () => {
    const tests = [
      t("mobile", "serial.spec.ts", "a"),
      t("mobile", "serial.spec.ts", "b"),
      t("mobile", "serial.spec.ts", "c"),
      t("desktop", "serial.spec.ts", "a"),
      t("mobile", "a11y.spec.ts", "x"),
      t("mobile", "a11y.spec.ts", "y"),
      t("mobile", "a11y.spec.ts", "group", "z1"),
      t("mobile", "a11y.spec.ts", "group", "z2"),
    ];
    const timings = { mobile: { "a11y.spec.ts": { x: 5000, y: 5000, "group › z1": 5000, "group › z2": 5000 } } };
    const shards = plan(tests, { shards: 4, timings, parallelFiles: new Set(["a11y.spec.ts"]) });
    const where = (x: T) => shards.findIndex((s) => s.tests.some((y) => lineFor(y) === lineFor(x)));
    // The serial file's mobile tests stay together; its desktop tests are their own group.
    expect(new Set(["a", "b", "c"].map((n) => where(t("mobile", "serial.spec.ts", n)))).size).toBe(1);
    // A parallel file spreads, but a describe in it stays together.
    expect(where(t("mobile", "a11y.spec.ts", "x"))).not.toBe(where(t("mobile", "a11y.spec.ts", "y")));
    expect(where(t("mobile", "a11y.spec.ts", "group", "z1"))).toBe(where(t("mobile", "a11y.spec.ts", "group", "z2")));
  });

  it("balances by time, not by count", () => {
    // One slow file and many quick ones: a count split puts the slow tests together.
    const slow = Array.from({ length: 6 }, (_, i) => t("desktop", "a11y.spec.ts", `zoom ${i}`));
    const quick = Array.from({ length: 30 }, (_, i) => t("mobile", `q${i}.spec.ts`, "quick"));
    const timings = {
      desktop: { "a11y.spec.ts": Object.fromEntries(slow.map((x) => [x.titles[0], 20_000])) },
      mobile: Object.fromEntries(quick.map((x) => [x.file, { quick: 2000 }])),
    };
    const shards = plan([...slow, ...quick], { shards: 3, timings, parallelFiles: new Set(["a11y.spec.ts"]) });
    const loads = shards.map((s) => s.ms);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(2000);
    expect(shards.map((s) => s.tests.filter((x) => x.file === "a11y.spec.ts").length)).toEqual([2, 2, 2]);
  });

  it("counts an unknown test as its file's median, else the suite's", () => {
    const tests = [t("mobile", "a.spec.ts", "known"), t("mobile", "a.spec.ts", "new"), t("mobile", "b.spec.ts", "new too")];
    const timings = { mobile: { "a.spec.ts": { known: 8000 } } };
    const [one] = plan(tests, { shards: 1, timings });
    expect(one!.ms).toBe(8000 + 8000 + 8000);
  });

  it("refuses a test the list format cannot name, so the run falls back to Playwright's own split", () => {
    expect(expressible(t("mobile", "a.spec.ts", "New item in ‹area› → confirm"))).toBe(false);
    expect(expressible(t("mobile", "a.spec.ts", " padded"))).toBe(false);
    expect(expressible(t("mobile", "a.spec.ts:12", "x"))).toBe(false);
    expect(expressible(t("mobile", "a.spec.ts", "a > b → c (ok)"))).toBe(true);
    expect(() => plan([t("mobile", "a.spec.ts", "x › y")], { shards: 2 })).toThrow(/cannot name 1 test/);
  });

  it("records first-attempt times by project, file and title path", () => {
    const r = report([
      { ...t("mobile", "a.spec.ts", "Home", "shows Now"), ms: 1234 },
      { ...t("desktop", "a.spec.ts", "one"), ms: 49 },
      { ...t("setup", "onboarding.setup.ts", "onboard"), ms: 9000 },
      t("mobile", "b.spec.ts", "never ran"),
    ]);
    expect(recordTimings(r)).toEqual({ desktop: { "a.spec.ts": { one: 0 } }, mobile: { "a.spec.ts": { "Home › shows Now": 1200 } } });
  });

  it("finds the spec files that run in parallel mode", () => {
    const dir = path.join(process.cwd(), "e2e");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".spec.ts"));
    const parallel = parallelFilesIn(dir, files);
    expect(parallel.has("a11y.spec.ts")).toBe(true);
    expect(parallel.has("visual.spec.ts")).toBe(true);
    expect(parallel.has("brief.spec.ts")).toBe(false);
  });

  it("the committed timings name tests the list format can express", () => {
    const committed = JSON.parse(fs.readFileSync(path.join(process.cwd(), "e2e/timings.json"), "utf8")) as {
      ms: Record<string, Record<string, Record<string, number>>>;
    };
    const projects = Object.keys(committed.ms);
    expect(projects).toEqual(expect.arrayContaining(["mobile", "desktop"]));
    for (const [project, files] of Object.entries(committed.ms))
      for (const [file, titles] of Object.entries(files))
        for (const title of Object.keys(titles)) expect(expressible(t(project, file, ...title.split(" › ")))).toBe(true);
  });
});
