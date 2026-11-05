/**
 * Phase 0 Skylight full read (P1 fix): ±7-day window, every member, pagination, failures that
 * fail the sync, household-day completions, lists, and Home scoping. Upstream is a fetch stub so
 * each request's query is asserted exactly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { __setTestDatabase } from "@/server/db";
import { claimInstance } from "@/server/auth";
import { updatePreferences } from "@/server/settings";
import { saveIntegration } from "@/integrations/store";
import { adapterContext, homeScopedSkylight } from "@/server/sources";
import { choreDoneDay, readWindow, skylightAdapter } from "@/integrations/skylight/adapter";

const BASE = "http://skylight.test";
type Call = { method: string; path: string; query: Record<string, string> };
let calls: Call[] = [];
let failPaths: RegExp[] = [];
let rt = 0;

const NOW = new Date("2026-11-04T18:00:00Z"); // 12:00 CT
const res = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chore = (id: string, cat: string | null, attrs: Record<string, unknown>) => ({
  id,
  type: "chore",
  attributes: { summary: `Chore ${id}`, status: "pending", start: "2026-11-04", start_time: null, ...attrs },
  relationships: { category: { data: cat ? { id: cat, type: "category" } : null } },
});
const CHORES = [
  chore("1", "100", {}),
  chore("2", "200", {}), // Will's: kept now (was dropped at ingest)
  chore("3", "100", { status: "complete", completed_on: "2026-11-01" }), // completed 3 days ago
  chore("4", "200", { status: "complete", completed_on: "2026-11-04T02:30:00Z" }), // 20:30 CT Nov 3
  chore("5", "300", { start: "2026-11-07" }), // Family group: up for grabs, in 3 days
  chore("6", "100", { start: "2026-11-02" }), // overdue
  chore("7", "100", { status: "skipped" }),
  chore("8", "100", { status: "complete", completed_on: "2026-11-04" }),
  chore("9", "200", { status: "complete", completed_on: "2026-11-04" }), // Will's, done today: not on Home
];

function stub() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname === "/oauth/token") return res(200, { access_token: "at", refresh_token: `rt${++rt}`, expires_in: 3600 });
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (failPaths.some((r) => r.test(url.pathname))) return res(500, { errors: ["boom"] });
    const p = url.pathname;
    if (p === "/api/frames/F1/categories")
      return res(200, {
        data: [
          { id: "100", type: "category", attributes: { label: "Nick", linked_to_profile: true } },
          { id: "200", type: "category", attributes: { label: "Will", linked_to_profile: true } },
          { id: "300", type: "category", attributes: { label: "Family", linked_to_profile: false } },
        ],
      });
    if (p === "/api/frames/F1/chores") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = CHORES.slice((page - 1) * 3, page * 3);
      const next =
        page * 3 < CHORES.length ? `/api/frames/F1/chores?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(page + 1) })}` : null;
      return res(200, { data: slice, links: { next } });
    }
    if (p === "/api/frames/F1/calendar_events")
      return res(200, {
        data: [
          {
            id: "e1",
            type: "calendar_event",
            attributes: {
              summary: "Dentist",
              starts_at: "2026-11-05T15:00:00-06:00",
              ends_at: "2026-11-05T16:00:00-06:00",
              all_day: false,
              description: "Bring forms",
              calendar_id: "work@example.com",
              source_calendar_id: 42,
              calendar_account_id: 7,
            },
          },
        ],
      });
    if (p === "/api/frames/F1/lists") return res(200, { data: [{ id: "L1", type: "list", attributes: { label: "Groceries", kind: "shopping" } }] });
    if (p === "/api/frames/F1/lists/L1")
      return res(200, {
        data: { id: "L1", type: "list", attributes: { label: "Groceries" } },
        included: [
          { id: "i1", type: "list_item", attributes: { label: "Milk", status: "pending" } },
          { id: "i2", type: "list_item", attributes: { label: "Eggs", status: "completed" } },
        ],
      });
    return res(404, {});
  });
}

beforeAll(() => {
  __setTestDatabase();
  claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  updatePreferences({ timezone: "America/Chicago" });
  saveIntegration("skylight", {
    enabled: true,
    config: { mode: "direct", baseUrl: BASE, frameId: "F1", members: "100", groups: "", showOthers: "false", includeUpForGrabs: "true" },
    secrets: { refreshToken: "rt0" },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
  failPaths = [];
});
afterAll(() => vi.unstubAllGlobals());

const fetchNow = async () => {
  vi.stubGlobal("fetch", stub());
  // The data module (ctx) is the only clock that matters: the adapter takes everything from it.
  // Pass the context by value: the "data" field here is the snapshot's actions/extra.
  return skylightAdapter.fetch(adapterContext(NOW));
};

describe("Skylight full read (direct)", () => {
  it("reads chores over today−7…today+7 in the household time zone and follows pagination", async () => {
    await fetchNow();
    const chores = calls.filter((c) => c.path === "/api/frames/F1/chores");
    expect(chores).toHaveLength(3);
    expect(chores[0]!.query).toEqual({ after: "2026-10-28", before: "2026-11-11", timezone: "America/Chicago", include_late: "true" });
    expect(chores[2]!.query.page).toBe("3");
    expect(readWindow("2026-11-04")).toEqual({ from: "2026-10-28", to: "2026-11-11" });
    const ev = calls.find((c) => c.path === "/api/frames/F1/calendar_events")!;
    expect(ev.query).toMatchObject({ date_min: "2026-11-04", date_max: "2026-11-12" });
  });

  it("keeps every member's chores (others labelled) and completions from earlier days", async () => {
    const data = await fetchNow();
    const by = new Map(data.actions.map((a) => [a.sourceId, a]));
    expect([...by.keys()].sort()).toEqual(["1", "2", "3", "4", "5", "6", "8", "9"]);
    expect(by.get("2")!.assignee).toEqual({ kind: "other", name: "Will" });
    expect(by.get("5")!.assignee).toMatchObject({ kind: "up_for_grabs" });
    expect(by.get("3")).toMatchObject({ status: "completed", skylight: { kind: "chore", completedOn: "2026-11-01", categoryId: "100" } });
    // A UTC timestamp completion is the household day (20:30 CT on Nov 3), not the UTC date.
    expect(by.get("4")!.skylight).toMatchObject({ completedOn: "2026-11-03" });
    expect(by.get("6")!.priorityReason).toBe("overdue");
    expect(by.get("5")!.priorityReason).toBe("upcoming");
    expect(by.get("5")).toMatchObject({ dueAt: "2026-11-08T05:59:00.000Z", dueIsDate: true, dueTimezone: "America/Chicago" });
    expect(by.get("1")!.priorityReason).toBe("today");
    expect(data.extra).toMatchObject({
      counts: { mine: 2, upForGrabs: 1, others: 1, hidden: 1, completedToday: 2, completedWindow: 4 },
      window: { from: "2026-10-28", to: "2026-11-11" },
      health: { ok: true, failed: [] },
      needsMember: false,
    });
  });

  it("Home keeps mine + up for grabs and only today's completions", async () => {
    const data = await fetchNow();
    const scoped = homeScopedSkylight({ status: { source: "skylight", label: "Skylight", state: "ok" }, data });
    expect(scoped.data!.actions.map((a) => a.sourceId).sort()).toEqual(["1", "5", "6", "8"]);
  });

  it("reads lists into list-item rows with a list source chip", async () => {
    const data = await fetchNow();
    expect(data.extra!.lists).toEqual([{ id: "L1", label: "Groceries", kind: "shopping" }]);
    const items = data.extra!.listItems as { title: string; status: string; sourceLabel: string; skylight: unknown }[];
    expect(items.map((i) => [i.title, i.status, i.sourceLabel])).toEqual([
      ["Milk", "open", "Skylight · Groceries"],
      ["Eggs", "completed", "Skylight · Groceries"],
    ]);
    expect(items[0]!.skylight).toEqual({ kind: "list_item", listId: "L1", itemId: "i1", listLabel: "Groceries" });
    // List items never enter actions (Home attention).
    expect(data.actions.some((a) => a.sourceId.startsWith("li:"))).toBe(false);
  });

  it("maps events with their write ref", async () => {
    const data = await fetchNow();
    expect(data.events![0]).toMatchObject({
      title: "Dentist",
      startsAt: "2026-11-05T21:00:00.000Z",
      endsAt: "2026-11-05T22:00:00.000Z",
      skylight: { eventId: "e1", description: "Bring forms", editable: true, calendarId: "work@example.com", sourceCalendarId: "42", calendarAccountId: "7" },
    });
  });

  it("a failed chores read fails the sync instead of reporting 0 chores (after retries)", async () => {
    failPaths = [/\/chores$/];
    await expect(fetchNow()).rejects.toThrow(/Skylight returned 500/);
    expect(calls.filter((c) => c.path.endsWith("/chores"))).toHaveLength(3); // 1 + 2 retries
  });

  it("lists/events failures are partial and reported in health", async () => {
    failPaths = [/\/lists$/, /\/calendar_events$/];
    const data = await fetchNow();
    expect(data.actions.length).toBeGreaterThan(0);
    expect(data.extra).toMatchObject({ health: { ok: false, failed: ["events", "lists"] }, lists: [], listItems: [] });
  });

  it("completion day helper: dates pass through, timestamps convert to the household day", () => {
    expect(choreDoneDay({ completed_on: "2026-11-02" }, "America/Chicago")).toBe("2026-11-02");
    expect(choreDoneDay({ completed_on: "2026-11-04T05:59:00Z" }, "America/Chicago")).toBe("2026-11-03");
    expect(choreDoneDay({ completed_on: "2026-11-04T06:01:00Z" }, "America/Chicago")).toBe("2026-11-04");
    expect(choreDoneDay({ start: "2026-11-01" }, "America/Chicago")).toBe("2026-11-01");
  });
});
