#!/usr/bin/env node
/**
 * Demo seed: a busy "Chief of staff" (global coordinator) and a realistic chat list for UX work on the
 * local demo (scripts/dev-demo.mjs: app on :3000, mock upstreams on :4010, data in ./data-dev).
 * Everything here is FICTIONAL (an invented storefront / newsletter / house portfolio).
 *
 *   node scripts/demo-seed-coordinator.mjs            purge what an earlier run seeded, then seed again
 *   node scripts/demo-seed-coordinator.mjs --purge-only   remove the seed and stop
 *   node scripts/demo-seed-coordinator.mjs --no-db    API only: no SQLite access (no backdating, archive instead of delete)
 *   node scripts/demo-seed-coordinator.mjs --force    allow a JARVIS_URL that is not localhost
 *
 * Env: JARVIS_URL (http://localhost:3000), JARVIS_MOCK_URL (http://127.0.0.1:4010), JARVIS_PASSCODE
 * (default: PASSCODE in e2e/helpers.ts), JARVIS_DATA_DIR (./data-dev), JARVIS_MOCK_HERMES_KEY.
 *
 * How it works
 * - Owner session: the real login API, then the normal /api routes (x-jarvis-csrf).
 * - Agent writes (decisions D-n, runs R-n, items for "Changes"): scoped agent tokens over /api/mcp, so
 *   attribution, Activity rows and Undo are the real thing.
 * - Ages (decisions 2+ days old, stalled / failed runs, spread-out Changes): Jarvis has no API to backdate,
 *   so timestamps are rewritten directly in SQLite (better-sqlite3). Demo data only.
 * - Chat: sessions live in the mock Hermes. With its seeding hook (POST /hermes/__mock/seed, added for this
 *   script) transcripts are exact: assistant prose, tool calls, timestamps. A mock started before the hook
 *   existed answers 404; the script then falls back to real runs (your messages verbatim, canned replies).
 *
 * Safe to re-run: every run first removes the areas named in AREAS, the "Demo seed" agent tokens and the
 * `demoseed_*` sessions, and (with SQLite) resets the D-n / R-n counters when nothing else uses them, so
 * the same refs come back. Running runs go Stalled 30 minutes after seeding: re-run before a screenshot session.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MOCK_CREDENTIALS } from "../mock-upstreams/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
if (flags.has("--help") || flags.has("-h")) {
  console.log(
    fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("*/")[0]
      .replace(/^#!.*\n/, ""),
  );
  process.exit(0);
}
const PURGE_ONLY = flags.has("--purge-only");
const NO_DB = flags.has("--no-db");
const APP = (process.env.JARVIS_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const MOCK = (process.env.JARVIS_MOCK_URL ?? "http://127.0.0.1:4010").replace(/\/+$/, "");
const HERMES = `${MOCK}/hermes`;
const HERMES_KEY = process.env.JARVIS_MOCK_HERMES_KEY ?? MOCK_CREDENTIALS.hermesKey;
const DATA_DIR = path.resolve(ROOT, process.env.JARVIS_DATA_DIR ?? "data-dev");

const SESSION_PREFIX = "demoseed_";
const TOKEN_PREFIX = "Demo seed";
const COORDINATOR = "chiefofstaff";
const PROFILES = [COORDINATOR, "devchief", "momentumchief"];
const SID = {
  cos: `${SESSION_PREFIX}portfolio_coordinator`,
  subInventory: `${SESSION_PREFIX}sub_inventory`,
  subPreviews: `${SESSION_PREFIX}sub_previews`,
  home: `${SESSION_PREFIX}home_coordinator`,
  evals: `${SESSION_PREFIX}weekly_eval_review`,
  previews: `${SESSION_PREFIX}preview_cleanup`,
};

const log = (...a) => console.log("[seed]", ...a);
const warn = (...a) => console.warn("[seed] WARNING:", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const H = 60;
const D = 24 * 60;
const iso = (minAgo) => new Date(Date.now() - minAgo * MIN).toISOString();
const unix = (minAgo) => Date.now() / 1000 - minAgo * 60;
/** Local calendar date n days from today ("2026-11-07"), for dates inside agent-written text. */
const day = (n) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// --- transport -----------------------------------------------------------------------------------

let cookie = "";
async function app(method, route, body, { tolerate = false } = {}) {
  const res = await fetch(`${APP}${route}`, {
    method,
    headers: { cookie, origin: APP, "x-jarvis-csrf": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok && !tolerate) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
  return { ok: res.ok, status: res.status, data };
}

async function login() {
  const passcode =
    process.env.JARVIS_PASSCODE ?? fs.readFileSync(path.join(ROOT, "e2e/helpers.ts"), "utf8").match(/export const PASSCODE\s*=\s*"([^"]+)"/)?.[1];
  if (!passcode) throw new Error("No passcode: set JARVIS_PASSCODE (e2e/helpers.ts has no PASSCODE constant)");
  const res = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP, "x-jarvis-csrf": "1" },
    body: JSON.stringify({ passcode }),
  });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}): is the demo running and onboarded at ${APP}?`);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function hermes(method, route, body, { tolerate = false } = {}) {
  const res = await fetch(`${HERMES}${route}`, {
    method,
    headers: { authorization: `Bearer ${HERMES_KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok && !tolerate) throw new Error(`mock hermes ${method} ${route} -> ${res.status} ${text.slice(0, 200)}`);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

const tokens = {};
let rpcId = 0;
/** One MCP tool call as an agent profile. Tool errors throw; a rate limit waits and retries. */
async function mcp(profile, name, args) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${APP}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[profile]}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.json().catch(() => null);
    const result = body?.result;
    if (res.ok && result && !result.isError) return result.structuredContent;
    const text = result?.content?.[0]?.text ?? JSON.stringify(body);
    if (/rate_limited/.test(text) && attempt < 4) {
      log(`  @${profile} hit the 120 calls/min limit, waiting 20 s`);
      await sleep(20_000);
      continue;
    }
    throw new Error(`MCP ${name} as @${profile} failed (${res.status}): ${String(text).slice(0, 300)}`);
  }
}

// --- SQLite (ages, purge) ------------------------------------------------------------------------

let db = null;
function openDb() {
  if (NO_DB) return null;
  const file = path.join(DATA_DIR, "jarvis.db");
  if (!fs.existsSync(file)) {
    warn(`${file} not found: continuing without SQLite (no backdating; set JARVIS_DATA_DIR)`);
    return null;
  }
  try {
    const Database = createRequire(path.join(ROOT, "package.json"))("better-sqlite3");
    const handle = new Database(file);
    handle.pragma("busy_timeout = 5000");
    handle.pragma("foreign_keys = ON");
    return handle;
  } catch (err) {
    warn(`better-sqlite3 could not open the database (${err.message}): continuing without SQLite`);
    return null;
  }
}
const marks = (n) => Array.from({ length: n }, () => "?").join(",");

