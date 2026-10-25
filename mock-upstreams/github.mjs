// Mock GitHub REST API (read-only subset the Work hub uses). Mounted at /github.
//   GET /user, /rate_limit, /orgs/:o, /users/:o, /repos/:o/:r, /repos/:o/:r/pulls/:n, /repos/:o/:r/issues/:n, /issues?filter=assigned
//   GET /repos/:o/:r/commits/:sha/check-suites, /repos/:o/:r/commits/:sha/status
//   GitHub App: POST /app-manifests/:code/conversions (no auth), GET /app/installations (App JWT, RS256 verified),
//   POST /app/installations/:id/access_tokens (App JWT), GET /installation/repositories (installation token).
//   Those two POSTs are the only non-GET calls Jarvis may make; anything else non-GET is a 405.
// Tokens: MOCK_GITHUB_TOKENS below, plus minted installation tokens. Control plane (no auth):
//   POST /github/__mock/pr     {owner, repo, number, state, merged, title, sha}
//   POST /github/__mock/issue  {owner, repo, number, state, title, assignee}
//   POST /github/__mock/checks {owner, repo, sha, suites: [{status, conclusion}], status: {state, total_count}}
//   POST /github/__mock/ratelimit {remaining, resetInSec}
//   POST /github/__mock/manifest {manifest, owner?, ownerType?} → {code}  (stands in for github.com/settings/apps/new)
//   POST /github/__mock/installations {installations: [{account, type, selection, repos}]}
//   GET  /github/__mock/app      → the created App (synthetic webhook secret included, for signing test deliveries)
//   GET  /github/__mock/requests  → recorded requests (method, path, token hint)
import crypto from "node:crypto";
import { json, readBody } from "./util.mjs";

/** Synthetic tokens (not real credentials). */
export const MOCK_GITHUB_TOKENS = {
  // fine-grained, read-only, belongs to "nickbolles"
  github_pat_mock_readonly_nickbolles_0001: { login: "NickBolles", scopes: null },
  // fine-grained, read-only, for the momentumbets org
  github_pat_mock_readonly_momentum_0002: { login: "NickBolles", scopes: null },
  // classic token with write scopes (Test must warn loudly)
  ghp_mock_classic_writer_token_0003: { login: "NickBolles", scopes: "repo, workflow, read:org" },
};

/** Verify an RS256 App JWT the way GitHub does (signature, iss, ≤ 10 min lifetime, not expired). */
function verifyAppJwt(token, app) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s || !app) return false;
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), app.publicKey, Buffer.from(s, "base64url"))) return false;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const now = Math.floor(Date.now() / 1000);
  return header.alg === "RS256" && String(claims.iss) === String(app.id) && claims.exp > now && claims.exp - claims.iat <= 600 && claims.iat <= now + 60;
}

const shaFor = (k) => crypto.createHash("sha1").update(k).digest("hex");

