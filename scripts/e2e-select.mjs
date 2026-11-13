#!/usr/bin/env node
// Smart e2e selection for pull requests (docs/ci.md).
//
//   node scripts/e2e-select.mjs [--base <ref>] [--files a,b | --files-from list.txt] [--event pull_request]
//                               [--labels a,b] [--json] [--github]
//
// Maps the PR's changed files to the Playwright specs that can see them:
//   1. full suite on push/schedule/dispatch, with the `full-e2e` label, when a shared/risky file changes
//      (e2e/selection-map.json fullSuite) or when the selection would cover more than maxFraction of the suite;
//   2. changed spec files run as they are;
//   3. every other file goes through a static graph: imports (relative + `@/`), client `"/api/..."` literals →
//      the API route handling them, app routes (page + its layouts) → the specs that visit those URLs. a11y and
//      visual run test-by-test, so only their tests that visit an affected URL are picked;
//   4. hand-written rules in the map add specs the graph can't see (e.g. Skylight chores shown on Today);
//   5. the smoke set always runs.
// Output: a Playwright `--grep` regex (spec file names + smoke titles); sharding still works on the subset.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];
const PARALLEL_FILES = new Set(["a11y.spec.ts", "visual.spec.ts"]);
/**
 * The app shell wraps every page, so its closure (sidebar, palette, Chief of staff tray, …) would make every spec
 * depend on half the repo. Page closures leave it out; a change that only the shell reaches is "chrome": it runs
 * the specs of a matching map rule, else the full suite.
 */
const SHELL_LAYOUTS = ["app/layout.tsx", "app/(shell)/layout.tsx"];

/** Glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Source graph ────────────────────────────────────────────────────────────────────────────────────────────────

function listFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Specifiers from import/export-from/dynamic import/require. */
export function importsOf(text) {
  const out = new Set();
  const re =
    /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|@import\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) out.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return [...out];
}

/** `/x/y` paths in string/template literals (template text stops at the first `${`; `cut` = more follows). */
export function pathLiterals(text) {
  const out = [];
  const re = /(["'`])(\/(?:[a-zA-Z0-9_.\-[\]]+\/?)*[a-zA-Z0-9_.\-[\]]*)(\$\{|\?|#|\1)/g;
  for (const m of text.matchAll(re)) {
    const p = m[2].replace(/\/+$/, "") || "/";
    const cut = m[3] === "${" || m[2].endsWith("/");
    if (p === "/" && (cut || m[3] !== m[1])) continue; // "/${x}" or "/?q": could be anything, not a route
    out.push({ path: p, cut });
  }
  return out;
}

function resolveSpecifier(from, spec, files) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return undefined;
  if (files.has(base)) return base;
  for (const e of EXT) if (files.has(base + e)) return base + e;
  for (const e of EXT) if (files.has(`${base}/index${e}`)) return `${base}/index${e}`;
  return undefined;
}

/** App router: page.tsx / route.ts → URL segments (route groups and slots dropped). */
function routeOf(file) {
  const m = /^app\/(?:(.*)\/)?(page|route)\.(?:tsx?|jsx?)$/.exec(file);
  if (!m) return undefined;
  const segs = (m[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return { file, kind: m[2], segs };
}

const dynamicSeg = (s) => /^\[.*\]$/.test(s);
const catchAll = (s) => /^\[\[?\.\.\./.test(s);

/** Does a literal URL path (maybe cut short by a template `${`) address this route? */
export function routeMatches(segs, literal) {
  const lit = literal.path.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (catchAll(segs[i])) return true;
    if (i >= lit.length) return literal.cut && i === lit.length;
    if (!dynamicSeg(segs[i]) && segs[i] !== lit[i]) return false;
  }
  return lit.length === segs.length;
}

/** Layout-like files that wrap a page: every ancestor dir's layout/template/loading/error/not-found/default. */
function wrappersOf(pageFile, files) {
  const out = [];
  let dir = path.posix.dirname(pageFile);
  while (dir.startsWith("app")) {
    for (const n of ["layout", "template", "loading", "error", "not-found", "default"])
      for (const e of [".tsx", ".ts", ".jsx", ".js"]) if (files.has(`${dir}/${n}${e}`)) out.push(`${dir}/${n}${e}`);
    if (dir === "app") break;
    dir = path.posix.dirname(dir);
  }
  return out;
}

export function buildGraph(root = ROOT, fileList = listFiles(root)) {
  const files = new Set(fileList.filter((f) => fs.existsSync(path.join(root, f))));
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), "utf8");
    } catch {
      return "";
    }
  };
  const routes = [...files].map(routeOf).filter(Boolean);
  const apiRoutes = routes.filter((r) => r.kind === "route" && r.segs[0] === "api");
  const pageRoutes = routes.filter((r) => r.kind === "page");
  const edges = new Map(); // file → Set(file) it depends on
  const isSource = (f) => (CODE.test(f) || f.endsWith(".css")) && !f.startsWith("e2e/") && !f.startsWith("node_modules/");
  for (const f of files) {
    if (!isSource(f)) continue;
    const text = read(f);
    const deps = new Set();
    for (const s of importsOf(text)) {
      const r = resolveSpecifier(f, s, files);
      if (r) deps.add(r);
    }
    // Client code calling an API route depends on that route's handler.
    if (!f.startsWith("app/api/") && text.includes("/api/"))
      for (const lit of pathLiterals(text)) if (lit.path.startsWith("/api/")) for (const r of apiRoutes) if (routeMatches(r.segs, lit)) deps.add(r.file);
    edges.set(f, deps);
  }
  const graph = { root, files, edges, pageRoutes, apiRoutes, read };
  graph.shell = closure(
    graph,
    SHELL_LAYOUTS.filter((f) => files.has(f)),
  );
  return graph;
}

