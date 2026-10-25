#!/usr/bin/env node
// One-shot admin import of an existing read-only GitHub App into Jarvis (docs/github-app.md).
//   docker exec Jarvis node scripts/import-github-app.mjs /data/private/github-app.json [--allow nickbolles,momentumbets] [--replace] [--no-verify]
// The JSON holds the manifest-conversion shape: { id, slug, client_id?, client_secret?, webhook_secret?, pem }.
// Secrets are encrypted with the same AES-256-GCM envelope as server/crypto.ts (JARVIS_SECRET_KEY or <data>/secret.key)
// and never printed: the output is only the App id/slug/owner and its installation accounts.
// Run it after Jarvis has started once on the new version (so the migration has created the tables).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name) => args.includes(name);
const allowIdx = args.indexOf("--allow");
const allow =
  allowIdx > -1
    ? (args[allowIdx + 1] ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : null;
const die = (msg, code = 1) => {
  console.error(`import-github-app: ${msg}`);
  process.exit(code);
};
if (!file) die("usage: node scripts/import-github-app.mjs <path-to-json> [--allow a,b] [--replace] [--no-verify]");
if (allow && !allow.every((a) => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(a))) die("--allow takes comma-separated GitHub account names");

let input;
try {
  input = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
} catch {
  die(`can't read ${file} as JSON`); // never echo the content
}
const appId = Number(input.id);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const pem = str(input.pem);
if (!Number.isInteger(appId) || appId <= 0) die("the JSON needs a numeric `id`");
if (!str(input.slug)) die("the JSON needs `slug`");
if (!pem || !/PRIVATE KEY-----/.test(pem)) die("the JSON needs `pem` (the App's private key)");

// --- encryption (same envelope as server/crypto.ts) ---
const dataDir = path.resolve(process.env.JARVIS_DATA_DIR ?? "./data");
const dbPath = process.env.JARVIS_DB_PATH ?? path.join(dataDir, "jarvis.db");
let key;
if (process.env.JARVIS_SECRET_KEY) key = Buffer.from(process.env.JARVIS_SECRET_KEY, "base64");
else if (fs.existsSync(path.join(dataDir, "secret.key"))) key = Buffer.from(fs.readFileSync(path.join(dataDir, "secret.key"), "utf8").trim(), "base64");
if (!key || key.length !== 32) die("no encryption key: set JARVIS_SECRET_KEY or start Jarvis once so <data>/secret.key exists");
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

// --- GitHub (App JWT, read-only GETs) ---
const apiBase = (process.env.JARVIS_GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${body}.${crypto.sign("RSA-SHA256", Buffer.from(body), pem).toString("base64url")}`;
}
async function appGet(p) {
  const res = await fetch(`${apiBase}${p}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt()}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "jarvis-work-hub",
    },
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let meta = {
  slug: str(input.slug),
  name: str(input.name) ?? str(input.slug),
  owner: str(input.owner?.login) ?? "",
  ownerType: str(input.owner?.type) ?? "User",
  htmlUrl: null,
};
let installations = [];
if (!flag("--no-verify")) {
  let app;
  try {
    app = await appGet("/app");
  } catch {
    die("couldn't reach GitHub to verify the App (use --no-verify to store it anyway)");
  }
  if (app.status !== 200 || Number(app.body?.id) !== appId) die(`GitHub didn't confirm App ${appId} with that private key (HTTP ${app.status})`);
  meta = {
    slug: app.body.slug,
    name: app.body.name ?? app.body.slug,
    owner: app.body.owner?.login ?? meta.owner,
    ownerType: app.body.owner?.type ?? meta.ownerType,
    htmlUrl: app.body.html_url ?? null,
  };
  const inst = await appGet("/app/installations?per_page=100");
  if (inst.status === 200 && Array.isArray(inst.body)) installations = inst.body.filter((i) => Number.isInteger(i.id) && typeof i.account?.login === "string");
}
if (!meta.owner) die("unknown App owner: verify against GitHub (drop --no-verify) or add owner.login to the JSON");

