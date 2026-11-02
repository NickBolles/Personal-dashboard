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
const wallClock = new Intl.DateTimeFormat("en-US", {
  timeZone: FRAME_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});
/** Frame-tz UTC offset (ms) at instant `t`. */
function frameOffset(t) {
  const p = Object.fromEntries(wallClock.formatToParts(t).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}
/**
 * `n` calendar days from `d` at the same frame-tz wall-clock time. Not `n × 24 h`: across a DST change
 * that lands an hour off, so in the week after the fall-back (23:00–00:00 CST) `isoDate(addDays(now, -5))`
 * was the day AFTER the intended date — overdue seeds turned one day less late and the home-suggestions /
 * smart-surface visual baselines failed every late evening (spring-forward: 00:00–01:00 the other way).
 */
export const addDays = (d, n) => {
  const t = d.getTime() + n * 86400000;
  return new Date(t + frameOffset(d.getTime()) - frameOffset(t));
};
/** Frame-tz calendar date `n` days from now (YYYY-MM-DD). */
export const isoDateIn = (n, now = new Date()) => isoDate(addDays(now, n));
