// Mock Firebase: Google OAuth token endpoint (JWT bearer grant) + FCM HTTP v1 send.
// Registration tokens starting with "dead-" behave like an uninstalled app (404 UNREGISTERED).
import { json, readBody } from "./util.mjs";

export function createFcm() {
  const state = { messages: [], tokens: 0 };
  function reset() {
    state.messages = [];
    state.tokens = 0;
  }
  async function handle(req, res, path) {
    if (path === "/token" && req.method === "POST") {
      const form = await readBody(req);
      const assertion = form.assertion ?? "";
      if (form.grant_type !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || assertion.split(".").length !== 3) {
        return json(res, 400, { error: "invalid_grant", error_description: "Bad assertion" });
      }
      state.tokens++;
      return json(res, 200, { access_token: `ya29.mock-${state.tokens}`, expires_in: 3599, token_type: "Bearer" });
    }
    const m = path.match(/^\/v1\/projects\/([^/]+)\/messages:send$/);
    if (m && req.method === "POST") {
      if (!(req.headers.authorization ?? "").startsWith("Bearer ya29.mock-")) return json(res, 401, { error: { status: "UNAUTHENTICATED" } });
      const body = await readBody(req);
      const token = body.message?.token ?? "";
      if (token.startsWith("dead-")) {
        return json(res, 404, { error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } });
      }
      state.messages.push({ project: m[1], ...body.message });
      return json(res, 200, { name: `projects/${m[1]}/messages/${state.messages.length}` });
    }
    return json(res, 404, { error: "not found" });
  }
  return { handle, reset, state };
}