function closure(graph, starts) {
  const seen = new Set();
  const stack = [...starts];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of graph.edges.get(f) ?? []) if (!seen.has(d)) stack.push(d);
  }
  return seen;
}

/** Entry files for the URLs a piece of test code visits or calls. */
function entriesFor(graph, text) {
  const entries = new Set();
  for (const lit of pathLiterals(text)) {
    if (lit.path.startsWith("/api/")) {
      for (const r of graph.apiRoutes) if (routeMatches(r.segs, lit)) entries.add(r.file);
    } else {
      // A visited page also covers the pages under it (reached by clicking through: /finance → /finance/accounts).
      for (const r of graph.pageRoutes)
        if (routeMatches(r.segs, lit) || routeMatches(r.segs, { ...lit, cut: true })) {
          entries.add(r.file);
          for (const w of wrappersOf(r.file, graph.files)) if (!SHELL_LAYOUTS.includes(w)) entries.add(w);
        }
    }
  }
  return entries;
}

/** Split a spec into top-level blocks: tests (or loops of tests) and the shared code around them. */
export function splitTopLevel(text) {
  const blocks = [];
  const lines = text.split("\n");
  let cur = null;
  const flush = () => cur && blocks.push({ ...cur, text: cur.lines.join("\n") });
  for (const line of lines) {
    if (/^\S/.test(line) && !/^[)}\]]/.test(line)) {
      flush();
      const kind =
        /^(?:test|for)\b/.test(line) && !/^test\.(?:beforeEach|afterEach|beforeAll|afterAll|use|describe\.configure)\b/.test(line)
          ? "test"
          : /^test\.(?:beforeEach|afterEach|beforeAll|afterAll)\b/.test(line)
            ? "hook"
            : "shared";
      cur = { kind, lines: [line] };
    } else if (cur) cur.lines.push(line);
    else cur = { kind: "shared", lines: [line] };
  }
  flush();
  return blocks.filter((b) => b.kind !== "test" || /\btest\(/.test(b.text));
}

/** Titles of the tests in a block as regex sources (template `${…}` → `.*`). */
export function titlesOf(text) {
  const out = [];
  for (const m of text.matchAll(/\btest\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    const raw = m[2];
    out.push(
      m[1] === "`"
        ? raw
            .split(/\$\{[^}]*\}/)
            .map(escapeRe)
            .join(".*")
        : escapeRe(raw.replace(/\\(.)/g, "$1")),
    );
  }
  return out;
}

/** Declared top-level names in shared code (function/const/let/class). */
function declaredNames(text) {
  return [...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
}

/** Expand code with the shared declarations (and helpers.ts functions) it references, transitively. */
function expandRefs(text, decls) {
  let out = text;
  const used = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of decls)
      if (!used.has(name) && new RegExp(`\\b${escapeRe(name)}\\b`).test(out)) {
        used.add(name);
        out += `\n${body}`;
        grew = true;
      }
  }
  return out;
}

/**
 * Units of selection: one per spec file, or one per top-level test block for a11y/visual. Each unit lists the
 * source files it can see (closure of the URLs it visits + the modules it imports).
 */