/** Remove everything a previous run created. API first (so the app's own rules run), then the rows. */
async function purge(uid) {
  const sessions = (await app("GET", "/api/hermes/sessions", undefined, { tolerate: true })).data?.sessions ?? [];
  for (const s of sessions) {
    if (s.id.startsWith(SESSION_PREFIX) && s.activeRun)
      await app("POST", `/api/hermes/runs/${encodeURIComponent(s.activeRun.runId)}/stop`, {}, { tolerate: true });
  }
  const all = (await app("GET", "/api/work/items?archived=1")).data.items;
  const titles = new Set(AREAS.map((a) => a.title));
  const areas = all.filter((i) => i.kind === "area" && i.parentId === null && !i.builtIn && titles.has(i.title));
  for (const a of areas) if (!a.archived) await app("PATCH", `/api/work/items/${a.id}`, { archived: true });
  const minted = (await app("GET", "/api/settings/agents/tokens")).data.tokens.filter((t) => t.name.startsWith(TOKEN_PREFIX));
  for (const t of minted) if (!t.revokedAt) await app("DELETE", `/api/settings/agents/tokens/${t.id}`, undefined, { tolerate: true });
  const upstream = (await hermes("GET", "/api/sessions?limit=200", undefined, { tolerate: true })).data?.data ?? [];
  for (const s of upstream)
    if (s.id.startsWith(SESSION_PREFIX)) await hermes("DELETE", `/api/sessions/${encodeURIComponent(s.id)}`, undefined, { tolerate: true });
  if (db) {
    const like = `${SESSION_PREFIX}%`;
    db.transaction(() => {
      const roots = [
        ...areas.map((a) => a.id),
        ...db
          .prepare("SELECT id FROM work_items WHERE user_id = ? AND session_id LIKE ?")
          .all(uid, like)
          .map((r) => r.id),
      ];
      const ids = roots.length
        ? db
            .prepare(
              `WITH RECURSIVE tree(id) AS (SELECT id FROM work_items WHERE id IN (${marks(roots.length)}) UNION SELECT w.id FROM work_items w JOIN tree ON w.parent_id = tree.id) SELECT id FROM tree`,
            )
            .all(...roots)
            .map((r) => r.id)
        : [];
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        db.prepare(`DELETE FROM work_ops WHERE item_id IN (${marks(chunk.length)})`).run(...chunk);
        // decisions, agent_runs (and their run_events), work_events and links go with the item (ON DELETE CASCADE).
        db.prepare(`DELETE FROM work_items WHERE id IN (${marks(chunk.length)})`).run(...chunk);
      }
      db.prepare("DELETE FROM session_meta WHERE session_id LIKE ?").run(like);
      db.prepare("DELETE FROM chat_exec_records WHERE parent_session_id LIKE ? OR child_session_id LIKE ?").run(like, like);
      db.prepare("DELETE FROM conversation_reads WHERE user_id = ? AND session_id LIKE ?").run(uid, like);
      db.prepare("DELETE FROM runs WHERE session_id LIKE ?").run(like);
      db.prepare("DELETE FROM agent_tokens WHERE user_id = ? AND name LIKE ?").run(uid, `${TOKEN_PREFIX}%`);
      db.prepare("DELETE FROM notifications WHERE user_id = ? AND type LIKE 'cw.%'").run(uid);
      db.prepare("DELETE FROM owner_markers WHERE user_id = ?").run(uid);
      // D-n / R-n are never reused, so numbering only restarts when the seed was the only user of them.
      if (!db.prepare("SELECT 1 FROM decisions WHERE user_id = ? LIMIT 1").get(uid))
        db.prepare("DELETE FROM settings WHERE key = ?").run(`cw:decision-seq:${uid}`);
      if (!db.prepare("SELECT 1 FROM agent_runs WHERE user_id = ? LIMIT 1").get(uid)) db.prepare("DELETE FROM settings WHERE key = ?").run(`cw:run-seq:${uid}`);
    })();
  }
  log(
    `purged: ${areas.length} area(s), ${minted.length} token(s), ${upstream.filter((s) => s.id.startsWith(SESSION_PREFIX)).length} mock session(s)${db ? "" : " (archived only: no SQLite)"}`,
  );
}

// Ages. Every seeding call is recorded with the age it should have; one pass at the end rewrites the rows.
const seedStart = new Date(Date.now() - 1000).toISOString();
const windows = [];
const decisionAges = [];
const runTimes = [];
/** Run `fn` (one API/MCP write on `itemId`), then remember that whatever it wrote should look `ageMin` old. */
async function aged(ageMin, itemId, fn) {
  await sleep(12); // keeps consecutive windows on one item apart
  const from = new Date(Date.now() - 4).toISOString();
  const out = await fn();
  windows.push({ itemId: typeof itemId === "function" ? itemId(out) : itemId, from, to: new Date(Date.now() + 4).toISOString(), ageMin });
  return out;
}
const shifted = (stamp, ageMin) => new Date(Date.parse(stamp) - ageMin * MIN).toISOString();

function applyAges() {
  if (!db) return warn("no SQLite: decisions, runs and Changes all look brand new (nothing is 'Ageing', 'Stalled' or days old)");
  db.transaction(() => {
    // 1) generic windows: collect first, then write, so a shifted row can never fall into another window.
    const updates = [];
    for (const w of windows) {
      for (const r of db.prepare("SELECT rowid AS k, at FROM work_events WHERE item_id = ? AND at BETWEEN ? AND ?").all(w.itemId, w.from, w.to))
        updates.push(["UPDATE work_events SET at = ? WHERE rowid = ?", shifted(r.at, w.ageMin), r.k]);
      for (const r of db
        .prepare("SELECT rowid AS k, created_at AS at FROM work_ops WHERE item_id = ? AND created_at BETWEEN ? AND ?")
        .all(w.itemId, w.from, w.to))
        updates.push(["UPDATE work_ops SET created_at = ? WHERE rowid = ?", shifted(r.at, w.ageMin), r.k]);
      for (const col of ["created_at", "updated_at"])
        for (const r of db
          .prepare(`SELECT rowid AS k, ${col} AS at FROM work_items WHERE (id = ? OR parent_id = ?) AND ${col} BETWEEN ? AND ?`)
          .all(w.itemId, w.itemId, w.from, w.to))
          updates.push([`UPDATE work_items SET ${col} = ? WHERE rowid = ?`, shifted(r.at, w.ageMin), r.k]);
    }
    for (const [sql, at, key] of updates) db.prepare(sql).run(at, key);
    // 2) decisions: the row, the item's head projection, its Activity row and its undo op.
    for (const d of decisionAges) {
      const at = iso(d.ageMin);
      db.prepare("UPDATE decisions SET created_at = ?, updated_at = ?, asked_at = ? WHERE id = ?").run(at, at, at, d.id);
      const head = db.prepare("SELECT decision FROM work_items WHERE id = ?").get(d.itemId)?.decision;
      if (head) {
        const parsed = JSON.parse(head);
        if (parsed.ref === d.ref) db.prepare("UPDATE work_items SET decision = ? WHERE id = ?").run(JSON.stringify({ ...parsed, askedAt: at }), d.itemId);
      }
      db.prepare("UPDATE work_events SET at = ? WHERE item_id = ? AND at >= ? AND reason LIKE 'Needs your decision:%'").run(at, d.itemId, seedStart);
      db.prepare("UPDATE work_ops SET created_at = ? WHERE item_id = ? AND payload LIKE ?").run(at, d.itemId, `%"raised":"${d.id}"%`);
    }
    // 3) runs: start / last heartbeat / finish, with the run's events spread in between.
    for (const r of runTimes) {
      const started = iso(r.startedMin);
      const updated = iso(r.finishedMin ?? r.updatedMin);
      db.prepare("UPDATE agent_runs SET started_at = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(
        started,
        updated,
        r.finishedMin === undefined ? null : updated,
        r.id,
      );
      const events = db.prepare("SELECT rowid AS k FROM run_events WHERE run_id = ? ORDER BY rowid").all(r.id);
      events.forEach((e, i) => {
        const frac = events.length > 1 ? i / (events.length - 1) : 0;
        const at = new Date(Date.parse(started) + frac * (Date.parse(updated) - Date.parse(started))).toISOString();
        db.prepare("UPDATE run_events SET created_at = ? WHERE rowid = ?").run(at, e.k);
      });
      db.prepare("UPDATE work_events SET at = ? WHERE item_id = ? AND kind = 'agent_run' AND reason = ?").run(
        started,
        r.itemId,
        `started agent run: ${r.title}`,
      );
      db.prepare("UPDATE work_events SET at = ? WHERE item_id = ? AND kind = 'agent_run' AND reason IN (?, ?)").run(
        updated,
        r.itemId,
        `agent run finished: ${r.title}`,
        `agent run failed: ${r.title}`,
      );
    }
  })();
}

// --- content: the work tree ----------------------------------------------------------------------

const AREAS = [
  {
    key: "portfolio",
    title: "Portfolio",
    summary: "The storefront, the newsletter and the infrastructure under them.",
    agentMode: COORDINATOR,
    projects: [
      { key: "storefront", title: "Storefront", summary: "Small online shop: checkout, themes, seasonal sales." },
      { key: "newsletter", title: "Trailhead newsletter", summary: "Weekly hiking newsletter, about 1,900 subscribers." },
      { key: "ops", title: "Ops and infrastructure", summary: "Hosting, domains, backups, preview deployments." },
    ],
  },
  {
    key: "home",
    title: "Home",
    summary: "House projects, repairs and household admin.",
    projects: [
      { key: "garage", title: "Garage shelving build", summary: "Two bays of 2x4 shelving along the north wall." },
      { key: "admin", title: "Household admin", summary: "Service visits, the landlord, recurring chores." },
    ],
  },
  {
    key: "side",
    title: "Side projects",
    summary: "Built for fun: the recipe box app and an eval harness.",
    projects: [
      { key: "recipes", title: "Recipe box app", summary: "Family recipe box with import from two recipe sites." },
      { key: "evals", title: "Eval harness", summary: "Nightly evals for the recipe assistant prompts." },
    ],
  },
];

