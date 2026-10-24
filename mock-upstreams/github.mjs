// Mock GitHub REST API (read-only subset the Work hub uses). Mounted at /github.
//   GET /user, /rate_limit, /orgs/:o, /users/:o, /repos/:o/:r, /repos/:o/:r/pulls/:n, /repos/:o/:r/issues/:n, /issues?filter=assigned
// Tokens: MOCK_GITHUB_TOKENS below. Control plane (no auth):
//   POST /github/__mock/pr     {owner, repo, number, state, merged, title}
//   POST /github/__mock/issue  {owner, repo, number, state, title, assignee}
//   POST /github/__mock/ratelimit {remaining, resetInSec}
//   GET  /github/__mock/requests  → recorded requests (method, path, token hint)
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

export function createGithub() {
  const state = { pulls: new Map(), issues: new Map(), requests: [], rate: { remaining: 4999, resetInSec: 3600 } };
  const key = (o, r, n) => `${o}/${r}#${n}`.toLowerCase();
  const reset = () => {
    state.pulls.clear();
    state.issues.clear();
    state.requests = [];
    state.rate = { remaining: 4999, resetInSec: 3600 };
  };
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
      if (path === "/__mock/ratelimit") {
        state.rate = { remaining: Number(body.remaining ?? 4999), resetInSec: Number(body.resetInSec ?? 3600) };
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "unknown mock control" });
    }
    if (req.method !== "GET") return json(res, 405, { message: "Jarvis only reads from GitHub" });
    if (control.fail.has("github")) return json(res, 503, { message: "unavailable" });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    state.requests.push({ method: req.method, path, tokenEnd: token.slice(-4) });
    const who = MOCK_GITHUB_TOKENS[token];
    if (!who) return json(res, 401, { message: "Bad credentials" });
    const reset = String(Math.floor(Date.now() / 1000) + state.rate.resetInSec);
    const headers = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(state.rate.remaining), "x-ratelimit-reset": reset };
    if (who.scopes !== null) headers["x-oauth-scopes"] = who.scopes;
    if (state.rate.remaining <= 0) return json(res, 403, { message: "API rate limit exceeded" }, headers);

    if (path === "/user") return json(res, 200, { login: who.login, id: 1 }, headers);
    if (path === "/rate_limit") return json(res, 200, { resources: { core: { limit: 5000, remaining: state.rate.remaining } } }, headers);
    let m = path.match(/^\/orgs\/([^/]+)$/);
    if (m)
      return m[1].toLowerCase() === "momentumbets" ? json(res, 200, { login: "momentumbets" }, headers) : json(res, 404, { message: "Not Found" }, headers);
    m = path.match(/^\/users\/([^/]+)$/);
    if (m) return json(res, 200, { login: m[1], type: "User" }, headers);
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (m) return json(res, 200, { full_name: `${m[1]}/${m[2]}`, permissions: { admin: false, push: true, pull: true } }, headers);
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (m) {
      const pr = state.pulls.get(key(m[1], m[2], m[3]));
      if (!pr) return json(res, 200, { number: Number(m[3]), state: "open", merged: false, title: `Mock PR ${m[3]}` }, headers);
      return json(res, 200, { number: pr.number, state: pr.state ?? "open", merged: !!pr.merged, title: pr.title ?? `Mock PR ${pr.number}` }, headers);
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