// --- store ---
if (!fs.existsSync(dbPath)) die(`no database at ${dbPath}`);
const db = new Database(dbPath);
const has = (t) => !!db.prepare("select name from sqlite_master where type='table' and name=?").get(t);
if (!has("github_apps")) die("the github_apps table doesn't exist yet: start Jarvis on this version once (it runs migrations), then retry");
const existing = db.prepare("select app_id, slug from github_apps limit 1").get();
if (existing && !flag("--replace")) die(`a GitHub App is already set up (${existing.app_id} ${existing.slug}); pass --replace to overwrite it`);
const admin = db.prepare("select id from users where role='admin' and disabled_at is null order by created_at limit 1").get();
if (!admin) die("no admin user: claim the instance first");

const now = new Date().toISOString();
const rowId = `gha_${crypto.randomUUID()}`;
const setSetting = (k, v) =>
  db
    .prepare(
      "insert into settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(k, JSON.stringify(v), now);
db.transaction(() => {
  db.prepare("delete from github_apps").run(); // cascades to installations
  db.prepare(
    `insert into github_apps (id, app_id, slug, name, owner_login, owner_type, html_url, client_id, client_secret_cipher, pem_cipher, webhook_secret_cipher, created_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rowId,
    appId,
    meta.slug,
    meta.name,
    meta.owner,
    meta.ownerType,
    meta.htmlUrl,
    str(input.client_id) ?? "",
    str(input.client_secret) ? encrypt(str(input.client_secret)) : null,
    encrypt(pem),
    str(input.webhook_secret) ? encrypt(str(input.webhook_secret)) : null,
    admin.id,
    now,
    now,
  );
  const ins = db.prepare(
    "insert into github_app_installations (id, app_row_id, account_login, account_key, account_type, repository_selection, repos, suspended, updated_at) values (?, ?, ?, ?, ?, ?, null, ?, ?)",
  );
  for (const i of installations)
    ins.run(
      i.id,
      rowId,
      i.account.login,
      i.account.login.toLowerCase(),
      i.account.type ?? "User",
      i.repository_selection === "all" ? "all" : "selected",
      i.suspended_at ? 1 : 0,
      now,
    );
  if (allow) setSetting("work.github.app_allowlist", allow);
  setSetting("work.github.app_refresh", { at: now, ok: true, detail: `Imported from a file: ${installations.length} installation(s)` });
  db.prepare("insert into audit_log (id, at, actor, action, source, source_record, result, correlation_id, detail) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    crypto.randomUUID(),
    now,
    admin.id,
    "github.app_import",
    "github",
    String(appId),
    "ok",
    `import_${crypto.randomUUID()}`,
    JSON.stringify({ appId, slug: meta.slug, installations: installations.length, webhookSecret: !!str(input.webhook_secret), replaced: !!existing }),
  );
})();

// Effective allowlist (same rule as the server: explicit list, else token owners + the App owner).
const stored = db.prepare("select value from settings where key='work.github.app_allowlist'").get();
const explicit = stored ? JSON.parse(stored.value) : null;
const effective = Array.isArray(explicit)
  ? explicit
  : [
      ...new Set([
        ...db
          .prepare("select owner from github_connections")
          .all()
          .map((r) => r.owner.toLowerCase()),
        meta.owner.toLowerCase(),
      ]),
    ];
db.close();

console.log(`Imported GitHub App ${appId} (${meta.slug}), owner ${meta.owner}${str(input.webhook_secret) ? "" : " — no webhook secret in the file"}`);
console.log(`Allowlist${Array.isArray(explicit) ? "" : " (default)"}: ${effective.join(", ") || "(empty)"}`);
if (!installations.length) console.log(flag("--no-verify") ? "Installations: not read (--no-verify); press Refresh in Settings" : "Installations: none");
for (const i of installations)
  console.log(
    `- ${i.account.login} (${i.account.type ?? "User"}), installation ${i.id}: ${effective.includes(i.account.login.toLowerCase()) ? "in use" : "IGNORED (not in the allowlist)"}`,
  );
console.log("Next: Settings → Connections → GitHub → Refresh installations (reads their repositories).");
