/**
 * Dev/demo fixture for /map and the Decisions inbox (visual specs stub the API
 * with it; never seeded into a real database). Dates are fixed: the cards mask
 * "last activity" (data-dynamic) anyway.
 */
const at = "2026-11-02T15:00:00.000Z";
const item = (o: Record<string, unknown>) => ({
  summary: "",
  nextAction: "",
  status: "captured",
  sortOrder: 0,
  startDate: null,
  targetDate: null,
  completedAt: null,
  settledKind: null,
  settledReason: null,
  archived: false,
  builtIn: false,
  validationDefault: null,
  sessionId: null,
  settings: null,
  tags: [],
  assignee: null,
  decision: null,
  createdAt: at,
  updatedAt: at,
  ...o,
});

export const mapDemoItems = [
  item({ id: "ma_j", parentId: null, kind: "area", title: "Jarvis" }),
  item({ id: "mp_wfj", parentId: "ma_j", kind: "project", title: "Work from Jarvis" }),
  item({
    id: "mi_map",
    parentId: "mp_wfj",
    kind: "thread",
    title: "Map overview + rollups",
    status: "in_progress",
    nextAction: "Push the draft PR",
    tags: ["ui"],
    assignee: "agent:devchief",
  }),
  item({
    id: "mi_dec",
    parentId: "mp_wfj",
    kind: "thread",
    title: "Decisions inbox",
    status: "ready",
    nextAction: "Pick the badge placement",
    decision: { question: "Badge on the sidebar or the phone bar?", choices: ["Sidebar", "Phone bar", "Both"], askedAt: at },
  }),
  item({ id: "mi_imp", parentId: "mp_wfj", kind: "thread", title: "Import a map snapshot", status: "exploring" }),
  item({ id: "mp_ds", parentId: "ma_j", kind: "project", title: "Design system" }),
  item({ id: "mi_ds6", parentId: "mp_ds", kind: "thread", title: "Design batch 6", status: "settled" }),
  item({ id: "mi_ds7", parentId: "mp_ds", kind: "thread", title: "Design batch 7", status: "ready_to_settle", nextAction: "Validate on the phone" }),
  item({ id: "ma_c", parentId: null, kind: "area", title: "Caskfolk" }),
  item({
    id: "mi_store",
    parentId: "ma_c",
    kind: "thread",
    title: "Store launch",
    status: "on_hold",
    nextAction: "Waiting on spend approval",
    tags: ["launch"],
  }),
  item({ id: "ma_h", parentId: null, kind: "area", title: "Home server" }),
];

export const mapDemoDecisions = {
  count: 3,
  entries: [
    {
      key: "item:mi_dec",
      kind: "item",
      title: "Decisions inbox",
      question: "Badge on the sidebar or the phone bar?",
      choices: ["Sidebar", "Phone bar", "Both"],
      href: "/areas?item=mi_dec",
      at,
      itemId: "mi_dec",
      areaTitle: "Jarvis",
      sessionId: null,
      // The decision row behind the entry (every real one has it): low-risk, with a recommendation.
      ref: "D-12",
      recommended: "Both",
      risk: [],
      pack: {},
    },
    {
      key: "approval:r1",
      kind: "approval",
      title: "Hermes needs your approval",
      question: "Run npm ci in the release clone",
      choices: [],
      href: "/chat/sess_demo",
      at,
    },
    { key: "workflow:w1", kind: "workflow", title: "Weekly review", question: "2 proposed values to accept or dismiss", choices: [], href: "/workflows", at },
  ],
};

export const mapDemo = {
  items: mapDemoItems,
  links: {
    mi_map: [
      { kind: "github_pr", url: "https://github.com/NickBolles/Personal-dashboard/pull/170", title: "Work from Jarvis 1" },
      { kind: "url", url: "https://artifacts.ai.nickbolles.com/v/portfolio-map-20261102/", title: "Portfolio board" },
    ],
    mi_ds7: [{ kind: "chat_session", url: "/chat/sess_demo", title: "Design chat" }],
  },
  relations: {
    mi_dec: [{ kind: "depends", id: "mi_map", title: "Map overview + rollups", open: true }],
    mi_imp: [{ kind: "followup", id: "mi_ds6", title: "Design batch 6", open: false }],
  },
  decisions: mapDemoDecisions,
};

/** Item detail for the "Jarvis" demo area page (project cards, tree, coordinator column/sheet). */
const areaSettings = {
  agentMode: null,
  instructions: null,
  defaultBackend: null,
  defaultModel: null,
  defaultProvider: null,
  defaultRepo: null,
  contextSources: [],
  settlePolicy: "suggest",
  quietDays: 14,
  aiPolicy: "allowed",
};
export const mapDemoAreaDetail = {
  item: mapDemoItems[0],
  breadcrumb: [],
  children: mapDemoItems.filter((i) => (i as { parentId?: string | null }).parentId === "ma_j"),
  links: [
    {
      id: "ml_coord",
      itemId: "ma_j",
      kind: "chat_session",
      role: "coordinator",
      targetId: "sess_coord",
      url: null,
      title: "Jarvis coordinator",
      createdAt: at,
    },
    { id: "ml_plan", itemId: "ma_j", kind: "chat_session", role: "context", targetId: "sess_plan", url: null, title: "Plan the areas merge", createdAt: at },
  ],
  packets: [],
  validations: [],
  events: [],
  lineage: [],
  settle: { allowed: false, reason: null },
  validationDefault: { value: "required", explicit: false, areaId: "ma_j", areaTitle: "Jarvis" },
  area: { id: "ma_j", title: "Jarvis", builtIn: false, settings: areaSettings },
  githubRefresh: false,
  blockedBy: [],
  blocking: [],
};
