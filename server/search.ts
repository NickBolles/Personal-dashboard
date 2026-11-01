import "server-only";
import { can, type Capable } from "@/server/access";
import { homeSelection, cachedSource, scopeResult, sourceVisible } from "@/server/sources";
import { isConfigured } from "@/integrations/store";
import { listDevices } from "@/integrations/home-assistant/devices";
import { listPeople } from "@/server/people";
import type { CurrentUser } from "@/server/auth";
import { matchScore, type SearchResponse, type SearchResult } from "@/lib/search";
import { MODULES, ROLE_LABELS } from "@/lib/modules";
import { listAccounts as financeAccounts } from "@/server/finance/accounts";
import { listFunds } from "@/server/finance/funds";
import { listCheckins } from "@/server/finance/checkins";
import { listYears, revisionsFor } from "@/server/finance/plan";
import { getDb, schema } from "@/server/db";
import { monthName } from "@/server/finance/common";
import { listItems as listWorkItems } from "@/server/work/store";
import { STATUS_LABELS } from "@/lib/work";
import { chatEntries, itemsFor, memo, pathIndex } from "@/server/search-index";

/** Cache-key fingerprint of the person's effective capabilities: a revoked grant must never be served from a cached card list. */
function capsKey(user: CurrentUser): string {
  return [...user.capabilities].sort().join(",");
}

/**
 * One search across every module the person can see. Each provider is gated
 * by a capability and bounded in time: a slow upstream drops out of the
 * results (reported in `partial`) instead of holding the whole search.
 */
export type SearchProvider = {
  id: string;
  label: string;
  visible: (user: CurrentUser) => boolean;
  search: (q: string, user: CurrentUser) => Promise<SearchResult[]> | SearchResult[];
};

const TIMEOUT_MS = 2500;
const PER_PROVIDER = 8;

const SETTINGS_PAGES = [
  { href: "/settings", title: "Settings", keywords: "preferences name timezone passcode theme", admin: false },
  { href: "/settings/notifications", title: "Notification settings", keywords: "push quiet hours alerts categories", admin: false },
  { href: "/settings/home", title: "Home priorities", keywords: "ranking feedback snooze suggestions birthdays saved dates tune", admin: false },
  { href: "/settings/phones", title: "Phones", keywords: "android app pair device firebase", admin: false },
  { href: "/settings/people", title: "People", keywords: "family wife kids tablet invite roles access", admin: true },
  { href: "/settings/connections", title: "Connections", keywords: "integrations hermes home assistant skylight google todos paperclip", admin: true },
  { href: "/settings/activity", title: "Activity log", keywords: "audit history", admin: true },
];

