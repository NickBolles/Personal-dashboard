import { expect, it } from "vitest";
import { normalize, validateWindow, readSkylight } from "../hermes/skills/jarvis-skylight-read/scripts/read.mjs";
const window = { from: "2026-10-10", to: "2026-10-17", timezone: "America/Chicago" };
const fixture = {
  events: {
    data: [
      {
        id: "event1",
        attributes: { summary: "Practice", starts_at: "2026-10-10T17:30:00-05:00", ends_at: "2026-10-10T18:30:00-05:00", all_day: false, location: "Field" },
      },
      { id: "event2", attributes: { summary: "Holiday", starts_at: "2026-10-12", ends_at: "2026-10-13", all_day: true } },
    ],
  },
  chores: {
    data: [
      { id: "chore1", attributes: { summary: "Feed dog", start: "2026-10-10", start_time: "07:30", status: "pending" } },
      { id: "chore2", attributes: { summary: "Done", start: "2026-10-10", status: "complete" } },
      { id: "chore3", attributes: { summary: "Skip", start: "2026-10-10", status: "skipped" } },
      { id: "chore4", attributes: { summary: "Old", start: "2026-10-09", status: "pending" } },
    ],
  },
};
it("normalizes dated events and today's chore cards without treating skipped as open", () => {
  expect(normalize(fixture.events, fixture.chores, window)).toEqual({
    events: [
      { title: "Practice", start: "2026-10-10T17:30:00-05:00", end: "2026-10-10T18:30:00-05:00", allDay: false, location: "Field" },
      { title: "Holiday", start: "2026-10-12", end: "2026-10-13", allDay: true, location: null },
    ],
    chores: [
      { id: "chore1", title: "Feed dog", time: "07:30", completed: false },
      { id: "chore2", title: "Done", time: null, completed: true },
    ],
  });
});
it.each([{ from: "2026-02-30" }, { to: "2026-12-10" }, { to: "2026-10-10" }, { timezone: "Mars/Test" }, { from: "$(env)" }])(
  "rejects invalid or unbounded inputs before authentication: %j",
  async (change) => {
    expect(() => validateWindow({ ...window, ...change })).toThrow();
  },
);
it("fails closed for malformed provider data and truncation", () => {
  expect(() => normalize({ data: [{}] }, fixture.chores, window)).toThrow();
  expect(() => normalize({ data: [], links: { next: "more" } }, fixture.chores, window)).toThrow();
  expect(() =>
    normalize(fixture.events, { data: [{ id: "x", attributes: { summary: "X", start: window.from, start_time: "29:88", status: "pending" } }] }, window),
  ).toThrow();
});
it("invalid inputs never call transport or use credentials", async () => {
  let calls = 0;
  await expect(
    readSkylight(
      { ...window, from: "bad" },
      {
        env: {},
        fetchImpl: async () => {
          calls++;
          throw Error();
        },
      },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

it("performs only auth POSTs and bounded data GETs with fixture credentials", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  let state = "";
  const fetchImpl = async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    expect(init.redirect).toBe("manual");
    if (url.pathname === "/oauth/authorize") {
      state = url.searchParams.get("state")!;
      return new Response('<meta name="csrf-token" content="fixture-csrf">', { headers: { "set-cookie": "session=fixture; Secure" } });
    }
    if (url.pathname === "/auth/session")
      return new Response(null, { status: 302, headers: { location: `https://ourskylight.com/welcome?code=fixture-code&state=${state}` } });
    if (url.pathname === "/oauth/token") return Response.json({ access_token: "fixture-token" });
    if (url.pathname.endsWith("/calendar_events")) return Response.json(fixture.events);
    if (url.pathname.endsWith("/chores")) return Response.json(fixture.chores);
    throw Error("unexpected endpoint");
  };
  const result = await readSkylight(window, {
    env: { SKYLIGHT_USERNAME: "fixture-user", SKYLIGHT_PASSWORD: "fixture-password", SKYLIGHT_FRAME_ID: "123" },
    fetchImpl,
  });
  expect(result).toEqual(normalize(fixture.events, fixture.chores, window));
  expect(calls.map((c) => [c.url.pathname, c.init.method ?? "GET"])).toEqual([
    ["/oauth/authorize", "GET"],
    ["/auth/session", "POST"],
    ["/oauth/token", "POST"],
    ["/api/frames/123/calendar_events", "GET"],
    ["/api/frames/123/chores", "GET"],
  ]);
  expect(calls[3]!.url.searchParams.get("date_max")).toBe(window.to);
  expect(calls[4]!.url.searchParams.get("before")).toBe(window.from);
  expect(calls[4]!.url.searchParams.get("include_late")).toBe("false");
  expect(JSON.stringify(result)).not.toContain("fixture-token");
});

it("uses one stable UUID fingerprint for authorization and token exchange across reads", async () => {
  const fingerprints: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let state = "";
    let fingerprint = "";
    const fetchImpl = async (url: URL, init: RequestInit) => {
      if (url.pathname === "/oauth/authorize") {
        state = url.searchParams.get("state")!;
        fingerprint = url.searchParams.get("skylight_api_client_device_fingerprint")!;
        expect(fingerprint).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        fingerprints.push(fingerprint);
        return new Response('<meta name="csrf-token" content="fixture-csrf">');
      }
      if (url.pathname === "/auth/session")
        return new Response(null, { status: 302, headers: { location: `https://ourskylight.com/welcome?code=fixture-code&state=${state}` } });
      if (url.pathname === "/oauth/token") {
        expect(init.body).toBeInstanceOf(URLSearchParams);
        expect((init.body as URLSearchParams).get("skylight_api_client_device_fingerprint")).toBe(fingerprint);
        return Response.json({ access_token: "fixture-token" });
      }
      if (url.pathname.endsWith("/calendar_events") || url.pathname.endsWith("/chores")) return Response.json({ data: [] });
      throw Error("unexpected endpoint");
    };
    await expect(
      readSkylight(window, { env: { SKYLIGHT_USERNAME: "fixture", SKYLIGHT_PASSWORD: "fixture", SKYLIGHT_FRAME_ID: "123" }, fetchImpl }),
    ).resolves.toEqual({ events: [], chores: [] });
  }
  expect(fingerprints).toHaveLength(2);
  expect(fingerprints[1]).toBe(fingerprints[0]);
});

it("does not forward cookies to a malicious OAuth redirect", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://evil.invalid/" } });
  };
  await expect(
    readSkylight(window, { env: { SKYLIGHT_USERNAME: "fixture", SKYLIGHT_PASSWORD: "fixture", SKYLIGHT_FRAME_ID: "123" }, fetchImpl }),
  ).rejects.toThrow("skylight_read_failed");
  expect(calls).toBe(1);
});

