/**
 * Work hub: client-safe types, request schemas and pure helpers shared by the
 * server (server/work) and the web UI. No server imports. Rules: docs/work.md.
 */
import { z } from "zod";

export const WORK_KINDS = ["area", "project", "thread", "investigation", "note"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_STATUSES = [
  "captured",
  "exploring",
  "ready",
  "in_progress",
  "in_review",
  "awaiting_validation",
  "settled",
  "reopened",
  "on_hold",
  "superseded",
  "abandoned",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const STATUS_LABELS: Record<WorkStatus, string> = {
  captured: "Captured",
  exploring: "Exploring",
  ready: "Ready",
  in_progress: "In progress",
  in_review: "In review",
  awaiting_validation: "Awaiting validation",
  settled: "Settled",
  reopened: "Reopened",
  on_hold: "On hold",
  superseded: "Superseded",
  abandoned: "Abandoned",
};

/** Work that no longer needs attention. */
export const CLOSED_STATUSES: WorkStatus[] = ["settled", "superseded", "abandoned"];
export const isClosed = (s: string) => (CLOSED_STATUSES as string[]).includes(s);

export const LINK_KINDS = ["chat_session", "github_pr", "github_issue", "url"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export const LINK_ROLES = ["source", "implementation", "evidence", "reference"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];
export const EXTERNAL_STATES = ["open", "merged", "closed"] as const;
export type ExternalState = (typeof EXTERNAL_STATES)[number];
export const LINEAGE_RELATIONS = ["forked_from", "split_from", "moved_from", "handoff_from"] as const;
export type LineageRelation = (typeof LINEAGE_RELATIONS)[number];

export const COMPARATORS = ["<=", ">=", "<", ">", "="] as const;
export type Comparator = (typeof COMPARATORS)[number];
export const VALIDATION_STATUSES = ["pending", "pass", "fail", "waived"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const WIDGET_KINDS = [
  "priorities",
  "next_actions",
  "awaiting_validation",
  "timeline",
  "project_map",
  "metric",
  "custom_html",
  "recently_settled",
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];
export const WIDGET_LABELS: Record<WidgetKind, string> = {
  priorities: "Priorities",
  next_actions: "Next actions",
  awaiting_validation: "Awaiting validation",
  timeline: "Timeline slice",
  project_map: "Project map",
  metric: "Metric",
  custom_html: "Custom HTML",
  recently_settled: "Recently settled",
};
export const WIDGET_SIZES = ["sm", "md", "lg"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Upper bound for user-authored widget HTML (bytes of UTF-8). */
export const CUSTOM_HTML_MAX_BYTES = 100 * 1024;

// --- DTOs ---

export type WorkItem = {
  id: string;
  parentId: string | null;
  kind: WorkKind;
  title: string;
  summary: string;
  nextAction: string;
  status: WorkStatus;
  sortOrder: number;
  startDate: string | null;
  targetDate: string | null;
  completedAt: string | null;
  settledKind: "manual" | "auto" | null;
  settledReason: string | null;
  archived: boolean;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkLink = {
  id: string;
  itemId: string;
  kind: LinkKind;
  targetId: string | null;
  url: string | null;
  title: string;
  role: LinkRole;
  externalState: ExternalState | null;
  stateChangedAt: string | null;
  /** "handoff_from" when the conversation was started from this item's handoff */
  lineage: "handoff_from" | null;
  packetId: string | null;
  createdAt: string;
};

export type WorkPacket = {
  id: string;
  itemId: string;
  version: number;
  objective: string;
  inScope: string;
  outOfScope: string;
  acceptanceCriteria: string;
  decisions: string;
  openQuestions: string;
  context: string;
  validationRequired: boolean;
  noValidationReason: string | null;
  createdAt: string;
  createdBy: string;
};

export type WorkValidation = {
  id: string;
  itemId: string;
  metric: string;
  comparator: Comparator;
  threshold: number;
  unit: string;
  baseline: number | null;
  observed: number | null;
  evidenceUrl: string | null;
  notes: string | null;
  status: ValidationStatus;
  waiverReason: string | null;
  dueDate: string | null;
  recordedAt: string | null;
};

export type WorkEvent = {
  id: string;
  itemId: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  actor: string;
  at: string;
};

export type WorkLineage = {
  id: string;
  childId: string;
  parentId: string | null;
  relation: LineageRelation;
  note: string | null;
  fromParentId: string | null;
  toParentId: string | null;
  createdAt: string;
};

export type WorkDetail = {
  item: WorkItem;
  breadcrumb: { id: string; title: string }[];
  children: WorkItem[];
  links: WorkLink[];
  packets: WorkPacket[];
  validations: WorkValidation[];
  events: WorkEvent[];
  lineage: (WorkLineage & { childTitle: string | null; parentTitle: string | null })[];
  settle: { allowed: boolean; reason: string | null };
  githubRefresh: boolean;
};

export type TimelineRow = {
  id: string;
  title: string;
  kind: WorkKind;
  status: WorkStatus;
  depth: number;
  startDate: string | null;
  targetDate: string | null;
  overdue: boolean;
  validationOverdue: boolean;
  actuals: { kind: "started" | "merged" | "settled"; at: string }[];
};

export type TimelineResponse = {
  root: { id: string; title: string } | null;
  roots: { id: string; title: string; kind: WorkKind }[];
  rows: TimelineRow[];
  today: string;
};

export type WidgetItem = {
  id: string;
  title: string;
  status: WorkStatus;
  nextAction: string;
  targetDate: string | null;
  settledKind?: string | null;
  detail?: string;
};
export type MapNode = { id: string; title: string; status: WorkStatus; kind: WorkKind; children: MapNode[] };
export type WorkSnapshot = {
  generatedAt: string;
  root: string | null;
  items: { title: string; kind: WorkKind; status: WorkStatus; depth: number; startDate: string | null; targetDate: string | null; nextAction: string }[];
};

export type WidgetConfig = {
  rootId?: string | null;
  value?: string;
  label?: string;
  target?: string;
  href?: string;
  html?: string;
  injectData?: boolean;
};

export type WidgetData =
  | { kind: "items"; items: WidgetItem[] }
  | { kind: "timeline"; rows: TimelineRow[]; today: string }
  | { kind: "map"; root: MapNode | null }
  | { kind: "metric" }
  | { kind: "custom_html"; snapshot: WorkSnapshot | null };

export type DashboardWidget = { id: string; kind: WidgetKind; title: string; size: WidgetSize; position: number; config: WidgetConfig; data: WidgetData };
export type DashboardResponse = { id: string; title: string; widgets: DashboardWidget[]; areas: { id: string; title: string; kind: WorkKind }[] };

// --- request schemas ---

const title = z.string().trim().min(1, "Title is required").max(200);
const longText = z.string().max(20_000);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T12:00:00Z`);
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, "Use a real calendar date");
const id = z.string().min(1).max(80);

export const createItemSchema = z
  .object({
    parentId: id.nullable().optional(),
    kind: z.enum(WORK_KINDS),
    title,
    summary: longText.optional(),
    nextAction: z.string().max(2000).optional(),
    startDate: dateSchema.nullable().optional(),
    targetDate: dateSchema.nullable().optional(),
  })
  .strict();

export const updateItemSchema = z
  .object({
    title: title.optional(),
    summary: longText.optional(),
    nextAction: z.string().max(2000).optional(),
    kind: z.enum(WORK_KINDS).optional(),
    status: z.enum(WORK_STATUSES).optional(),
    reason: z.string().max(2000).optional(),
    startDate: dateSchema.nullable().optional(),
    targetDate: dateSchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const moveSchema = z.object({ parentId: id.nullable() }).strict();
export const reorderSchema = z.object({ direction: z.enum(["up", "down"]) }).strict();
export const forkSchema = z.object({ title: title.optional() }).strict();
export const splitSchema = z.object({ title, summary: longText.optional(), kind: z.enum(WORK_KINDS).optional() }).strict();

export const packetSchema = z
  .object({
    objective: z.string().trim().min(1, "Objective is required").max(4000),
    inScope: longText.default(""),
    outOfScope: longText.default(""),
    acceptanceCriteria: longText.default(""),
    decisions: longText.default(""),
    openQuestions: longText.default(""),
    context: longText.default(""),
    validationRequired: z.boolean().default(true),
    noValidationReason: z.string().max(2000).optional(),
    nextAction: z.string().trim().min(1, "Next action is required").max(2000),
    status: z.enum(["ready", "in_progress"]).default("in_progress"),
  })
  .strict()
  .refine((p) => p.validationRequired || !!p.noValidationReason?.trim(), { path: ["noValidationReason"], message: "Say why no validation is needed" });

export const linkSchema = z
  .object({
    kind: z.enum(LINK_KINDS),
    url: z.string().trim().max(2000).optional(),
    targetId: z.string().trim().max(200).optional(),
    title: z.string().trim().max(300).optional(),
    role: z.enum(LINK_ROLES).optional(),
  })
  .strict();

/** "Continue in new conversation": which assistant answers (default: the household setting). */
export const continueSchema = z.object({ backend: z.enum(["hermes", "claude"]).optional() }).strict();

export const linkStateSchema = z.object({ externalState: z.enum(EXTERNAL_STATES) }).strict();

const num = z.number().finite();
export const validationSchema = z
  .object({
    metric: z.string().trim().min(1, "Metric is required").max(200),
    comparator: z.enum(COMPARATORS),
    threshold: num,
    unit: z.string().trim().max(40).default(""),
    baseline: num.nullable().optional(),
    dueDate: dateSchema.nullable().optional(),
  })
  .strict();

export const validationUpdateSchema = z
  .object({
    metric: z.string().trim().min(1).max(200).optional(),
    comparator: z.enum(COMPARATORS).optional(),
    threshold: num.optional(),
    unit: z.string().trim().max(40).optional(),
    baseline: num.nullable().optional(),
    dueDate: dateSchema.nullable().optional(),
    observed: num.nullable().optional(),
    evidenceUrl: z.string().trim().max(2000).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    waive: z.boolean().optional(),
    waiverReason: z.string().max(2000).optional(),
  })
  .strict()
  .refine((v) => !v.waive || !!v.waiverReason?.trim(), { path: ["waiverReason"], message: "A waiver needs a reason" });

export const settleSchema = z.object({ reason: z.string().trim().max(2000).optional() }).strict();
export const reopenSchema = z
  .object({ reason: z.string().trim().min(1, "Say why it's reopening").max(2000), followUpTitle: z.string().trim().max(200).optional() })
  .strict();

const widgetConfigSchema = z
  .object({
    rootId: id.nullable().optional(),
    value: z.string().max(80).optional(),
    label: z.string().max(120).optional(),
    target: z.string().max(80).optional(),
    href: z.string().max(2000).optional(),
    html: z.string().optional(),
    injectData: z.boolean().optional(),
  })
  .strict()
  .refine((c) => c.html === undefined || utf8Bytes(c.html) <= CUSTOM_HTML_MAX_BYTES, { path: ["html"], message: "Custom HTML is limited to 100 KB" })
  .refine((c) => !c.href || safeHref(c.href) !== null, { path: ["href"], message: "Links must be http(s) or a Jarvis path" });

export const widgetCreateSchema = z
  .object({
    kind: z.enum(WIDGET_KINDS),
    title: z.string().trim().max(120).optional(),
    size: z.enum(WIDGET_SIZES).optional(),
    config: widgetConfigSchema.optional(),
  })
  .strict();
export const widgetUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    size: z.enum(WIDGET_SIZES).optional(),
    config: widgetConfigSchema.optional(),
    direction: z.enum(["up", "down"]).optional(),
  })
  .strict();

// --- pure helpers ---

export function utf8Bytes(s: string) {
  return new TextEncoder().encode(s).length;
}

/** http(s) URLs and same-origin absolute paths only; anything else (javascript:, data:) is refused. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^\/(?!\/)/.test(h)) return h;
  try {
    const u = new URL(h);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export type PrRef = { owner: string; repo: string; number: number; kind: "pull" | "issues"; url: string };

/** https://github.com/{owner}/{repo}/pull/{n} (or /issues/{n}) → parts; null when it isn't one. */
export function parseGithubUrl(input: string): PrRef | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.hostname !== "github.com" && u.hostname !== "www.github.com")) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(pull|issues)\/(\d{1,9})(?:\/.*)?$/);
  if (!m) return null;
  const [, owner, repo, kind, n] = m;
  const number = Number(n);
  if (!number) return null;
  return { owner: owner!, repo: repo!, number, kind: kind as "pull" | "issues", url: `https://github.com/${owner}/${repo}/${kind}/${number}` };
}

export function parsePrUrl(input: string): PrRef | null {
  const r = parseGithubUrl(input);
  return r?.kind === "pull" ? r : null;
}

/** Does `observed` satisfy `comparator threshold`? */
export function comparatorPasses(comparator: Comparator, observed: number, threshold: number) {
  switch (comparator) {
    case "<=":
      return observed <= threshold;
    case ">=":
      return observed >= threshold;
    case "<":
      return observed < threshold;
    case ">":
      return observed > threshold;
    case "=":
      return Math.abs(observed - threshold) <= 1e-9 * Math.max(1, Math.abs(threshold));
  }
}

export const CUSTOM_WIDGET_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:";
/** The only sandbox tokens a custom widget iframe ever gets: scripts, but an opaque origin (no allow-same-origin). */
export const CUSTOM_WIDGET_SANDBOX = "allow-scripts";

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The srcdoc for a custom HTML widget. The CSP meta comes first so it governs
 * everything the author wrote (later meta tags can only tighten it). Rendered
 * only inside <iframe sandbox="allow-scripts">: opaque origin, no cookies, no
 * storage, no Jarvis APIs (connect-src falls back to 'none').
 */
export function buildCustomWidgetSrcdoc(html: string) {
  if (utf8Bytes(html) > CUSTOM_HTML_MAX_BYTES) throw new Error("Custom HTML is limited to 100 KB");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CUSTOM_WIDGET_CSP)}">`,
    '<meta name="referrer" content="no-referrer">',
    "<style>html,body{margin:0;padding:8px;font:14px system-ui,sans-serif;}</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

export const SNAPSHOT_MESSAGE_TYPE = "jarvis.work.snapshot";

function bullets(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
  return lines.length ? lines.map((l) => `- ${l}`).join("\n") : "- (none)";
}

/** Markdown handoff packet for pasting into Hermes / Discord. */
export function handoffMarkdown(d: Pick<WorkDetail, "item" | "breadcrumb" | "packets" | "links" | "validations">, origin = "") {
  const p = d.packets[0];
  const lines = [
    `# Handoff: ${d.item.title}`,
    "",
    `**Where:** ${[...d.breadcrumb.map((b) => b.title), d.item.title].join(" › ")}`,
    `**State:** ${STATUS_LABELS[d.item.status]}${p ? ` · packet v${p.version}` : ""}`,
    "",
    "## Objective",
    p?.objective || d.item.summary || "(not set)",
  ];
  if (p?.inScope) lines.push("", "## In scope", bullets(p.inScope));
  if (p?.outOfScope) lines.push("", "## Out of scope", bullets(p.outOfScope));
  if (p?.acceptanceCriteria) lines.push("", "## Acceptance criteria", bullets(p.acceptanceCriteria));
  lines.push("", "## Decisions", bullets(p?.decisions ?? ""));
  lines.push("", "## Open questions", bullets(p?.openQuestions ?? ""));
  if (p?.context) lines.push("", "## Context", p.context);
  lines.push("", "## Next action", d.item.nextAction || "(not set)");
  if (p) lines.push("", "## Validation", p.validationRequired ? "Required before settling." : `Not required: ${p.noValidationReason ?? ""}`);
  for (const v of d.validations) lines.push(`- ${v.metric} ${v.comparator} ${v.threshold}${v.unit ? ` ${v.unit}` : ""} — ${v.status}`);
  lines.push("", "## Links");
  if (!d.links.length) lines.push("- (none)");
  for (const l of d.links) {
    const href = l.kind === "chat_session" ? `${origin}/chat/${encodeURIComponent(l.targetId ?? "")}` : (l.url ?? "");
    lines.push(`- [${l.role}] ${l.title || l.targetId || href}${href ? ` — ${href}` : ""}${l.externalState ? ` (${l.externalState})` : ""}`);
  }
  return lines.join("\n");
}

// --- conversations: picker, unfiled inbox and deterministic filing suggestions ---

export type ConversationBackend = "hermes" | "claude";
export type ConversationOption = {
  id: string;
  title: string;
  preview: string | null;
  lastActiveAt: string | null;
  backend: ConversationBackend;
  /** someone else's shared conversation (read-only) */
  readOnly: boolean;
  /** your work items this conversation is already linked to */
  linkedItems: { id: string; title: string }[];
};
export type ConversationsResponse = { conversations: ConversationOption[]; unavailable: string[] };
export type FilingSuggestion = { id: string; title: string; path: string; matched: string[] };
export type UnfiledConversation = ConversationOption & { suggestions: FilingSuggestion[] };
export type UnfiledResponse = { conversations: UnfiledConversation[]; total: number; unavailable: string[] };

/** File a conversation under an item; `itemId: null` files it in Miscellaneous. */
export const fileConversationSchema = z
  .object({ sessionId: z.string().trim().min(1).max(200), itemId: id.nullable(), role: z.enum(LINK_ROLES).optional() })
  .strict();

const FILING_STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "about",
  "from",
  "into",
  "onto",
  "your",
  "our",
  "this",
  "that",
  "then",
  "than",
  "what",
  "how",
  "why",
  "can",
  "you",
  "new",
  "chat",
  "conversation",
  "untitled",
  "help",
  "please",
]);

/** Significant lowercase words: 3+ letters, or 2+ characters containing a digit ("v5", "q3"). */
export function filingTokens(s: string) {
  return [
    ...new Set(
      s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .split(/[^a-z0-9]+/)
        .filter((t) => (t.length >= 3 || (t.length >= 2 && /\d/.test(t))) && !FILING_STOP.has(t)),
    ),
  ];
}

/**
 * Deterministic "file under…" suggestions: items whose title shares exact
 * significant words with the conversation title. No model, no fuzzy matching.
 * Order: most shared words → fewer title words (more specific) → path → id.
 */
export function suggestFiling(
  conversationTitle: string,
  candidates: { id: string; title: string; path: string; status: WorkStatus; builtIn?: boolean }[],
  limit = 3,
): FilingSuggestion[] {
  const want = new Set(filingTokens(conversationTitle));
  if (!want.size) return [];
  return candidates
    .filter((c) => !c.builtIn && !isClosed(c.status))
    .map((c) => {
      const words = filingTokens(c.title);
      return { c, words: words.length, matched: words.filter((w) => want.has(w)) };
    })
    .filter((x) => x.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length || a.words - b.words || a.c.path.localeCompare(b.c.path) || a.c.id.localeCompare(b.c.id))
    .slice(0, limit)
    .map((x) => ({ id: x.c.id, title: x.c.title, path: x.c.path, matched: x.matched }));
}

export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