const providers: SearchProvider[] = [
  {
    id: "pages",
    label: "Pages",
    visible: () => true,
    search: (q, user) => [
      ...MODULES.filter((m) => can(user, m.viewCapability) || m.capabilities.some((c) => can(user, c.id))).flatMap((m) =>
        m.routes.map((r) => ({
          id: `page:${r.href}`,
          kind: "page" as const,
          module: m.id,
          title: r.label,
          subtitle: m.description,
          href: r.href,
          _s: matchScore(q, r.label, m.label, m.description),
        })),
      ),
      ...SETTINGS_PAGES.filter((p) => !p.admin || can(user, "admin")).map((p) => ({
        id: `page:${p.href}`,
        kind: "setting" as const,
        module: "jarvis",
        title: p.title,
        href: p.href,
        _s: matchScore(q, p.title, p.keywords),
      })),
    ],
  },
  {
    id: "actions",
    label: "Home",
    visible: () => true,
    search: async (q, user) => {
      // The whole ranked list, not just Home's budgeted preview: backlog items stay findable.
      // Cached per person (stale-while-revalidate): ranking every card on each keystroke was the palette's other cost.
      const all = await memo(`home:${user.id}:${capsKey(user)}`, 20_000, async () => {
        const { attention: h } = await homeSelection(user, { live: false });
        return [...h.now, ...h.today, ...h.upcoming, ...h.backlog, ...h.waiting];
      });
      return all.map((a) => ({
        id: `action:${a.id}`,
        kind: "action" as const,
        module: MODULES.find((m) => (m.sources as string[]).includes(a.source))?.id ?? a.source,
        title: a.title,
        subtitle: a.detail,
        href: a.href,
        _s: matchScore(q, a.title, a.detail),
      }));
    },
  },
  {
    id: "events",
    label: "Calendar",
    visible: (u) => can(u, "skylight.view") || can(u, "home_assistant.calendar"),
    search: (q, user) =>
      (["skylight", "home_assistant"] as const)
        .filter((s) => sourceVisible(user, s))
        .flatMap((s) => scopeResult(user, cachedSource(s))?.data?.events ?? [])
        .map((e) => ({
          id: `event:${e.source}:${e.id}`,
          kind: "event" as const,
          module: e.source,
          title: e.title,
          subtitle: [
            e.allDay
              ? e.startsAt
              : new Date(e.startsAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
            e.location,
          ]
            .filter(Boolean)
            .join(" · "),
          href: e.source === "skylight" ? "/skylight" : "/home-control",
          _s: matchScore(q, e.title, e.location, e.calendar),
        })),
  },
  {
    id: "conversations",
    label: "Conversations",
    visible: (u) => can(u, "hermes.chat"),
    // The cached conversation index + filed conversation nodes: never a live Hermes call per keystroke.
    search: (q, user) =>
      chatEntries(user, can(user, "work.use") ? itemsFor(user.id) : []).map((c) => ({
        id: `conversation:${c.sessionId}`,
        kind: "conversation" as const,
        module: "hermes",
        group: "Chats & notes",
        title: c.title,
        subtitle: [c.path, c.preview].filter(Boolean).join(" · ").slice(0, 160) || undefined,
        href: `/chat/${encodeURIComponent(c.sessionId)}`,
        updatedAt: c.lastActiveAt,
        _s: matchScore(q, c.title, c.preview, c.path) * (c.archived ? 0.5 : 1),
      })),
  },
  {
    id: "devices",
    label: "Home devices",
    visible: (u) => (can(u, "home_assistant.view") || can(u, "home_assistant.cameras")) && isConfigured("home_assistant"),
    search: async (q, user) => {
      const d = await memo(`devices:${user.id}:${capsKey(user)}`, 30_000, () =>
        listDevices({
          doors: can(user, "home_assistant.view"),
          lights: can(user, "home_assistant.view"),
          cameras: can(user, "home_assistant.cameras"),
          doorControls: false,
          lightControls: false,
        }),
      );
      return [...d.doors, ...d.lights, ...d.cameras].map((x) => ({
        id: `device:${x.entityId}`,
        kind: "device" as const,
        module: "home_assistant",
        title: x.name,
        subtitle: x.kind === "camera" ? "Camera" : `${x.kind} · ${x.state}`,
        href: `/home-control?entity=${encodeURIComponent(x.entityId)}`,
        _s: matchScore(q, x.name, x.entityId, x.kind),
      }));
    },
  },
  {
    id: "finance",
    label: "Finance",
    visible: (u) => can(u, "finance.view"),
    // Names only: search results never show amounts.
    search: (q) => [
      ...financeAccounts().map((a) => ({
        id: `finance:account:${a.id}`,
        kind: "finance" as const,
        module: "finance",
        title: a.name,
        subtitle: "Account",
        href: "/finance/accounts",
        _s: matchScore(q, a.name, a.kind),
      })),
      ...listFunds().map((f) => ({
        id: `finance:fund:${f.id}`,
        kind: "finance" as const,
        module: "finance",
        title: f.name,
        subtitle: "Fund",
        href: "/finance/funds",
        _s: matchScore(q, f.name, "fund"),
      })),
      ...listCheckins().map((c) => ({
        id: `finance:checkin:${c.id}`,
        kind: "finance" as const,
        module: "finance",
        title: `${monthName(c.month)} ${c.month.slice(0, 4)} check-in`,
        subtitle: c.status === "closed" ? "Closed" : "Draft",
        href: `/finance/checkin/${c.id}`,
        _s: matchScore(q, `${monthName(c.month)} ${c.month} check-in budget review`),
      })),
      ...getDb()
        .select()
        .from(schema.finEvents)
        .all()
        .map((e) => ({
          id: `finance:event:${e.id}`,
          kind: "finance" as const,
          module: "finance",
          title: e.label,
          subtitle: `Plan ${e.year}`,
          href: `/finance/plan?year=${e.year}`,
          _s: matchScore(q, e.label, e.kind),
        })),
      ...listYears().flatMap((y) =>
        revisionsFor(y.year).map((r) => ({
          id: `finance:rev:${r.id}`,
          kind: "finance" as const,
          module: "finance",
          title: `${r.year} plan: ${r.name}`,
          subtitle: r.kind,
          href: `/finance/plan?year=${r.year}&revision=${r.id}`,
          _s: matchScore(q, r.name, r.changeNote, "plan revision"),
        })),
      ),
    ],
  },
  {
    id: "work",
    label: "Work",
    visible: (u) => can(u, "work.use"),
    search: (q, user) => {
      const items = itemsFor(user.id);
      const p = pathIndex(items);
      return (
        items
          // Conversation nodes are found by the Conversations provider (no duplicates).
          .filter((i) => !i.builtIn && i.kind !== "conversation")
          .map((i) => ({
            id: `work:${i.id}`,
            kind: "work" as const,
            module: "work",
            group: i.parentId === null ? "Areas" : i.kind === "project" ? "Projects" : "Items",
            updatedAt: i.updatedAt,
            title: i.title,
            subtitle: [STATUS_LABELS[i.status], i.nextAction ? `Next: ${i.nextAction}` : i.summary].filter(Boolean).join(" · ").slice(0, 160),
            href: `/areas?item=${encodeURIComponent(i.id)}`,
            _s: matchScore(q, i.title, i.summary, i.nextAction, p.path(i.id)),
          }))
      );
    },
  },
  {
    id: "people",
    label: "People",
    visible: (u) => can(u, "admin"),
    search: (q) =>
      listPeople().map((p) => ({
        id: `person:${p.id}`,
        kind: "person" as const,
        module: "jarvis",
        title: p.name,
        subtitle: ROLE_LABELS[p.role].label,
        href: `/settings/people#${p.id}`,
        _s: matchScore(q, p.name, p.username),
      })),
  },
];

/** Modules add their own (finance, home devices…). */
export function registerSearchProvider(p: SearchProvider) {
  const i = providers.findIndex((x) => x.id === p.id);
  if (i >= 0) providers[i] = p;
  else providers.push(p);
}

function bounded<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref?.())]);
}