/** Owner-made items. `ask` raises an old decision whose question is (nearly) the title, as real accounts have. */
const ITEMS = [
  { key: "dbpw", parent: "storefront", title: "Rotate the storefront DB password", ask: { ageMin: 11 * D + 3 * H } },
  { key: "merge", parent: "storefront", title: "Merge the checkout refactor before the sale", ask: { ageMin: 6 * D + 1 * H, choices: ["Yes", "No"] } },
  { key: "theme", parent: "storefront", title: "Switch the storefront theme to the winter palette", ask: { ageMin: 4 * D + 7 * H } },
  { key: "landing", parent: "storefront", title: "Archive the old holiday-sale landing pages", ask: { ageMin: 9 * D, choices: ["Do it", "Not now"] } },
  { key: "domain", parent: "newsletter", title: "Renew the trailhead-news.example domain", ask: { ageMin: 3 * D + 2 * H } },
  { key: "sponsor", parent: "newsletter", title: "Approve the December sponsor slot", ask: { ageMin: 2 * D + 5 * H, by: "momentumchief" } },
  { key: "region", parent: "ops", title: "Move staging to the new region", ask: { ageMin: 8 * D + 4 * H, question: "Decide: move staging to the new region" } },
  { key: "analytics", parent: "ops", title: "Cancel the unused analytics subscription", ask: { ageMin: 5 * D + 9 * H } },
  { key: "stale", parent: "ops", title: "Delete stale preview deployments", ask: { ageMin: 2 * D + 11 * H, choices: ["Do it", "Not now"] } },
  { key: "furnace", parent: "admin", title: "Schedule the furnace service visit", ask: { ageMin: 7 * D + 2 * H, by: "momentumchief" } },
  { key: "paint", parent: "admin", title: "Pick a paint colour for the hallway", ask: { ageMin: 10 * D + 6 * H, by: "momentumchief" } },
  {
    key: "lumber",
    parent: "garage",
    title: "Order lumber for the garage shelving",
    ask: { ageMin: 3 * D + 8 * H, question: "Order lumber for the garage shelving?", choices: ["Yes", "No"], by: "momentumchief" },
  },
  { key: "dbplan", parent: "recipes", title: "Upgrade the recipe box database plan", ask: { ageMin: 2 * D + 2 * H } },
  // Homes for runs, the well-formed decisions and the long agent-written ones; some titles share words with chats (filing suggestions).
  { key: "checkout", parent: "storefront", title: "Checkout refactor", summary: "PR #212: split the cart and payment steps." },
  { key: "inventory", parent: "storefront", title: "Inventory export reconcile" },
  { key: "sendkey", parent: "newsletter", title: "Newsletter sending key" },
  { key: "printer", parent: "newsletter", title: "Printed issue vendor quotes" },
  { key: "hosting", parent: "ops", title: "Storefront hosting renewal" },
  { key: "previews", parent: "ops", title: "Preview deployment cleanup" },
  { key: "backups", parent: "ops", title: "Nightly backup verification" },
  { key: "desk", parent: "admin", title: "Standing desk for the office nook" },
  { key: "dishwasher", parent: "admin", title: "Dishwasher replacement" },
  { key: "syncfix", parent: "recipes", title: "Recipe box sync fix" },
  { key: "importjob", parent: "recipes", title: "Recipe box import duplicates" },
  { key: "nightly", parent: "evals", title: "Nightly eval baseline" },
];

/** Well-formed decisions: short question, why, per-option effects, evidence, a recommendation. */
const PACKED = [
  {
    key: "sendkey",
    ageMin: 3 * D + 1 * H,
    question: "Rotate the newsletter sending key now?",
    choices: ["Rotate now", "Wait until Friday"],
    recommended: "Rotate now",
    risk: ["credential"],
    pack: {
      why: `The current key was pasted into a shared draft on ${day(-3)}. Nothing odd in the send log, but it is no longer private.`,
      facts: [
        { label: "Key age", value: "14 months" },
        { label: "Next send", value: "Thursday issue, about 1,900 subscribers" },
      ],
      options: [
        { choice: "Rotate now", effect: "Sending pauses for about 10 minutes while the new key rolls out. Thursday's issue is not affected." },
        { choice: "Wait until Friday", effect: "No interruption this week; the exposed key stays live for three more days." },
      ],
      evidence: [
        { kind: "url", label: "Provider guide: rotating sending keys", url: "https://docs.example.com/mail/keys#rotate" },
        {
          kind: "log",
          label: "Send log, last 3 entries",
          text: `${day(-4)} 09:02 queued 1904\n${day(-4)} 09:03 sent 1904 (0 bounced)\n${day(-3)} 14:41 draft shared: weekly-notes.md`,
        },
      ],
      unblocks: ["Thursday issue"],
    },
  },
  {
    key: "hosting",
    ageMin: 2 * D + 6 * H,
    question: "Renew the storefront hosting plan for a year?",
    choices: ["Renew for a year", "Switch to monthly", "Let it lapse"],
    recommended: "Renew for a year",
    risk: ["money"],
    pack: {
      why: `The annual plan ends on ${day(9)}. Traffic and storage are well inside the starter tier, so nothing argues for a bigger plan.`,
      facts: [
        { label: "Annual", value: "$228 a year" },
        { label: "Monthly", value: "$24 a month ($288 a year)" },
        { label: "Renewal date", value: day(9) },
      ],
      options: [
        { choice: "Renew for a year", effect: "$228 charged to the card on file on the renewal date. Nothing else changes." },
        { choice: "Switch to monthly", effect: "$24 a month from the renewal date; cancel any time. Costs $60 more over a year." },
        { choice: "Let it lapse", effect: "The storefront goes offline on the renewal date. Data is kept for 30 days." },
      ],
      evidence: [
        { kind: "url", label: "Hosting plan comparison", url: "https://hosting.example.com/pricing" },
        {
          kind: "diff",
          label: "Plan change if renewed",
          text: `- plan: starter-annual (ends ${day(9)})\n+ plan: starter-annual (renews ${day(374)})\n  seats: 1`,
        },
      ],
    },
  },
  {
    key: "syncfix",
    ageMin: 51,
    question: "Ship the recipe box sync fix tonight?",
    choices: ["Ship tonight", "Hold for review"],
    recommended: "Ship tonight",
    defaultChoice: "Ship tonight",
    expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    pack: {
      why: "The second sync still duplicates entries. The fix is four lines and has a test; shipping tonight stops new duplicates before the weekend import.",
      options: [
        { choice: "Ship tonight", effect: "Deploys after the 21:00 backup. Existing duplicates stay until the dedupe job runs." },
        { choice: "Hold for review", effect: "Nothing ships; the weekend import will add roughly 14 more duplicates." },
      ],
      evidence: [
        { kind: "pr", label: "PR #48: dedupe on the second sync", url: "https://github.com/example/recipe-box/pull/48" },
        { kind: "diff", label: "Core change", text: "- if (seen.has(row.id)) continue;\n+ if (seen.has(row.sourceId ?? row.id)) continue;" },
      ],
    },
  },
];

/** Long agent-written "questions" from another profile: a paragraph, raw status tokens, dates, generic choices. */
const LONG = [
  {
    key: "checkout",
    ageMin: 19 * H,
    question: `The checkout refactor (PR #212) merged on ${day(-4)} and the item is ready_to_settle, but the post-merge smoke run on ${day(-3)} still shows one flaky coupon test that I re-ran twice. I can settle the item now and open a follow-up for the flaky test, or leave it open until the nightly run on ${day(1)} is green. Settling closes the item and its three sub-tasks.`,
  },
  {
    key: "previews",
    ageMin: 7 * H,
    question: `There are 41 preview deployments older than 30 days as of ${day(0)}; 6 of them still get traffic from links in the ${day(-20)} newsletter. Status is blocked_on_owner because deleting them breaks those links. I can delete the 35 idle ones today and keep the 6 until ${day(14)}, or delete all 41 now. This cannot be undone once the provider purges them.`,
  },
  {
    key: "nightly",
    ageMin: 4 * H + 20,
    question: `The nightly eval has been in state awaiting_validation since ${day(-2)}: accuracy moved from 81.4% to 79.9% after the prompt change on ${day(-3)}, which is inside the noise band I measured last month (plus or minus 1.8). I propose marking the item ready_to_settle and recording the new baseline. If you would rather I rerun with three seeds first, that takes about 40 minutes of compute tonight.`,
  },
  {
    key: "importjob",
    ageMin: 2 * H + 10,
    question: `Import duplicates: the second sync on ${day(-1)} created 14 duplicate recipes because source ids changed format upstream. The fix is in review and the item goes ready_to_settle once it ships. I can run the one-off dedupe script against production now (it merges by title and source and keeps the older row), or wait for the fix to ship on ${day(1)} and run it after. Running it twice is safe.`,
  },
];

