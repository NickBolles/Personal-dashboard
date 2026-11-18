import type { Page } from "@playwright/test";
export type Msg = { kind: "user" | "assistant"; id: string; text: string; at: string };
/** Fully stubbed coordinator: `threads` by session id; the pin is stateful (PUT changes what the global info says). */
export async function stubCoordinator(page: Page, threads: Record<string, Msg[]>, opts: { current: string; stubDecisions?: boolean; now?: number }) {
  const iso = (minAgo: number) => new Date((opts.now ?? Date.now()) - minAgo * 60_000).toISOString();
  const state = { current: opts.current, pins: [] as (string | null)[], runs: [] as { sid: string; body: Record<string, unknown> }[] };
  await page.route("**/api/work/coordinator/global", (route) =>
    route.fulfill({
      json: {
        area: { id: "portfolio", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: state.current,
        sessionTitle: state.current === "cw-pin" ? "Chief of staff" : "Older bramble thread",
        pinned: true,
        excluded: false,
        prompt: "Catch me up",
        lastRunAt: null,
      },
    }),
  );
  await page.route("**/api/work/items/portfolio/coordinator", (route) => {
    const body = route.request().postDataJSON() as { sessionId: string | null };
    const previous = state.current;
    state.pins.push(body.sessionId);
    if (body.sessionId) state.current = body.sessionId;
    return route.fulfill({ json: { areaId: "portfolio", sessionId: state.current, pinned: true, previous } });
  });
  await page.route("**/api/work/conversations*", (route) =>
    route.fulfill({
      json: {
        conversations: [
          { id: "cw-old", title: "Older bramble thread", placement: { parentId: "portfolio" }, suggestions: [] },
          { id: "zz-bramble", title: "zz-smoke 15:42 api_bramble", placement: { parentId: "portfolio" }, suggestions: [] },
        ],
        unfiledCount: 0,
        unreadCount: 0,
        unavailable: [],
      },
    }),
  );
  await page.route("**/api/work/decisions*", (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (route) => route.fulfill({ json: { items: {}, active: [] } }));
  await page.route("**/api/work/activity**", (route) => route.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route("**/api/work/items*", (route) => route.fulfill({ json: { items: [], linkedConversations: [] } }));
  if (opts.stubDecisions !== false)
    await page.route("**/api/coordinator/decisions*", (route) => route.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  await page.route("**/api/coordinator/runs", (route) =>
    route.fulfill({ json: { runs: [], events: [], lastLooked: { chat: iso(0), needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/coordinator/looked", (route) =>
    route.fulfill({ json: { lastLooked: { chat: iso(0), needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/hermes/sessions**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const sid = decodeURIComponent(path.split("/")[4] ?? "");
    if (req.method() === "POST" && path.endsWith("/runs")) {
      state.runs.push({ sid, body: req.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { runId: `run-${state.runs.length}`, sessionId: sid, status: "completed" } });
    }
    if (req.method() !== "GET") return route.fulfill({ status: 409, json: { error: "Not part of this test" } });
    if (path.endsWith("/area")) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith("/execution"))
      return route.fulfill({ json: { sessionId: sid, parent: null, records: [], sources: [{ source: "transcript", state: "ok" }], fetchedAt: iso(0) } });
    if (path.endsWith("/files") || path.endsWith("/links-panel")) return route.fulfill({ json: { files: [], links: [] } });
    if (path === "/api/hermes/sessions") return route.fulfill({ json: { sessions: [], nextOffset: null } });
    const title = sid === "cw-pin" ? "Chief of staff" : "Older bramble thread";
    return route.fulfill({ json: { session: { id: sid, title, pinned: false, archived: false }, children: [], links: [], timeline: threads[sid] ?? [] } });
  });
  return state;
}

/** Opens the Chief of staff Chat tab: the tray sheet on phones, the rail on desktop. */
export async function openChat(page: Page, desktop: boolean) {
  const scope = desktop ? page.getByRole("complementary", { name: "Chief of staff" }) : page.getByRole("dialog", { name: "Chief of staff" });
  if (!desktop) await page.locator(".gc-tray").getByRole("button", { name: "Chief of staff", exact: true }).click();
  await scope.getByRole("tab", { name: "Chat", exact: true }).click();
  return scope;
}

export const batchReply = () =>
  "Choose the bramble plan.\n\n```jarvis-ui\n" +
  JSON.stringify({
    root: "r",
    elements: {
      r: { type: "Stack", props: {}, children: ["name", "schedule", "note"] },
      name: {
        type: "DecisionCard",
        props: {
          id: "name",
          title: "Bramble name",
          context: "Discuss a name; no rename is performed.",
          options: [
            { id: "birch", label: "Birch", consequence: "Discuss Birch" },
            { id: "elm", label: "Elm" },
          ],
          allowOther: true,
        },
      },
      schedule: {
        type: "DecisionCard",
        props: {
          id: "schedule",
          title: "Bramble timing",
          required: false,
          options: [
            { id: "soon", label: "Soon" },
            { id: "later", label: "Later" },
          ],
        },
      },
      note: { type: "Form", props: { title: "Bramble notes", fields: [{ id: "detail", label: "Anything else?", kind: "text" }], submit: { label: "Reply" } } },
    },
  }) +
  "\n```";