it("normalizes nullable/blank titles and omits explicitly undated chores only", () => {
  const events = { data: [{ attributes: { summary: null, starts_at: "2026-10-10", all_day: true } }] };
  const chores = {
    data: [
      { id: "1", attributes: { summary: " ", start: window.from, status: "pending" } },
      { id: "2", attributes: { summary: "Task box", start: null, status: "pending" } },
    ],
  };
  const result = normalize(events, chores, window);
  expect(result.events[0].title).toBe("(untitled)");
  expect(result.chores).toEqual([{ id: "1", title: "(untitled)", time: null, completed: false }]);
  expect(() => normalize(events, { data: [{ id: "x", attributes: { status: "pending" } }] }, window)).toThrow();
});
it("uses timezone boundaries and excludes the exclusive end date", () => {
  const events = {
    data: [
      { attributes: { summary: "Before local day", starts_at: "2026-10-10T01:00:00Z", all_day: false } },
      { attributes: { summary: "Inside local day", starts_at: "2026-10-17T01:00:00Z", all_day: false } },
      { attributes: { summary: "Exclusive end", starts_at: window.to, all_day: true } },
    ],
  };
  expect(normalize(events, { data: [] }, window).events.map((e: { title: string }) => e.title)).toEqual(["Inside local day"]);
});
it.each(["state", "oversize", "login"])("fails closed without leaking provider bodies for %s", async (scenario) => {
  const fetchImpl = async (url: URL) => {
    if (scenario === "oversize") return new Response("PRIVATE".repeat(300_000));
    if (url.pathname === "/oauth/authorize" || url.pathname === "/auth/session/new") return new Response('<meta name="csrf-token" content="fixture">');
    return new Response(null, {
      status: 302,
      headers: { location: scenario === "state" ? "https://ourskylight.com/welcome?code=PRIVATE&state=wrong" : "/auth/session/new" },
    });
  };
  await expect(
    readSkylight(window, { env: { SKYLIGHT_USERNAME: "fixture", SKYLIGHT_PASSWORD: "fixture", SKYLIGHT_FRAME_ID: "123" }, fetchImpl }),
  ).rejects.toThrow(/^skylight_read_failed$/);
});
