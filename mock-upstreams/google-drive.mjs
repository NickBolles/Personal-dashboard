// Mock Google Drive v3 (drive.file) + its OAuth endpoints, and the pinned eBible
// download (served from e2e/fixtures/bible). Used by e2e/workflow-drive-bible.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { json, readBody } from "./util.mjs";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const BIBLE_ZIP = fileURLToPath(new URL("../e2e/fixtures/bible/engwebp_vpl.zip", import.meta.url));

export function createGoogleDrive({ clientId, clientSecret }) {
  const state = { files: [], revoked: 0, consents: 0, seq: 0, refresh: new Set() };

  async function raw(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }
  const authed = (req) => /^Bearer mock-drive-access-/.test(req.headers.authorization ?? "");

  async function handle(req, res, path, url) {
    if (path === "/oauth/authorize" && req.method === "GET") {
      // auto-consent: only drive.file may be requested
      if (url.searchParams.get("scope") !== SCOPE || url.searchParams.get("client_id") !== clientId) return json(res, 400, { error: "invalid_scope" });
      state.consents++;
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "mock-drive-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (path === "/oauth/token" && req.method === "POST") {
      const b = await readBody(req);
      if (b.client_id !== clientId || b.client_secret !== clientSecret) return json(res, 401, { error: "invalid_client" });
      if (b.grant_type === "authorization_code" && b.code === "mock-drive-code") {
        const rt = `1//mock-drive-refresh-${++state.seq}`;
        state.refresh.add(rt);
        return json(res, 200, { access_token: `mock-drive-access-${state.seq}`, expires_in: 3600, refresh_token: rt, scope: SCOPE });
      }
      if (b.grant_type === "refresh_token" && state.refresh.has(b.refresh_token))
        return json(res, 200, { access_token: `mock-drive-access-r${++state.seq}`, expires_in: 3600 });
      return json(res, 400, { error: "invalid_grant" });
    }
    if (path === "/oauth/revoke" && req.method === "POST") {
      const b = await readBody(req);
      if (state.refresh.delete(b.token)) state.revoked++;
      return json(res, 200, {});
    }
    if (path === "/drive/v3/files" && req.method === "GET") {
      if (!authed(req)) return json(res, 401, { error: { message: "unauthorized" } });
      const q = url.searchParams.get("q") ?? "";
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
      const files = state.files.filter((f) => f.mimeType === "application/vnd.google-apps.folder" && f.name === name && f.parents.includes(parent));
      return json(res, 200, { files: files.map(({ id, name }) => ({ id, name })) });
    }
    if (path === "/drive/v3/files" && req.method === "POST") {
      if (!authed(req)) return json(res, 401, { error: { message: "unauthorized" } });
      const b = await readBody(req);
      const f = { id: `folder-${++state.seq}`, name: b.name, mimeType: b.mimeType, parents: b.parents ?? ["root"] };
      state.files.push(f);
      return json(res, 200, { id: f.id, name: f.name });
    }
    if (path === "/upload/drive/v3/files" && req.method === "POST") {
      if (!authed(req)) return json(res, 401, { error: { message: "unauthorized" } });
      const body = await raw(req);
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(body)?.[1] ?? "{}");
      const content = /text\/markdown[^\r]*\r\n\r\n([\s\S]*)\r\n--[^\r]*--\r\n$/.exec(body)?.[1] ?? "";
      const id = `doc-${++state.seq}`;
      state.files.push({ id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? ["root"], content });
      return json(res, 200, { id, name: meta.name, mimeType: meta.mimeType, webViewLink: `https://docs.google.com/document/d/${id}/edit` });
    }
    return json(res, 404, { error: { message: "not found" } });
  }

  function bible(req, res) {
    const buf = readFileSync(BIBLE_ZIP);
    res.writeHead(200, { "content-type": "application/zip", "content-length": buf.length });
    return res.end(buf);
  }

  function reset() {
    state.files = [];
    state.revoked = 0;
    state.consents = 0;
    state.refresh.clear();
  }

  return { state, handle, bible, reset };
}
