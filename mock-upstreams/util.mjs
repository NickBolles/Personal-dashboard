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

/**
 * Calendar date (YYYY-MM-DD) in the frame/server timezone (the e2e server runs with TZ=America/Chicago).
 * Not UTC: between 18:00 and 00:00 CT the UTC date is already tomorrow, so a task seeded "due today"
 * would render as "Upcoming" and date-sensitive visual baselines would fail every evening.
 */
export const FRAME_TZ = process.env.MOCK_TZ || "America/Chicago";
const frameDate = new Intl.DateTimeFormat("en-CA", { timeZone: FRAME_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const isoDate = (d) => frameDate.format(d);
export const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