/** R-n runs. `updatedMin` = minutes since the last heartbeat (a running run reads Stalled after 30). */
const RUNS = [
  {
    key: "inventory",
    by: COORDINATOR,
    item: "inventory",
    title: "Reconcile the storefront inventory export",
    delegationId: "deleg_demo_a:sa-demo-inventory",
    state: "running",
    summary: "Reconcile the storefront inventory export",
    startedMin: 3 * H,
    updatedMin: 4,
    events: [
      ["progress", "Loaded 1,204 rows from the nightly export"],
      ["progress", "Compared against the storefront catalogue: 14 rows differ"],
      ["notice", "Background process finished: wrote inventory-diff.csv (14 rows)"],
    ],
  },
  {
    key: "audit",
    by: COORDINATOR,
    item: "previews",
    title: "Audit preview deployments for live traffic",
    delegationId: "deleg_demo_a:sa-demo-previews",
    state: "running",
    summary:
      "35 of the 41 old previews have had no requests in two weeks. Still checking the six that do: so far all of their traffic comes from links in one old newsletter issue.",
    startedMin: 3 * H - 1,
    updatedMin: 9,
    events: [
      ["progress", "Listed 41 previews older than 30 days"],
      ["progress", "35 idle, 6 with requests in the last 14 days"],
    ],
  },
  {
    key: "smoke",
    by: "devchief",
    item: "checkout",
    title: "Checkout refactor: post-merge smoke tests",
    state: "running",
    summary: "Checkout refactor: post-merge smoke tests",
    pipeline: [
      { stage: "build", state: "ok" },
      { stage: "ci", state: "running", label: "smoke 11/12" },
      { stage: "review", state: "pending" },
    ],
    startedMin: 2 * H + 30,
    updatedMin: 47,
    events: [
      ["ci", "Smoke suite started on the merge commit"],
      ["progress", "11 of 12 checks passed; coupon test is flaky"],
      ["notice", "Re-run 1 of the coupon test: failed again"],
    ],
  },
  {
    key: "lumber",
    by: "momentumchief",
    item: "lumber",
    title: "Price lumber for the garage shelving",
    state: "running",
    summary:
      "Priced the cut list at two yards. The first quote came back at $186 for 24 studs and 4 sheets; the second yard has not answered since this morning. I stopped rather than guess a price, and I have not placed an order.",
    startedMin: 6 * H,
    updatedMin: 3 * H + 5,
    events: [
      ["progress", "Built the cut list: 24 studs, 4 sheets of plywood"],
      ["notice", "Quote 1 received from the first yard"],
    ],
  },
  {
    key: "questions",
    by: COORDINATOR,
    item: "domain",
    title: "Collect November reader questions",
    state: "running",
    summary: "Collect November reader questions",
    startedMin: 29 * H,
    updatedMin: 26 * H,
    events: [["progress", "Read 62 replies to the last two issues"]],
  },
  {
    key: "dedupe",
    by: "devchief",
    item: "importjob",
    title: "Recipe box: dedupe import job",
    state: "failed",
    summary:
      "Failed after 3 attempts. The import worker timed out on the 2,000-row batch (limit 30 s) and each retry stopped on the same row. It needs a smaller batch size or the upstream id fix before it can run again.",
    startedMin: 4 * D + 6 * H,
    finishedMin: 4 * D + 5 * H,
    events: [
      ["progress", "Batch 1 of 3 merged 310 duplicates"],
      ["notice", "Batch 2 timed out after 30 s (attempt 3 of 3)"],
    ],
  },
  {
    key: "furnace",
    by: "momentumchief",
    item: "furnace",
    title: "Book the furnace service visit",
    state: "failed",
    summary: "Book the furnace service visit",
    startedMin: 4 * D + 15 * H,
    finishedMin: 4 * D + 14 * H,
    events: [["notice", "The booking form rejected the address twice"]],
  },
  {
    key: "backups",
    by: COORDINATOR,
    item: "backups",
    title: "Nightly backup verification",
    state: "failed",
    summary: "rsync exited 23",
    startedMin: 5 * D + 1 * H,
    finishedMin: 5 * D + 50,
    events: [
      ["progress", "Restored last night's archive to the scratch volume"],
      ["notice", "Checksum mismatch on 3 files"],
    ],
  },
  {
    key: "printer",
    by: COORDINATOR,
    item: "printer",
    title: "Vendor quotes for the printed issue",
    delegationId: "deleg_demo_b",
    state: "done",
    summary: "Two of three printers quoted. Lakeside Print is cheapest at $0.84 a copy for 500; the third vendor's portal timed out and was not retried.",
    children: [
      { title: "Quote from Lakeside Print", state: "done", summary: "$0.84 a copy for 500, five working days." },
      { title: "Quote from Birchline Press", state: "failed", summary: "Vendor portal timed out." },
    ],
    startedMin: 22 * H,
    finishedMin: 20 * H + 10,
    events: [["notice", "2 sub-agents finished (1 failed)"]],
  },
  {
    key: "flags",
    by: "devchief",
    item: "checkout",
    title: "Rename feature flags to plain-English names",
    state: "done",
    summary: "Rename feature flags to plain-English names",
    prUrl: "https://github.com/example/storefront/pull/214",
    pipeline: [
      { stage: "build", state: "ok" },
      { stage: "ci", state: "ok" },
      { stage: "review", state: "ok" },
      { stage: "merge", state: "ok" },
    ],
    startedMin: 8 * H,
    finishedMin: 6 * H + 20,
    events: [
      ["ci", "All 148 checks passed"],
      ["progress", "Renamed 3 flags in 11 files"],
    ],
  },
  {
    key: "desk",
    by: "momentumchief",
    item: "desk",
    title: "Compare standing desk frames",
    state: "waiting",
    summary: "Waiting on your budget ceiling.",
    startedMin: 5 * H,
    updatedMin: 2 * H + 15,
    events: [["progress", "Shortlisted 4 frames between $260 and $410"]],
  },
];

// --- content: chat -------------------------------------------------------------------------------

/** Builds one transcript in the Hermes message shape. `minAgo` is when the reply landed; tools run just before it. */
function transcript(key) {
  const messages = [];
  let calls = 0;
  const api = {
    messages,
    user(minAgo, text) {
      messages.push({ role: "user", content: text, timestamp: unix(minAgo) });
      return api;
    },
    say(minAgo, text, tools = []) {
      if (tools.length) {
        const toolCalls = tools.map((t) => ({
          id: `call_${key}_${++calls}`,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
        }));
        messages.push({ role: "assistant", content: "", tool_calls: toolCalls, finish_reason: "tool_calls", timestamp: unix(minAgo + 0.6) });
        tools.forEach((t, i) =>
          messages.push({
            role: "tool",
            content: typeof t.result === "string" ? t.result : JSON.stringify(t.result ?? {}),
            tool_call_id: toolCalls[i].id,
            tool_name: t.name,
            timestamp: unix(minAgo + 0.5 - i * 0.04),
          }),
        );
      }
      messages.push({ role: "assistant", content: text, finish_reason: "stop", timestamp: unix(minAgo) });
      return api;
    },
  };
  return api;
}

const DICTATED =
  "ok so I was looking at the todo list and honestly it's a mess, there's like three different things about the storefront in there and I can't tell which ones are still real, " +
  "and then the newsletter stuff is mixed in with the house stuff. can you go through the storefront ones and the newsletter ones, make items for whatever is actually still open, " +
  "figure out if the holiday sale checklist is a thing we still need or if I already did that last year, and then just tell me what you need from me. " +
  "don't ask me about every little thing, batch it up, and if something is obviously stale just leave it alone";

/**
 * The Chief of staff thread. Oldest first; the panel shows the latest few messages, so the shapes worth
 * looking at come last: a dictated request with the "[Viewing: …]" prefix, a reply with Actions chips,
 * a machine-written decision message, replies that name D-n / R-n, background notices, live sub-agents.
 */
