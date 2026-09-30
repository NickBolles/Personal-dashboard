export function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function bearerOk(req, token) {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

export function notFound(res) {
  json(res, 404, { error: "not found" });
}

export function hermesError(res, status, code, message) {
  json(res, status, { error: { message, type: "invalid_request_error", param: null, code } });
}

export const isoDate = (d) => d.toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
