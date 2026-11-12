import type { Page } from "@playwright/test";
import type { DynamicCard } from "@/lib/jarvis-ui/dynamic";
import type { JarvisSpec } from "@/lib/jarvis-ui/catalog";
import type { AppliedEntry, SurfaceView } from "@/lib/jarvis-ui/types";
import { chatVisual } from "./chat-alerts";

const day = "2026-11-06";
export const prismMatrix = {
  title: "Prismv2 routing choice",
  ref: "item:prism",
  criteria: [
    { id: "speed", label: "Speed", weight: 1 },
    { id: "quality", label: "Quality", weight: 2 },
  ],
  options: [
    { id: "patch", label: "Patch Prismv2", scores: { speed: 5, quality: 2 } },
    { id: "replace", label: "Replace Prismv2", scores: { speed: 1, quality: 5 } },
  ],
};
export const prismCharts: JarvisSpec = {
  v: 1,
  catalog: "jarvis-ui@1",
  root: "r",
  elements: {
    r: { type: "Stack", props: {}, children: ["matrix", "gantt", "bars"] },
    matrix: { type: "DecisionMatrix", props: prismMatrix },
    gantt: {
      type: "Gantt",
      props: {
        title: "Prismv2 project dates",
        rows: [{ ref: "item:prism" }, { ref: "item:prismdone", milestone: true }],
        from: "2026-11-01",
        to: "2026-11-20",
      },
    },
    bars: { type: "BarChart", props: { metric: "metric:items_done_14d", label: "Prismv2 completions" } },
  },
};
export const prismWeekly: DynamicCard = {
  id: "weekly-review:prismv2",
  kind: "weekly-review",
  line: { tone: "warn", dot: "yellow", icon: "≡", label: "Weekly review", text: "4 questions · about 4 min" },
  action: "Fill in",
  sessionId: "dynamic:weekly-review:prismv2",
  blockIndex: 0,
  spec: {
    v: 1,
    catalog: "jarvis-ui@1",
    root: "r",
    elements: {
      r: {
        type: "Form",
        props: {
          title: "Prismv2 weekly review",
          fields: [
            { id: "rating", label: "How did the week go?", kind: "scale", required: true },
            { id: "wins", label: "Wins", kind: "textarea", proposed: "Prismv2 shipped the dry-run" },
            {
              id: "slipped",
              label: "What slipped?",
              kind: "choice",
              options: [
                { value: "none", label: "Nothing slipped" },
                { value: "prism", label: "Prismv2 release notes" },
              ],
            },
            { id: "next", label: "Top 3 for next week", kind: "textarea", required: true },
            { id: "parent", label: "Create under", kind: "choice", required: true, options: [{ value: "item:prism", label: "Prismv2 workshop" }] },
          ],
          submit: { label: "Submit", creates: [{ parentField: "parent", parentRefs: ["item:prism"], titleField: "next", splitLines: true, maxItems: 3 }] },
        },
      },
    },
  },
};
export async function stubPrismV2(page: Page, cards: DynamicCard[] = [prismWeekly]) {
  let view: SurfaceView = { id: "uis_prismv2fixture", specHash: "a".repeat(64), state: {}, applied: [], readOnly: false };
  await page.route("**/api/smart/settings", (r) => r.fulfill({ json: { enabled: true, calendarWrites: false } }));
  await page.route("**/api/smart/dynamic", (r) => r.fulfill({ json: { cards, today: day } }));
  await page.route("**/api/smart/surfaces", (r) => r.fulfill({ json: view }));
  await page.route("**/api/smart/surfaces/*/state", async (r) => {
    view = { ...view, state: r.request().postDataJSON().state };
    await r.fulfill({ json: view });
  });
  await page.route("**/api/smart/hydrate", (r) =>
    r.fulfill({
      json: {
        today: day,
        refs: {
          "item:prism": { ref: "item:prism", kind: "item", title: "Prismv2 workshop", status: "in_progress", due: "2026-11-05", createdDate: "2026-11-01" },
          "item:prismdone": {
            ref: "item:prismdone",
            kind: "item",
            title: "Prismv2 verified milestone",
            status: "settled",
            due: "2026-11-08",
            createdDate: "2026-11-02",
            done: true,
          },
          "metric:items_done_14d": {
            ref: "metric:items_done_14d",
            kind: "metric",
            label: "Done",
            unit: "count",
            note: "from Jarvis work items",
            series: [
              { label: "M", value: 2 },
              { label: "T", value: 4 },
              { label: "W", value: 3 },
              { label: "T", value: 1 },
              { label: "F", value: 5 },
            ],
          },
        },
      },
    }),
  );
  await page.route("**/api/smart/apply", async (r) => {
    const body = r.request().postDataJSON();
    const applied: AppliedEntry[] = body.intents.map((intent: unknown, i: number) => ({
      intent,
      intentHash: String(i + 1).padStart(32, "0"),
      ok: true,
      message: "Updated",
      at: `${day}T18:00:00Z`,
      key: body.idempotencyKey,
      undo: { type: "item" },
    }));
    view = { ...view, applied };
    await r.fulfill({ json: { results: applied.map(({ intentHash, ok, message }) => ({ intentHash, ok, message })), surface: view } });
  });
  await page.route("**/api/smart/undo", async (r) => {
    const body = r.request().postDataJSON();
    view = { ...view, applied: view.applied.map((e) => (e.intentHash === body.intentHash ? { ...e, undone: true } : e)) };
    await r.fulfill({ json: { ok: true, message: "Undone", surface: view } });
  });
  await page.route("**/api/work/decisions*", (r) => r.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (r) => r.fulfill({ json: { items: {}, active: [] } }));
  // A newly quiet or failed run, or an open decision, outranks a smart card for the tray and the rail's line.
  // Runs left by earlier specs go quiet 30 minutes into a full run, so these two sources are pinned empty too.
  const never = { chat: null, needs: null, running: null, changes: null, context: null };
  await page.route("**/api/coordinator/runs", (r) => r.fulfill({ json: { runs: [], events: [], lastLooked: never } }));
  await page.route("**/api/coordinator/decisions*", (r) => r.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  await page.route("**/api/work/activity**", (r) => r.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route("**/api/work/items*", (r) => r.fulfill({ json: { items: [], linkedConversations: [] } }));
  await page.route("**/api/work/coordinator/global", (r) => r.fulfill({ json: { area: null } }));
  await page.route("**/api/quick-actions**", (r) => r.fulfill({ json: { actions: [] } }));
  return () => view;
}
export async function openPrismChat(page: Page) {
  const session = { ...chatVisual.session, id: "sess_prismv2", title: "Prismv2 catalog exercise" };
  await page.route("**/api/hermes/sessions**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith("/area")) return r.fulfill({ json: { enabled: false } });
    if (path.endsWith("/execution"))
      return r.fulfill({ json: { sessionId: session.id, parent: null, records: [], sources: [], fetchedAt: `${day}T18:00:00Z` } });
    if (path.endsWith("/files") || path.endsWith("/links-panel")) return r.fulfill({ json: { files: [], links: [] } });
    if (path === "/api/hermes/sessions") return r.fulfill({ json: { sessions: [session], nextOffset: null } });
    return r.fulfill({
      json: {
        ...chatVisual,
        session,
        timeline: [
          {
            kind: "assistant",
            id: "prismv2-catalog",
            text: `Compare the Prismv2 routes.\n\n\`\`\`jarvis-ui\n${JSON.stringify(prismCharts)}\n\`\`\``,
            at: `${day}T18:00:00Z`,
          },
        ],
      },
    });
  });
  await page.goto("/chat/sess_prismv2");
}
