import "server-only";
import { can, type Capable } from "@/server/access";
import { getHome, cachedSource, scopeResult, sourceVisible } from "@/server/sources";
import { listSessions } from "@/integrations/hermes/service";
import { isConfigured } from "@/integrations/store";
import { listControls } from "@/integrations/home-assistant/controls";
import { listPeople } from "@/server/people";
import type { CurrentUser } from "@/server/auth";
import { matchScore, type SearchResponse, type SearchResult } from "@/lib/search";
import { MODULES, ROLE_LABELS } from "@/lib/modules";

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
      const home = await getHome(user, { live: false });
      const all = [...home.now, ...home.later.laterToday, ...home.later.upcoming, ...home.later.waitingOn];
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
    visible: (u) => can(u, "hermes.chat") && isConfigured("hermes"),
    search: async (q, user) =>
      (await listSessions(user, { includeArchived: true })).map((s) => ({
        id: `conversation:${s.id}`,
        kind: "conversation" as const,
        module: "hermes",
        title: s.title || "Untitled conversation",
        subtitle: s.preview,
        href: `/chat/${encodeURIComponent(s.id)}`,
        _s: matchScore(q, s.title, s.preview),
      })),
  },
  {
    id: "devices",
    label: "Home devices",
    visible: (u) => can(u, "home_assistant.view") && isConfigured("home_assistant"),
    search: async (q) =>
      (await listControls()).map((c) => ({
        id: `device:${c.entityId}`,
        kind: "device" as const,
        module: "home_assistant",
        title: c.name,
        subtitle: c.state,
        href: `/home-control?entity=${encodeURIComponent(c.entityId)}`,
        _s: matchScore(q, c.name, c.entityId, c.domain),
      })),
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

type Scored = SearchResult & { _s: number };

export async function search(user: CurrentUser & Capable, query: string): Promise<SearchResponse> {
  const q = query.trim().slice(0, 100);
  if (!q) return { query: q, results: [], partial: [] };
  const active = providers.filter((p) => p.visible(user));
  const settled = await Promise.allSettled(active.map((p) => bounded(Promise.resolve().then(() => p.search(q, user)))));
  const partial: string[] = [];
  const results: Scored[] = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      partial.push(active[i]!.label);
      return;
    }
    const hits = (r.value as Scored[]).filter((x) => x._s > 0).sort((a, b) => b._s - a._s);
    results.push(...hits.slice(0, PER_PROVIDER));
  });
  const seen = new Set<string>();
  return {
    query: q,
    results: results
      .sort((a, b) => b._s - a._s)
      .filter((r) => !seen.has(r.id) && seen.add(r.id))
      .slice(0, 40)
      .map(({ _s, ...r }) => r),
    partial,
  };
}