type Scored = SearchResult & { _s: number; updatedAt?: string };

const GROUP_BY_KIND: Record<SearchResult["kind"], string> = {
  page: "Pages",
  setting: "Settings",
  action: "Home",
  event: "Calendar",
  conversation: "Chats & notes",
  device: "Devices",
  person: "People",
  finance: "Finance",
  work: "Items",
};

/** Empty query: your most recent chats and items (the palette shows them the moment it opens). */
function recent(user: CurrentUser & Capable): SearchResult[] {
  const out: SearchResult[] = [];
  const items = can(user, "work.use") ? listWorkItems(user.id) : [];
  if (can(user, "hermes.chat"))
    for (const c of chatEntries(user, items)
      .filter((c) => !c.archived)
      .slice(0, 5))
      out.push({
        id: `conversation:${c.sessionId}`,
        kind: "conversation",
        module: "hermes",
        group: "Recent",
        title: c.title,
        subtitle: c.path,
        href: `/chat/${encodeURIComponent(c.sessionId)}`,
      });
  const p = pathIndex(items);
  for (const i of items
    .filter((i) => !i.builtIn && i.kind !== "conversation" && i.parentId !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5))
    out.push({
      id: `work:${i.id}`,
      kind: "work",
      module: "work",
      group: "Recent",
      title: i.title,
      subtitle: p.path(i.id),
      href: `/areas?item=${encodeURIComponent(i.id)}`,
    });
  return out;
}

const SLOW_LOG_MS = 250;

export async function search(user: CurrentUser & Capable, query: string): Promise<SearchResponse> {
  const t0 = performance.now();
  const q = query.trim().slice(0, 100);
  if (!q) return { query: q, results: recent(user), partial: [], tookMs: Math.round(performance.now() - t0) };
  const active = providers.filter((p) => p.visible(user));
  const settled = await Promise.allSettled(active.map((p) => bounded(Promise.resolve().then(() => p.search(q, user)))));
  const partial: string[] = [];
  const results: Scored[] = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      partial.push(active[i]!.label);
      return;
    }
    const hits = (r.value as Scored[]).filter((x) => x._s > 0).sort((a, b) => b._s - a._s || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    results.push(...hits.slice(0, PER_PROVIDER));
  });
  const seen = new Set<string>();
  const tookMs = Math.round(performance.now() - t0);
  if (tookMs >= SLOW_LOG_MS) console.info(`[search] slow query: ${tookMs} ms (${q.length} chars, partial=${partial.join("|") || "none"})`);
  return {
    query: q,
    results: results
      .sort((a, b) => b._s - a._s || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .filter((r) => !seen.has(r.id) && seen.add(r.id))
      .slice(0, 40)
      .map(({ _s, updatedAt, ...r }) => ({ ...r, group: r.group ?? GROUP_BY_KIND[r.kind] })),
    partial,
    tookMs,
  };
}
