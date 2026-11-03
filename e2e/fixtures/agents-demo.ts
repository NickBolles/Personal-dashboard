/** Work from Jarvis batch 2 fixtures: agent runs on the map demo items + the Jarvis area coordinator. */
const at = "2026-11-02T15:00:00.000Z";

const prOpen = { ref: "NickBolles/Personal-dashboard#170", url: "https://github.com/NickBolles/Personal-dashboard/pull/170", title: "Work from Jarvis 1" };

export const agentRunsDemo = {
  items: {
    mi_map: {
      itemId: "mi_map",
      areaId: "ma_j",
      title: "Map overview + rollups",
      who: { kind: "agent", name: "devchief" },
      live: "running",
      liveAt: at,
      sessionId: "sess_demo",
      runs: 2,
      prs: [{ ...prOpen, state: "open", checks: "pending", deploy: null }],
      report: null,
      progress: { done: 2, total: 3 },
    },
    mi_dec: {
      itemId: "mi_dec",
      areaId: "ma_j",
      title: "Decisions inbox",
      who: { kind: "coordinator", name: "devchief" },
      live: "waiting",
      liveAt: at,
      sessionId: "sess_demo",
      runs: 1,
      prs: [],
      report: null,
      progress: null,
    },
    mi_store: {
      itemId: "mi_store",
      areaId: "ma_c",
      title: "Store launch",
      who: { kind: "agent", name: "momentumchief" },
      live: "finished",
      liveAt: at,
      sessionId: null,
      runs: 1,
      prs: [
        {
          ...prOpen,
          ref: "o/caskfolk#12",
          url: "https://github.com/o/caskfolk/pull/12",
          title: "Store listing",
          state: "merged",
          checks: "success",
          deploy: "waiting",
        },
      ],
      report: { title: "Launch checklist", summary: "Screenshots and listing copy are ready; pricing still open.", at, href: "/areas?item=mi_store" },
      progress: null,
    },
  },
  active: [] as unknown[],
};
agentRunsDemo.active = [agentRunsDemo.items.mi_dec, agentRunsDemo.items.mi_map];

export const coordinatorDemo = {
  area: { id: "ma_j", title: "Jarvis" },
  agent: { requested: "devchief", profile: "devchief", routed: true, reason: "routed", from: { id: "ma_j", title: "Jarvis" } },
  sessionId: null,
  sessionTitle: null,
  excluded: false,
  prompt:
    "Catch me up on the \"Jarvis\" area.\nUsing what you know and the snapshot below, tell me in a few bullets: what moved, what's stuck, what needs my decision, and what you suggest next. Don't start any work yet.\n\nOpen items (3):\n- Map overview + rollups [In flight]\n- Decisions inbox [Blocked on you]\n- Import a map snapshot [Backlog]",
  lastRunAt: null,
};