function coordinatorSession(x) {
  const jarvis = (tool) => `mcp__jarvis__${tool}`;
  const AUDIT = "Audit preview deployments for live traffic";
  const INVENTORY = "Reconcile the storefront inventory export";
  const t = transcript("cos");
  t.user(26 * H, "what's going on with the checkout refactor, is that done or not");
  t.say(
    26 * H - 2,
    `Not quite. ${x.r.smoke} (the post-merge smoke tests) is with devchief and has one flaky coupon test, and ${x.r.dedupe} failed four days ago on an unrelated import. devchief raised ${x.d.checkout} asking whether to settle the item anyway; I would wait for one green nightly before saying yes.`,
  );
  t.user(
    20 * H + 12,
    [
      "[ASYNC DELEGATION BATCH COMPLETE — deleg_demo_b]",
      "A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished; its consolidated results are below.",
      "",
      "Role: leaf   Model: gpt-6.1-sol   Total duration: 412.0s",
      "",
      "--- ✓ TASK 1/2: Quote from Lakeside Print  (status=completed, api_calls=9, 201.4s) ---",
      "$0.84 a copy for 500, five working days.",
      "Full live transcript (complete tool/assistant trace): /opt/data/transcripts/deleg_demo_b-task1.jsonl",
      "",
      "--- ✗ TASK 2/2: Quote from Birchline Press  (status=failed, api_calls=3, 40.0s) ---",
      "(no summary — status=failed: vendor portal timed out)",
      "Full live transcript (complete tool/assistant trace): /opt/data/transcripts/deleg_demo_b-task2.jsonl",
    ].join("\n"),
  );
  t.user(3 * H + 2, "can you chase the inventory export thing and the old preview deployments in parallel, I don't want to think about either of them today");
  t.say(
    3 * H,
    `Started two sub-agents. ${x.r.inventory} reconciles the storefront inventory export and ${x.r.audit} checks which old preview deployments still get traffic. Both report back here, and I will only interrupt you if one of them needs a decision.`,
    [
      {
        name: jarvis("jarvis_run_start"),
        args: { itemId: x.ids.inventory, title: INVENTORY, delegationId: "deleg_demo_a:sa-demo-inventory" },
        result: { runId: x.runIds.inventory, ref: x.r.inventory },
      },
      {
        name: jarvis("jarvis_run_start"),
        args: { itemId: x.ids.previews, title: AUDIT, delegationId: "deleg_demo_a:sa-demo-previews" },
        result: { runId: x.runIds.audit, ref: x.r.audit },
      },
      {
        name: "delegate_task",
        args: { tasks: [{ goal: INVENTORY }, { goal: AUDIT }], background: true },
        result: {
          status: "dispatched",
          delegation_id: "deleg_demo_a",
          subagent_ids: ["sa-demo-inventory", "sa-demo-previews"],
          goals: [INVENTORY, AUDIT],
          live_transcripts: ["/opt/data/transcripts/deleg_demo_a-task1.jsonl", "/opt/data/transcripts/deleg_demo_a-task2.jsonl"],
        },
      },
    ],
  );
  t.user(
    70,
    "[IMPORTANT: Background process proc_demo_1 completed (exit code 0).\nCommand: npm run inventory:export -- --dry-run\nOutput:\nwrote inventory-diff.csv (14 rows)]",
  );
  t.user(55, `[Viewing: Todos — /todos]\n${DICTATED}`);
  t.say(
    50,
    `I went through the storefront and newsletter todos. Two were still real and had no item, so I created **${x.holiday.title}** and **${x.sponsorList.title}**; three others duplicate work that is already tracked, and I left those alone. Two calls are waiting on you in Needs you: ${x.d.sendkey} (the newsletter sending key) and ${x.d.hosting} (the hosting renewal). I also raised ${x.d.syncfix} for the recipe box sync fix; it ships tonight unless you say otherwise.`,
    [
      {
        name: jarvis("jarvis_search"),
        args: { q: "storefront" },
        result: { hits: [{ id: x.ids.checkout, title: "Checkout refactor", path: "Portfolio / Storefront" }] },
      },
      {
        name: jarvis("jarvis_create_item"),
        args: { parentId: x.ids.storefront, title: x.holiday.title, kind: "thread" },
        result: { item: { id: x.holiday.id, kind: "thread", title: x.holiday.title, status: "captured" }, undoOpId: x.holiday.undoOpId },
      },
      {
        name: jarvis("jarvis_create_item"),
        args: { parentId: x.ids.newsletter, title: x.sponsorList.title, kind: "thread" },
        result: { item: { id: x.sponsorList.id, kind: "thread", title: x.sponsorList.title, status: "captured" }, undoOpId: x.sponsorList.undoOpId },
      },
      {
        name: jarvis("jarvis_raise_decision"),
        args: { itemId: x.ids.syncfix, question: "Ship the recipe box sync fix tonight?" },
        result: { ref: x.d.syncfix, state: "open", item: { id: x.ids.syncfix, title: "Recipe box sync fix" } },
      },
    ],
  );
  t.user(31, 'Decision on "Feature names": Decision: Use plain names? Recommendation: keep plain-English names. → Keep plain-English names (recommended)');
  t.say(
    30,
    `Recorded. devchief already renamed the three feature flags in ${x.r.flags}, and I updated the Storefront project so the sale checklist uses the plain-English names. Nothing else was waiting on that answer.`,
    [
      {
        name: jarvis("jarvis_update_item"),
        args: { id: x.ids.storefront, nextAction: "Use the plain-English flag names in the sale checklist" },
        result: { item: { id: x.ids.storefront, kind: "project", title: "Storefront", status: "captured" }, undoOpId: x.storefrontOp },
      },
    ],
  );
  t.user(13, "ok. which runs have gone quiet, and did the furnace guy ever get scheduled");
  t.say(
    12,
    `Three runs have not reported for over half an hour: ${x.r.smoke} (checkout smoke tests), ${x.r.lumber} (lumber pricing) and ${x.r.questions} (reader questions). I have not restarted any of them. The furnace visit is still waiting on you in ${x.d.furnace}; the booking run ${x.r.furnace} failed last week when the form rejected the address, so nothing is booked.`,
  );
  const children = [
    {
      id: SID.subInventory,
      title: `Subagent: ${INVENTORY}`,
      source: "subagent",
      parent_session_id: SID.cos,
      started_at: unix(3 * H + 0.3),
      messages: transcript("subinv")
        .user(3 * H + 0.3, "Reconcile the storefront inventory export against the catalogue and list every row that differs.")
        .say(6, "14 of 1,204 rows differ so far: 9 stock counts, 5 prices. Writing them to `inventory-diff.csv`; about a third of the catalogue is left.", [
          { name: "terminal", args: { command: "npm run inventory:export -- --dry-run" }, result: "wrote inventory-diff.csv (14 rows)" },
        ]).messages,
    },
    {
      id: SID.subPreviews,
      title: `Subagent: ${AUDIT}`,
      source: "subagent",
      parent_session_id: SID.cos,
      started_at: unix(3 * H + 0.2),
      messages: transcript("subprev")
        .user(3 * H + 0.2, "List the preview deployments older than 30 days and find out which of them still receive requests, and from where.")
        .say(11, "35 of the 41 old previews are idle. The other six still get visits, all from links in one old newsletter issue.").messages,
    },
  ];
  return [{ id: SID.cos, title: "Portfolio coordinator", source: "api_server", started_at: unix(26 * H + 1), messages: t.messages }, ...children];
}

const EVAL_REVIEW = () =>
  [
    "## Weekly eval review",
    "",
    `**Window:** ${day(-7)} to ${day(0)} · 3 nightly runs were skipped (the runner was offline on Tuesday)`,
    "",
    "### What moved",
    "",
    "- **Accuracy:** 81.4% → 79.9% on the `core-200` set",
    "  - Inside the ±1.8 noise band measured last month",
    "  - The drop sits almost entirely in `category=substitutions` (12 of the 14 new misses)",
    "- **Latency:** p95 went from 2.1 s to 1.6 s after the cache change",
    "  - `EVAL_CACHE=1` is now the default in `eval.config.ts`",
    "- **Cost per run:** $0.42 → $0.37",
    "",
    "### What broke",
    "",
    "- The `long-context` suite has not loaded since Thursday",
    "  - `FileNotFoundError: fixtures/long_context_v3.jsonl`",
    "  - The fixture was renamed in `a41c9e2`; the loader still points at `v2`",
    "- Two graders disagree on 9 items",
    "  - Mostly unit conversions (`tbsp` against `ml`)",
    "",
    "### What I did",
    "",
    `1. Re-ran the three skipped nights with \`npm run eval -- --since ${day(-3)}\``,
    "2. Opened a draft fix for the fixture path",
    "3. Tagged the 9 disputed items `needs-second-grader`",
    "",
    "| Suite | Last week | This week |",
    "| --- | --- | --- |",
    "| core-200 | 81.4% | 79.9% |",
    "| substitutions | 77.0% | 71.0% |",
    "| long-context | 68.2% | not run |",
    "",
    "### Decisions needed",
    "",
    "1. **Record 79.9% as the new baseline?** I recommend yes: it is within noise.",
    "2. **Rerun with three seeds before recording it?** About 40 minutes of compute tonight.",
    "3. **Drop `long-context` from the nightly until the fixture is fixed?** Otherwise every night shows red.",
    "",
    "> None of this is urgent. If you only answer one, make it the first.",
  ].join("\n");