export function specUnits(graph, specDir = "e2e") {
  const specs = [...graph.files].filter((f) => f.startsWith(`${specDir}/`) && f.endsWith(".spec.ts")).sort();
  const helperDecls = new Map();
  const helpers = graph.read(`${specDir}/helpers.ts`);
  for (const b of splitTopLevel(helpers)) for (const n of declaredNames(b.text)) helperDecls.set(n, b.text);
  const units = [];
  for (const spec of specs) {
    const name = spec.slice(specDir.length + 1);
    const text = graph.read(spec);
    const imported = new Set();
    for (const s of importsOf(text)) {
      const r = resolveSpecifier(spec, s, graph.files);
      if (r && !r.startsWith(`${specDir}/`)) imported.add(r);
    }
    const reach = (code) => closure(graph, [...entriesFor(graph, expandRefs(code, helperDecls)), ...imported]);
    if (!PARALLEL_FILES.has(name)) {
      units.push({ spec: name, grep: ` ${escapeRe(name)} `, files: reach(text), tests: "all" });
      continue;
    }
    const blocks = splitTopLevel(text);
    const decls = new Map([...helperDecls]);
    for (const b of blocks) if (b.kind === "shared") for (const n of declaredNames(b.text)) decls.set(n, b.text);
    const hooks = blocks
      .filter((b) => b.kind === "hook")
      .map((b) => b.text)
      .join("\n");
    for (const b of blocks.filter((x) => x.kind === "test")) {
      const titles = titlesOf(b.text);
      if (!titles.length) continue;
      const code = expandRefs(`${b.text}\n${hooks}`, decls);
      units.push({
        spec: name,
        grep: ` ${escapeRe(name)} (?:${titles.join("|")})(?: @|$)`,
        files: closure(graph, [...entriesFor(graph, code), ...imported]),
        tests: titles.length,
        titles,
      });
    }
  }
  return units;
}

// ── Selection ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Units a map rule adds: whole spec files (`specs` globs) and title-matched a11y/visual tests (`titles`). */
export function ruleUnits(rule, units) {
  const specRes = (rule.specs ?? []).map(globToRegExp);
  const titleRes = Object.entries(rule.titles ?? {}).map(([spec, re]) => [spec, new RegExp(re, "i")]);
  return units.filter(
    (u) =>
      specRes.some((re) => re.test(u.spec)) ||
      titleRes.some(([spec, re]) => spec === u.spec && (u.titles ?? []).some((t) => re.test(t.replace(/\\(.)/g, "$1")))),
  );
}

export function loadMap(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, "e2e/selection-map.json"), "utf8"));
}

/**
 * Decide what to run. `units` from specUnits(); `changed` = repo-relative paths.
 * Returns { mode: "full" | "subset", reasons: string[], specs: string[], grep?: string, fraction }.
 */