export function createGithub() {
  const state = {
    pulls: new Map(),
    issues: new Map(),
    checks: new Map(),
    requests: [],
    rate: { remaining: 4999, resetInSec: 3600 },
    manifests: new Map(),
    app: null,
    installations: [],
    instTokens: new Map(),
  };
  const key = (o, r, n) => `${o}/${r}#${n}`.toLowerCase();
  const reset = () => {
    state.pulls.clear();
    state.issues.clear();
    state.checks.clear();
    state.requests = [];
    state.rate = { remaining: 4999, resetInSec: 3600 };
    state.manifests.clear();
    state.app = null;
    state.installations = [];
    state.instTokens.clear();
  };
  const installationBody = (i) => ({
    id: i.id,
    account: { login: i.account, type: i.type ?? "User" },
    repository_selection: i.selection ?? "selected",
    suspended_at: i.suspended ? new Date().toISOString() : null,
  });
  const issueBody = (i) => ({
    id: i.number,
    node_id: `I_mock_${i.owner}_${i.repo}_${i.number}`,
    number: i.number,
    title: i.title,
    state: i.state,
    html_url: `https://github.com/${i.owner}/${i.repo}/issues/${i.number}`,
    assignees: i.assignee ? [{ login: i.assignee }] : [],
    repository: { full_name: `${i.owner}/${i.repo}` },
  });

  async function handle(req, res, path, url, control) {
    if (path.startsWith("/__mock/")) {
      if (path === "/__mock/requests") return json(res, 200, { requests: state.requests });
      const body = await readBody(req);
      if (path === "/__mock/pr") {
        state.pulls.set(key(body.owner, body.repo, body.number), { ...body, number: Number(body.number) });
        return json(res, 200, { ok: true });
      }
      if (path === "/__mock/issue") {
        state.issues.set(key(body.owner, body.repo, body.number), { state: "open", ...body, number: Number(body.number) });
        return json(res, 200, { ok: true });
      }
      if (path === "/__mock/checks") {
        state.checks.set(`${body.owner}/${body.repo}@${body.sha}`.toLowerCase(), {
          suites: body.suites ?? [],
          status: body.status ?? { state: "pending", total_count: 0 },
        });
        return json(res, 200, { ok: true });
      }
      if (path === "/__mock/manifest") {
        const code = `mockcode${crypto.randomBytes(8).toString("hex")}`;
        const manifest = typeof body.manifest === "string" ? JSON.parse(body.manifest) : body.manifest;
        state.manifests.set(code, { manifest, owner: body.owner ?? "NickBolles", ownerType: body.ownerType ?? "User" });
        return json(res, 200, { code, redirect_url: manifest?.redirect_url ?? null });
      }
      if (path === "/__mock/installations") {
        state.installations = (body.installations ?? []).map((i, n) => ({ id: Number(i.id ?? 9000 + n), ...i }));
        return json(res, 200, { installations: state.installations.map(installationBody) });
      }
      if (path === "/__mock/app") {
        if (!state.app) return json(res, 404, { error: "no app yet" });
        const { id, slug, name, owner, webhookSecret, manifest } = state.app;
        return json(res, 200, { id, slug, name, owner, webhookSecret, manifest });
      }
      if (path === "/__mock/ratelimit") {
        state.rate = { remaining: Number(body.remaining ?? 4999), resetInSec: Number(body.resetInSec ?? 3600) };
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "unknown mock control" });
    }
    if (control.fail.has("github")) return json(res, 503, { message: "unavailable" });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    state.requests.push({ method: req.method, path, tokenEnd: token.slice(-4) });

    // --- GitHub App: manifest conversion, App JWT, installation tokens ---
    let m = path.match(/^\/app-manifests\/([^/]+)\/conversions$/);
    if (m && req.method === "POST") {
      const pending = state.manifests.get(m[1]);
      if (!pending) return json(res, 404, { message: "Not Found" });
      state.manifests.delete(m[1]); // single use
      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const name = pending.manifest?.name ?? "Jarvis";
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      state.app = {
        id: 424242,
        slug,
        name,
        owner: { login: pending.owner, type: pending.ownerType },
        publicKey,
        webhookSecret: `mock-app-webhook-${crypto.randomBytes(12).toString("hex")}`,
        manifest: pending.manifest,
      };
      return json(res, 201, {
        id: state.app.id,
        slug,
        node_id: "A_mock",
        name,
        owner: state.app.owner,
        html_url: `https://github.com/apps/${slug}`,
        client_id: "Iv1.mockclientid0001",
        client_secret: `mock-client-secret-${crypto.randomBytes(8).toString("hex")}`,
        webhook_secret: state.app.webhookSecret,
        pem: privateKey.export({ type: "pkcs1", format: "pem" }),
        permissions: pending.manifest?.default_permissions ?? {},
        events: pending.manifest?.default_events ?? [],
      });
    }
    if (path === "/app" && req.method === "GET") {
      if (!verifyAppJwt(token, state.app)) return json(res, 401, { message: "A JSON web token could not be decoded" });
      const { id, slug, name, owner } = state.app;
      return json(res, 200, { id, slug, name, owner, client_id: "Iv1.mockclientid0001", html_url: `https://github.com/apps/${slug}` });
    }
    if (path === "/app/installations" && req.method === "GET") {
      if (!verifyAppJwt(token, state.app)) return json(res, 401, { message: "A JSON web token could not be decoded" });
      return json(res, 200, state.installations.map(installationBody));
    }
    m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (m && req.method === "POST") {
      if (!verifyAppJwt(token, state.app)) return json(res, 401, { message: "A JSON web token could not be decoded" });
      const inst = state.installations.find((i) => i.id === Number(m[1]));
      if (!inst) return json(res, 404, { message: "Not Found" });
      const t = `mockinst_${inst.id}_${crypto.randomBytes(10).toString("hex")}`;
      state.instTokens.set(t, inst.id);
      return json(res, 201, {
        token: t,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: state.app.manifest?.default_permissions ?? {},
      });
    }
    if (req.method !== "GET") return json(res, 405, { message: "Jarvis only reads from GitHub" });
    const instId = state.instTokens.get(token);
    const inst = instId ? state.installations.find((i) => i.id === instId) : null;
    if (path === "/installation/repositories") {
      if (!inst) return json(res, 401, { message: "Bad credentials" });
      const repos = inst.repos ?? [];
      return json(res, 200, { total_count: repos.length, repositories: repos.map((r) => ({ name: r, full_name: `${inst.account}/${r}` })) });
    }
    const who = MOCK_GITHUB_TOKENS[token] ?? (inst ? { login: `${state.app?.slug ?? "jarvis"}[bot]`, scopes: null, installation: inst } : null);
    if (!who) return json(res, 401, { message: "Bad credentials" });
    // An installation token only sees its account's covered repositories.
    const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)/);
    if (who.installation && repoMatch) {
      const i = who.installation;
      const covered =
        i.account.toLowerCase() === repoMatch[1].toLowerCase() &&
        (i.selection === "all" || (i.repos ?? []).some((r) => r.toLowerCase() === repoMatch[2].toLowerCase()));
      if (!covered) return json(res, 404, { message: "Not Found" });
    }
    const reset = String(Math.floor(Date.now() / 1000) + state.rate.resetInSec);
    const headers = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(state.rate.remaining), "x-ratelimit-reset": reset };
    if (who.scopes !== null) headers["x-oauth-scopes"] = who.scopes;
    if (state.rate.remaining <= 0) return json(res, 403, { message: "API rate limit exceeded" }, headers);

    if (path === "/user") return json(res, 200, { login: who.login, id: 1 }, headers);
    if (path === "/rate_limit") return json(res, 200, { resources: { core: { limit: 5000, remaining: state.rate.remaining } } }, headers);
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)\/(check-suites|status)$/);
    if (m) {
      const c = state.checks.get(`${m[1]}/${m[2]}@${m[3]}`.toLowerCase()) ?? { suites: [], status: { state: "pending", total_count: 0 } };
      if (m[4] === "status") return json(res, 200, { state: c.status.state, total_count: c.status.total_count ?? 0, statuses: [] }, headers);
      const suites = c.suites.map((x, n) => ({
        id: n + 1,
        status: x.status ?? "completed",
        conclusion: x.conclusion ?? null,
        latest_check_runs_count: x.runs ?? 1,
      }));
      return json(res, 200, { total_count: suites.length, check_suites: suites }, headers);
    }
    m = path.match(/^\/orgs\/([^/]+)$/);
    if (m)
      return m[1].toLowerCase() === "momentumbets" ? json(res, 200, { login: "momentumbets" }, headers) : json(res, 404, { message: "Not Found" }, headers);
    m = path.match(/^\/users\/([^/]+)$/);
    if (m) return json(res, 200, { login: m[1], type: "User" }, headers);
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (m) return json(res, 200, { full_name: `${m[1]}/${m[2]}`, permissions: { admin: false, push: true, pull: true } }, headers);
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (m) {
      const pr = state.pulls.get(key(m[1], m[2], m[3]));
      const head = { sha: pr?.sha ?? shaFor(key(m[1], m[2], m[3])) };
      if (!pr) return json(res, 200, { number: Number(m[3]), state: "open", merged: false, title: `Mock PR ${m[3]}`, head }, headers);
      return json(res, 200, { number: pr.number, state: pr.state ?? "open", merged: !!pr.merged, title: pr.title ?? `Mock PR ${pr.number}`, head }, headers);
    }
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
    if (m) {
      const is = state.issues.get(key(m[1], m[2], m[3]));
      return json(res, 200, is ? issueBody(is) : { number: Number(m[3]), state: "open", title: `Mock issue ${m[3]}` }, headers);
    }
    if (path === "/issues" && url.searchParams.get("filter") === "assigned") {
      const list = [...state.issues.values()].filter((i) => i.state === "open" && i.assignee && i.assignee.toLowerCase() === who.login.toLowerCase());
      return json(res, 200, list.map(issueBody), headers);
    }
    return json(res, 404, { message: "Not Found" }, headers);
  }
  return { handle, reset, state };
}