/** The /chat list: long human titles, cron deliveries, one long markdown answer, one with tool steps. */
function chatSessions() {
  const s = (id, title, startedMin, build, source = "api_server") => ({
    id: `${SESSION_PREFIX}${id}`,
    title,
    source,
    started_at: unix(startedMin),
    messages: build(transcript(id)).messages,
  });
  return [
    s("weekly_eval_review", "Weekly eval review", 27 * H, (t) =>
      t
        .user(26 * H + 40, "Give me the weekly eval review. What moved, what broke, and what do you need from me?")
        .say(26 * H + 34, EVAL_REVIEW(), [
          { name: "read_file", args: { path: "evals/results/nightly-summary.json" }, result: '{"runs":4,"skipped":3,"accuracy":0.799}' },
          { name: "terminal", args: { command: `npm run eval -- --since ${day(-3)}` }, result: "3 runs completed in 14m 02s" },
        ])
        .user(25 * H + 10, "do 1, skip 2. what about the substitutions drop, is that the prompt change?")
        .say(
          25 * H + 8,
          "Recorded 79.9% as the baseline. The substitutions drop does line up with the prompt change: 10 of the 12 new misses are cases where the new wording tells the model to refuse a swap it used to allow. I can draft a one-line softening of that rule and run it against `substitutions` only, which takes about six minutes.",
        ),
    ),
    s("garage_shelving", "Plan the garage shelving build and figure out what lumber to order before Saturday", 3 * H + 30, (t) =>
      t
        .user(
          3 * H + 28,
          "I want two bays of shelving on the north wall of the garage, 8 ft wide each, four shelves, deep enough for the big storage totes. What do I need to buy?",
        )
        .say(
          3 * H + 26,
          "For two 8 ft bays with four shelves at 24 in deep you need 24 studs (2x4, 8 ft) and 4 sheets of 3/4 in plywood, plus a box of 3 in structural screws. That leaves two spare studs for mistakes. If the totes are the 27 gallon kind, 24 in deep fits them with the lid on.",
        )
        .user(3 * H + 12, "and can the yard cut the plywood for me or do I need to borrow a saw")
        .say(
          3 * H + 10,
          "Most yards will rip sheets lengthwise for free or a small fee. Ask for each sheet ripped into two 24 in strips and you will not need a saw for the shelves at all.",
        ),
    ),
    s(
      "compass_morning",
      "Daily Compass Morning check-in",
      5 * H + 2,
      (t) =>
        t
          .user(5 * H + 2, "Scheduled run: Daily Compass morning check-in. Summarise today's commitments and anything carried over from yesterday.")
          .say(
            5 * H,
            "Morning check-in: three commitments today (ship the sync fix, call the furnace company, finish the sponsor list). One item carried over from yesterday: the lumber order. You have not checked in yet.",
          ),
      "cron",
    ),
    s(
      "cron_system_health",
      "[Cron delivery: Nightly system health]",
      9 * H + 1,
      (t) =>
        t
          .user(9 * H + 1, "Scheduled run: nightly system health. Report only what changed.")
          .say(
            9 * H,
            "Nightly system health: all 6 services up. Disk on the backup volume is at 81% (was 78%). The backup verification job has failed 2 nights in a row with `rsync exited 23`.",
            [{ name: "terminal", args: { command: "df -h /mnt/backup" }, result: "/dev/sdb1  200G  162G  38G  81% /mnt/backup" }],
          ),
      "cron",
    ),
    s("standing_desk", "Compare standing desk frames under four hundred dollars for the upstairs office nook", 26 * H, (t) =>
      t
        .user(26 * H, "The nook is 48 inches wide. I want a standing desk frame under $400 that takes a top I already have (46 x 24).")
        .say(
          25 * H + 57,
          "Four frames fit a 46 in top and stay under $400. The two worth a look are a dual-motor frame at $369 (quiet, 265 lb rating) and a single-motor one at $279 that wobbles a little at full height. Both adjust down to 42 in wide, so they fit the nook with room to spare.",
          [{ name: "web_search", args: { query: "standing desk frame 42 to 48 inch dual motor under $400" }, result: "4 results" }],
        ),
    ),
    s("checkout_coupon_bug", "Storefront checkout bug: coupon field rejects codes that contain a dash", 30 * H, (t) =>
      t
        .user(30 * H, "A customer says WINTER-10 doesn't work at checkout but WINTER10 does. Can you find out why?")
        .say(
          29 * H + 55,
          "The coupon input strips everything that is not a letter or digit before it looks the code up, so `WINTER-10` becomes `WINTER10` only when that exact code exists. The fix is to normalise both sides the same way. It is a two-line change in `coupon.ts`.",
          [{ name: "read_file", args: { path: "src/checkout/coupon.ts" }, result: 'const clean = code.replace(/[^a-z0-9]/gi, "");' }],
        ),
    ),
    s(
      "cron_portfolio_digest",
      "[Cron delivery: Weekly portfolio digest]",
      2 * D + 1,
      (t) =>
        t
          .user(2 * D + 1, "Scheduled run: weekly portfolio digest.")
          .say(
            2 * D,
            "Weekly digest: storefront orders up 6% week on week, newsletter open rate steady at 47%, two preview deployments older than 60 days. Nothing needs you this week.",
          ),
      "cron",
    ),
    s("landlord_dishwasher", "Draft a reply to the landlord about the dishwasher replacement timeline and access", 2 * D + 5 * H, (t) =>
      t
        .user(
          2 * D + 5 * H,
          "The landlord wants to replace the dishwasher next week and asked which days work. Tuesday and Thursday mornings are fine. Keep it short and friendly.",
        )
        .say(
          2 * D + 5 * H - 2,
          "Here is a draft:\n\n> Hi, thanks for sorting out the dishwasher. Tuesday or Thursday morning next week both work for us, any time after 8. Someone will be home to let the installer in. Let us know which day you pick.\n\nWant it more formal, or with a line about the old unit being hauled away?",
        ),
    ),
    s("trailhead_november", "Trailhead newsletter: outline the November issue and pick three reader questions", 3 * D + 2 * H, (t) =>
      t
        .user(3 * D + 2 * H, "Outline the November issue. Theme is shoulder-season hikes. Pick three reader questions from the replies folder.")
        .say(
          3 * D + 2 * H - 4,
          "Outline:\n\n1. Lead: three shoulder-season loops under five miles\n2. Gear note: traction for icy mornings\n3. Reader questions (3)\n4. One photo, one map\n\nThe three questions I would run: layering for 35 degree starts, whether trail runners are enough in November, and how to read a closure notice.",
        ),
    ),
    s("preview_cleanup", "Clean up stale preview deployments", 50, (t) =>
      t
        .user(48, "How many preview deployments are older than 30 days, and which of them still get traffic?")
        .say(
          45,
          "41 previews are older than 30 days. 35 have had no requests in the last two weeks; 6 still get traffic, all from links in an old newsletter issue. I have not deleted anything.",
          [
            { name: "terminal", args: { command: "deploy previews list --older-than 30d --json" }, result: '{"count":41,"oldest":"pr-118"}' },
            { name: "read_file", args: { path: "logs/preview-traffic.csv" }, result: "preview,requests_14d\npr-118,0\npr-131,212\npr-140,0" },
            { name: "web_search", args: { query: "hosting provider preview deployment retention" }, result: "Previews are kept until deleted." },
          ],
        ),
    ),
    s("recipe_import_dupes", "Recipe box import keeps duplicating entries after the second sync run", 4 * D + 3 * H, (t) =>
      t
        .user(4 * D + 3 * H, "Every time the import runs twice I get doubles of the same recipes. First run is fine. What changed?")
        .say(
          4 * D + 3 * H - 3,
          "The source site changed its ids from numbers to slugs last week, so the second sync no longer recognises rows the first one imported. Matching on `sourceId ?? id` fixes new imports; the existing doubles need a one-off dedupe.",
        ),
    ),
    s("sourdough", "Quick sourdough hydration question", 6 * D, (t) =>
      t
        .user(6 * D, "500 g flour, I want 72% hydration. How much water?")
        .say(6 * D - 1, "360 g of water. If your starter is 100% hydration and you use 100 g of it, count 50 g of that as water and add 310 g."),
    ),
    { id: SID.home, title: "Home coordinator", source: "api_server", started_at: unix(2 * D), last_active: unix(2 * D), messages: [] },
  ];
}

/** The live turn on the tool-steps chat: the mock runs a web search, then stops on a pending approval. */
const APPROVAL_INPUT = "Search the traffic log for the 35 idle previews, then delete them. Keep the 6 that still get visits.";

// --- seeding -------------------------------------------------------------------------------------

async function ensureRoute() {
  const view = (await app("GET", "/api/settings/agents")).data;
  if (!view.hermesConfigured) throw new Error("Hermes is not connected in this Jarvis (finish onboarding with the demo values first)");
  const others = view.settings.routes.filter((r) => r.profile !== COORDINATOR);
  // The mock only serves /p/momentumchief and /p/devchief, so the coordinator profile is routed to the default
  // store (same origin, shared key). First ask Jarvis what its Hermes base URL is, then point the route at it.
  const probe = (await app("PUT", "/api/settings/agents", { routing: true, routes: [...others, { profile: COORDINATOR, keyEnv: null, baseUrl: null }] })).data;
  const base = probe.routes.find((r) => r.profile === COORDINATOR).effectiveBaseUrl.replace(new RegExp(`/p/${COORDINATOR}$`), "");
  if (base !== HERMES) warn(`Jarvis talks to Hermes at ${base}, but JARVIS_MOCK_URL points at ${HERMES}: chat seeding may land in the wrong place`);
  const saved = (await app("PUT", "/api/settings/agents", { routing: true, routes: [...others, { profile: COORDINATOR, keyEnv: null, baseUrl: base }] })).data;
  if (!saved.routes.find((r) => r.profile === COORDINATOR)?.keyPresent)
    throw new Error("The chiefofstaff route has no usable key (expected the shared mock key)");
}