export function select({ changed, event = "pull_request", labels = [], map, units, shell = new Set() }) {
  const reasons = [];
  const full = (why) => ({ mode: "full", reasons: [...reasons, why], specs: [], fraction: 1 });
  if (event !== "pull_request") return full(`${event}: main, nightly and manual runs always run the full suite`);
  if (labels.includes("full-e2e")) return full("label full-e2e");
  if (!changed) return full("changed files unknown");
  const isTest = (f) => /\.test\.tsx?$/.test(f) || f.startsWith("test/");
  const risky = changed.filter((f) => !isTest(f) && matchesAny(f, map.fullSuite.files));
  if (risky.length) return full(`shared file changed (${map.fullSuite.why}): ${risky.slice(0, 8).join(", ")}${risky.length > 8 ? " …" : ""}`);

  const picked = new Map(); // unit grep → unit
  const specFiles = new Set(units.map((u) => u.spec));
  const pickSpec = (spec, why) => {
    let any = false;
    for (const u of units)
      if (u.spec === spec) {
        picked.set(u.grep, u);
        any = true;
      }
    if (any) reasons.push(`${spec} ← ${why}`);
  };
  for (const f of changed) {
    if (f.startsWith("e2e/") && f.endsWith(".spec.ts")) {
      const spec = f.slice(4);
      if (specFiles.has(spec)) pickSpec(spec, "spec changed");
      else reasons.push(`${f}: deleted or not a spec (nothing to run)`);
      continue;
    }
    if (f.startsWith("e2e/__screenshots__/")) {
      // Baselines: run the visual tests of that spec/project family (visual.spec.ts).
      const m = /^e2e\/__screenshots__\/[^/]+\/[^/]+\/([^/]+\.spec\.ts)\//.exec(f);
      if (m && specFiles.has(m[1]) && !reasons.some((r) => r.startsWith(`${m[1]} ← baselines`))) pickSpec(m[1], "baselines changed");
      continue;
    }
    if (matchesAny(f, map.ignore.files)) {
      reasons.push(`${f}: ignored (${map.ignore.why})`);
      continue;
    }
    const ruled = map.rules.filter((r) => matchesAny(f, r.files));
    const narrow = ruled.filter((r) => r.replaceGraph);
    let hits = narrow.length ? [] : units.filter((u) => u.files.has(f));
    if (!narrow.length && hits.length > map.maxFraction * units.length)
      return full(`${f} is shared by ${Math.round((100 * hits.length) / units.length)}% of the tests (add a replaceGraph rule to narrow it)`);
    if (!narrow.length && !hits.length && !ruled.length && shell.has(f))
      return full(`${f} is app-shell chrome (every page) and no rule in e2e/selection-map.json narrows it`);
    for (const u of hits) picked.set(u.grep, u);
    for (const r of ruled) for (const u of ruleUnits(r, units)) picked.set(u.grep, u);
    const specsHit = [...new Set(hits.map((u) => u.spec))];
    if (narrow.length) hits = [];
    if (hits.length || ruled.length)
      reasons.push(
        `${f} → ${specsHit.length ? `graph: ${specsHit.map((s) => `${s}${PARALLEL_FILES.has(s) ? ` (${hits.filter((u) => u.spec === s).length} tests)` : ""}`).join(", ")}` : "graph: none"}${ruled.length ? `; rules: ${ruled.map((r) => r.why).join("; ")}` : ""}`,
      );
    else reasons.push(`${f}: no spec reaches it (smoke only)`);
  }

  const weight = (u) => (u.tests === "all" ? 1 : u.tests);
  const total = units.reduce((n, u) => n + (u.tests === "all" ? 1 : u.tests), 0);
  const pickedUnits = [...picked.values()];
  const fraction = total ? pickedUnits.reduce((n, u) => n + weight(u), 0) / total : 0;
  if (fraction > map.maxFraction) return full(`selection covers ${Math.round(fraction * 100)}% of the suite (> ${Math.round(map.maxFraction * 100)}%)`);
  const grep = [...pickedUnits.map((u) => u.grep), ...map.smoke.grep.map((g) => ` ${g}`)].map((g) => `(?:${g})`).join("|");
  return {
    mode: "subset",
    reasons,
    specs: [...new Set(pickedUnits.map((u) => u.spec))].sort(),
    units: pickedUnits.length,
    grep,
    fraction,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function changedFiles(base) {
  try {
    const mb = execFileSync("git", ["merge-base", base, "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    return execFileSync("git", ["diff", "--name-only", `${mb}...HEAD`], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/** CI shard count: the full suite uses all of them, small selections fewer (each shard pays ~2 min of setup). */
export function shardCount(result, full = 4) {
  if (result.mode === "full") return full;
  if (result.fraction <= 0.2) return 1;
  if (result.fraction <= 0.4) return Math.min(2, full);
  return full;
}

export function summaryMarkdown(result) {
  const lines = [
    `### E2E selection: ${result.mode === "full" ? "full suite" : `${result.specs.length} spec files + smoke (${Math.round(result.fraction * 100)}% of the suite)`}`,
    "",
  ];
  if (result.mode === "subset" && result.specs.length) lines.push(`**Specs:** ${result.specs.map((s) => `\`${s}\``).join(", ")}`, "");
  lines.push("<details><summary>Why</summary>", "", ...result.reasons.map((r) => `- ${r.replace(/\|/g, "\\|")}`), "", "</details>", "");
  lines.push("Add the `full-e2e` label to run everything; main and the nightly run always run the full suite.");
  return lines.join("\n");
}

function main() {
  const event = arg("event", process.env.GITHUB_EVENT_NAME ?? "pull_request");
  const labels = String(arg("labels", "") || "")
    .split(",")
    .filter(Boolean);
  let changed;
  const filesFrom = arg("files-from");
  if (typeof filesFrom === "string")
    changed = fs
      .readFileSync(filesFrom, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  else if (typeof arg("files") === "string") changed = arg("files").split(",").filter(Boolean);
  else if (event === "pull_request") changed = changedFiles(arg("base", "origin/main"));
  const map = loadMap();
  const graph = event === "pull_request" ? buildGraph() : undefined;
  const units = graph ? specUnits(graph) : [];
  const result = select({ changed, event, labels, map, units, shell: graph?.shell });
  if (arg("json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${summaryMarkdown(result)}\n${result.grep ? `\n--grep ${JSON.stringify(result.grep)}\n` : ""}`);
  if (arg("github")) {
    if (process.env.GITHUB_OUTPUT) {
      const shards = shardCount(result, Number(process.env.E2E_SHARDS ?? 4));
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `mode=${result.mode}\nshards=${JSON.stringify(Array.from({ length: shards }, (_, i) => i + 1))}\ntotal=${shards}\n`,
      );
      const label = result.mode === "full" ? "full suite" : `${result.specs.length} spec files + smoke (${Math.round(result.fraction * 100)}% of the suite)`;
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `label=${label}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `grep<<__GREP__\n${result.grep ?? ""}\n__GREP__\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryMarkdown(result)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