async function removeRoute() {
  const view = (await app("GET", "/api/settings/agents")).data;
  const routes = view.settings.routes.filter((r) => r.profile !== COORDINATOR);
  if (routes.length !== view.settings.routes.length)
    await app("PUT", "/api/settings/agents", { routing: routes.length ? view.settings.routing : false, routes });
}

async function seedTree() {
  const ids = {};
  for (const a of AREAS) {
    const area = await aged(
      40 * D,
      (o) => o.id,
      async () => (await app("POST", "/api/work/items", { kind: "area", title: a.title, summary: a.summary })).data.item,
    );
    ids[a.key] = area.id;
    if (a.agentMode) await aged(40 * D, area.id, () => app("PATCH", `/api/work/items/${area.id}`, { settings: { agentMode: a.agentMode } }));
    for (const p of a.projects) {
      const project = await aged(
        38 * D,
        (o) => o.id,
        async () => (await app("POST", "/api/work/items", { kind: "project", parentId: area.id, title: p.title, summary: p.summary })).data.item,
      );
      ids[p.key] = project.id;
    }
  }
  for (const it of ITEMS) {
    const age = (it.ask?.ageMin ?? 12 * D) + 25;
    const item = await aged(
      age,
      (o) => o.id,
      async () =>
        (await app("POST", "/api/work/items", { kind: "thread", parentId: ids[it.parent], title: it.title, ...(it.summary ? { summary: it.summary } : {}) }))
          .data.item,
    );
    ids[it.key] = item.id;
  }
  return ids;
}

async function seedTokens() {
  for (const profile of PROFILES) {
    const minted = (
      await app("POST", "/api/settings/agents/tokens", {
        name: `${TOKEN_PREFIX} · ${profile}`,
        profile,
        scopes: ["work.read", "work.write", "decisions.write", "runs.write"],
      })
    ).data;
    tokens[profile] = minted.token;
  }
}

async function seedDecisions(ids) {
  const refs = {};
  const raise = async (profile, key, ageMin, args) => {
    if (args.question.length > 500) throw new Error(`Decision question for ${key} is ${args.question.length} chars (max 500)`);
    const out = await mcp(profile, "jarvis_raise_decision", { itemId: ids[key], ...args });
    decisionAges.push({ id: out.decisionId, ref: out.ref, itemId: ids[key], ageMin });
    refs[key] = out.ref;
  };
  // Oldest first, so the lowest D-n are the oldest (as in a real account).
  const old = ITEMS.filter((i) => i.ask).sort((a, b) => b.ask.ageMin - a.ask.ageMin);
  for (const it of old)
    await raise(it.ask.by ?? COORDINATOR, it.key, it.ask.ageMin, {
      question: it.ask.question ?? it.title,
      ...(it.ask.choices ? { choices: it.ask.choices } : {}),
    });
  const rest = [...PACKED.map((d) => ({ ...d, by: COORDINATOR })), ...LONG.map((d) => ({ ...d, by: "devchief", choices: ["Do it", "Not now"] }))].sort(
    (a, b) => b.ageMin - a.ageMin,
  );
  for (const { key, by, ageMin, ...args } of rest) await raise(by, key, ageMin, args);
  return refs;
}

async function seedRuns(ids) {
  const refs = {};
  const runIds = {};
  for (const run of RUNS) {
    const itemId = typeof run.item === "function" ? run.item(ids) : ids[run.item];
    const started = await mcp(run.by, "jarvis_run_start", { itemId, title: run.title, delegationId: run.delegationId ?? `demo-seed:${run.key}` });
    for (const [type, summary] of run.events) await mcp(run.by, "jarvis_run_event", { runId: started.ref, type, summary });
    await mcp(run.by, "jarvis_run_update", {
      runId: started.ref,
      state: run.state,
      summary: run.summary,
      ...(run.pipeline ? { pipeline: run.pipeline } : {}),
      ...(run.prUrl ? { prUrl: run.prUrl } : {}),
      ...(run.children ? { children: run.children } : {}),
    });
    refs[run.key] = started.ref;
    runIds[run.key] = started.runId;
    runTimes.push({ id: started.runId, itemId, title: run.title, startedMin: run.startedMin, updatedMin: run.updatedMin, finishedMin: run.finishedMin });
  }
  return { refs, runIds };
}

/** What the Chief of staff did in the last hour (in order): Changes rows, several in a row about one item. */
async function seedChanges(ids) {
  const cos = (name, args) => mcp(COORDINATOR, name, args);
  const holiday = await aged(
    53,
    (o) => o.item.id,
    () =>
      cos("jarvis_create_item", {
        parentId: ids.storefront,
        title: "Holiday sale checklist",
        kind: "thread",
        summary: "Everything that has to be true before the winter sale goes live.",
      }),
  );
  const sponsorList = await aged(
    52,
    (o) => o.item.id,
    () =>
      cos("jarvis_create_item", {
        parentId: ids.newsletter,
        title: "Sponsor outreach list",
        kind: "thread",
        summary: "Companies that fit a hiking audience, ranked.",
      }),
  );
  ids.sponsorList = sponsorList.item.id;
  await aged(46, holiday.item.id, () => cos("jarvis_update_item", { id: holiday.item.id, nextAction: "Confirm the sale dates with the theme switch" }));
  await aged(45, holiday.item.id, () =>
    cos("jarvis_update_item", { id: holiday.item.id, status: "exploring", reason: "Last year's checklist exists but predates the new checkout" }),
  );
  await aged(44, holiday.item.id, () => cos("jarvis_update_item", { id: holiday.item.id, tags: ["sale", "q4"], targetDate: day(12) }));
  await aged(
    41,
    (o) => o.item.id,
    () =>
      cos("jarvis_add_note", {
        itemId: holiday.item.id,
        title: "What changed since last year",
        body: "New checkout flow, coupon codes with dashes, winter theme.",
      }),
  );
  const storefront = await aged(30, ids.storefront, () =>
    cos("jarvis_update_item", { id: ids.storefront, nextAction: "Use the plain-English flag names in the sale checklist" }),
  );
  await aged(22, sponsorList.item.id, () =>
    cos("jarvis_update_item", { id: sponsorList.item.id, summary: "Nine drafted, ranked by audience fit. Two more need a contact address." }),
  );
  await aged(21, sponsorList.item.id, () =>
    cos("jarvis_link", { itemId: sponsorList.item.id, url: "https://docs.example.com/trailhead/sponsor-shortlist", title: "Sponsor shortlist (draft)" }),
  );
  return {
    holiday: { id: holiday.item.id, title: "Holiday sale checklist", undoOpId: holiday.undoOpId },
    sponsorList: { id: sponsorList.item.id, title: "Sponsor outreach list", undoOpId: sponsorList.undoOpId },
    storefrontOp: storefront.undoOpId,
  };
}

/** Put the sessions into the mock Hermes. Returns "exact" (seeding hook) or "runs" (older mock: canned replies). */
async function seedSessions(sessions) {
  const hook = await hermes("POST", "/__mock/seed", { sessions }, { tolerate: true });
  if (hook.ok) return "exact";
  if (hook.status !== 404) throw new Error(`mock hermes /__mock/seed -> ${hook.status}`);
  for (const s of sessions) {
    if (s.parent_session_id) continue; // the public API cannot create child sessions
    await hermes("DELETE", `/api/sessions/${encodeURIComponent(s.id)}`, undefined, { tolerate: true });
    await hermes("POST", "/api/sessions", { id: s.id, title: s.title, source: s.source });
    for (const m of s.messages.filter((x) => x.role === "user")) {
      const run = (await hermes("POST", "/v1/runs?speed=1", { input: m.content, session_id: s.id })).data;
      let done = false;
      for (let i = 0; i < 40 && !done; i++) {
        await sleep(50);
        done = ["completed", "failed", "cancelled", "interrupted"].includes((await hermes("GET", `/v1/runs/${run.run_id}`)).data.status);
      }
      // A message that trips one of the mock's scripted keywords (approval, clarify) would wait forever.
      if (!done) await hermes("POST", `/v1/runs/${run.run_id}/stop`, {}, { tolerate: true });
    }
  }
  return "runs";
}

async function seedChat(ids, x) {
  const mode = await seedSessions([...coordinatorSession(x), ...chatSessions()]);
  if (mode === "runs")
    warn(
      "the running mock Hermes has no /__mock/seed hook (it was started before mock-upstreams/hermes.mjs gained it). Chats were seeded through real runs: " +
        "your messages are exact, but replies are the mock's canned text and there are no tool calls, Actions chips or live sub-agents. Restart the mock and re-run for exact transcripts.",
    );
  // The coordinator thread: track it on the chiefofstaff profile (as an adopted chat), then file it under the area.
  await app("POST", "/api/hermes/sessions/adopt", { profile: COORDINATOR, sessionId: SID.cos });
  await app("POST", "/api/work/conversations/file", { sessionId: SID.cos, itemId: ids.portfolio });
  await app("POST", "/api/work/conversations/file", { sessionId: SID.home, itemId: ids.home });
  // One live turn through Jarvis itself, so the chat has an active run paused on an approval.
  const run = (await app("POST", `/api/hermes/sessions/${SID.previews}/runs`, { input: APPROVAL_INPUT, idempotencyKey: `demoseed-${Date.now().toString(36)}` }))
    .data;
  let status = run.status;
  for (let i = 0; i < 30 && status !== "waiting_for_approval"; i++) {
    await sleep(300);
    status = (await app("GET", `/api/hermes/runs/${encodeURIComponent(run.runId)}`, undefined, { tolerate: true })).data?.status ?? status;
  }
  if (status !== "waiting_for_approval") warn(`the approval turn is "${status}", not waiting_for_approval`);
  return mode;
}

async function seedReadState(uid) {
  // Everything unread: move the "mark all read" baseline back before the oldest seeded chat, then read two.
  if (db) db.prepare("UPDATE conversation_reads SET read_at = ? WHERE user_id = ? AND session_id = '*'").run(iso(45 * D), uid);
  for (const id of [`${SESSION_PREFIX}sourdough`, `${SESSION_PREFIX}cron_portfolio_digest`])
    await app("POST", "/api/work/conversations/read", { sessionId: id, messageCount: 2 });
  // Last looks: the chat divider reads "Since … · 2 h", Needs you / Running were last opened a while ago.
  await app("POST", "/api/coordinator/looked", { surface: "chat", at: iso(2 * H + 35) });
  await app("POST", "/api/coordinator/looked", { surface: "needs", at: iso(26 * H) });
  await app("POST", "/api/coordinator/looked", { surface: "running", at: iso(5 * H) });
}

// --- verification (through the same GET APIs the UI uses) ----------------------------------------

async function verify(mode) {
  const problems = [];
  const expect = (ok, text) => (ok ? null : problems.push(text));
  const co = (await app("GET", "/api/work/coordinator/global")).data;
  expect(
    co.area?.title === "Portfolio" && co.agent?.profile === COORDINATOR && co.sessionId === SID.cos,
    `coordinator: ${JSON.stringify({ area: co.area, agent: co.agent, sessionId: co.sessionId })}`,
  );
  const decisions = (await app("GET", "/api/coordinator/decisions")).data;
  const now = Date.now();
  const ageing = decisions.decisions.filter((d) => now - Date.parse(d.createdAt) > 2 * 86_400_000);
  const packed = decisions.decisions.filter((d) => d.pack?.options?.length && d.pack?.evidence?.length);
  const long = decisions.decisions.filter((d) => d.question.length > 250);
  expect(decisions.counts.open === ITEMS.filter((i) => i.ask).length + PACKED.length + LONG.length, `open decisions: ${decisions.counts.open}`);
  if (db) expect(ageing.length >= 13, `decisions 2+ days old: ${ageing.length}`);
  const runs = (await app("GET", "/api/coordinator/runs")).data;
  const by = (f) => runs.runs.filter(f);
  const stalled = by((r) => r.stalled);
  const failed = by((r) => r.state === "failed");
  expect(runs.runs.length === RUNS.length, `runs: ${runs.runs.length}`);
  if (db)
    expect(
      stalled.length === 3 && by((r) => r.state === "running" && !r.stalled).length === 2,
      `running/stalled: ${by((r) => r.state === "running").length}/${stalled.length}`,
    );
  const changes = (await app("GET", `/api/work/activity?actor=agent&q=${COORDINATOR}&limit=200`)).data.items.filter(
    (a) => (a.via ? a.via === COORDINATOR || a.via === `agent:${COORDINATOR}` : a.actor?.name === COORDINATOR) && Date.parse(a.at) >= now - 86_400_000,
  );
  // Conversation lists come from a persisted index: ask for a refresh and wait for it.
  let list = (await app("GET", "/api/work/conversations?view=all&refresh=1")).data;
  for (let i = 0; i < 20 && (list.updating || list.conversations.filter((c) => c.id.startsWith(SESSION_PREFIX)).length < 14); i++) {
    await sleep(500);
    list = (await app("GET", "/api/work/conversations?view=all")).data;
  }
  const mine = list.conversations.filter((c) => c.id.startsWith(SESSION_PREFIX));
  expect(mine.length >= 14, `seeded conversations listed: ${mine.length}`);
  const detail = (await app("GET", `/api/hermes/sessions/${SID.cos}`)).data;
  const exec = (await app("GET", `/api/hermes/sessions/${SID.cos}/execution`)).data;
  const evals = (await app("GET", `/api/hermes/sessions/${SID.evals}`)).data;
  const previews = (await app("GET", `/api/hermes/sessions/${SID.previews}`)).data;
  expect(detail.timeline.filter((t) => t.kind === "user").length >= 5, "coordinator thread has too few messages");
  expect(previews.session.activeRun?.status === "waiting_for_approval", `preview chat run: ${previews.session.activeRun?.status ?? "none"}`);
  if (mode === "exact") {
    expect(
      evals.timeline.some((t) => t.kind === "assistant" && t.text.includes("### Decisions needed")),
      "Weekly eval review has no markdown answer",
    );
    expect(
      exec.records.filter((r) => r.source === "subagent" && r.state === "running" && r.subagentId).length === 2,
      "coordinator thread has no live sub-agents",
    );
  }
  const count = (kind) => detail.timeline.filter((t) => t.kind === kind).length;
  log("");
  log("seeded state (read back through the app's GET APIs)");
  log(`  coordinator      area "${co.area?.title}", profile ${co.agent?.profile} (${co.agent?.reason}), session ${co.sessionId}`);
  log(
    `  decisions        ${decisions.counts.open} open: ${ageing.length} are 2+ days old, ${long.length} long agent-written (devchief), ${packed.length} well-formed`,
  );
  log(
    `                   risk-flagged: ${decisions.decisions
      .filter((d) => d.risk.length)
      .map((d) => `${d.ref} ${d.risk.join("+")}`)
      .join(", ")}`,
  );
  log(
    `  runs             ${runs.runs.length}: ${by((r) => r.state === "running" && !r.stalled).length} running, ${stalled.length} stalled, ${failed.length} failed, ${by((r) => r.state === "done").length} done, ${by((r) => r.state === "waiting").length} waiting`,
  );
  log(
    `                   summary = title on ${by((r) => r.summary === r.title).length}; ${runs.events.length} run events; profiles ${[...new Set(runs.runs.map((r) => r.profile))].join(", ")}`,
  );
  log(`                   failed ages (days): ${failed.map((r) => ((now - Date.parse(r.updatedAt)) / 86_400_000).toFixed(1)).join(", ")}`);
  log(
    `  coordinator chat ${count("user")} user / ${count("assistant")} assistant / ${count("tool")} tool messages; ${exec.records.length} execution records (${exec.records.filter((r) => r.state === "running").length} running)`,
  );
  log(`  changes          ${changes.length} rows by @${COORDINATOR} in the last 24 h`);
  log(
    `  chat list        ${list.conversations.length} conversations (${mine.length} seeded): ${list.unreadCount} unread, ${list.unfiledCount} unfiled, ${list.conversations.filter((c) => c.suggestions?.length).length} with filing suggestions`,
  );
  log(`  tool-steps chat  ${previews.timeline.filter((t) => t.kind === "tool").length} tool steps, active run ${previews.session.activeRun?.status ?? "none"}`);
  log(`  chat transcripts ${mode === "exact" ? "exact (mock seeding hook)" : "DEGRADED: canned replies (mock has no seeding hook)"}`);
  if (problems.length) {
    for (const p of problems) warn(`check failed: ${p}`);
    process.exitCode = 1;
  }
}

async function main() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(APP).hostname) && !flags.has("--force"))
    throw new Error(`${APP} is not a local demo. This script deletes and rewrites data; pass --force if you mean it.`);
  await login();
  db = openDb();
  const uid = db ? db.prepare("SELECT value FROM settings WHERE key = 'owner_user_id'").get()?.value?.replace(/^"|"$/g, "") : null;
  if (db && !uid) throw new Error("No owner in this database (is the demo onboarded?)");
  await purge(uid);
  if (PURGE_ONLY) return removeRoute();
  await ensureRoute();
  const ids = await seedTree();
  await seedTokens();
  const made = await seedChanges(ids);
  const d = await seedDecisions(ids);
  const { refs: r, runIds } = await seedRuns(ids);
  applyAges();
  log(`work seeded: ${Object.keys(ids).length} items, ${Object.keys(d).length} decisions, ${Object.keys(r).length} runs`);
  const mode = await seedChat(ids, { ids, d, r, runIds, ...made });
  await seedReadState(uid);
  await verify(mode);
}

main()
  .catch((err) => {
    console.error(`[seed] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db?.close());
