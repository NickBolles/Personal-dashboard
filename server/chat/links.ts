import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { isLocalSession } from "@/lib/assistant";
import { sessionAccess } from "@/integrations/hermes/service";
import { localSessionDetail } from "@/server/assistant/local";
import { resolveGithubRef } from "@/server/work/github-search";
import { classifyUrl, linkFallbackTitle, type ExtractedLink, type LinkKind } from "@/lib/chat-links";
import { isFinanceContext } from "@/lib/chat-context";

export type PanelLink = {
  url: string;
  kind: LinkKind;
  domain: string;
  title: string;
  slug?: string;
  repo?: string;
  number?: number;
  ghType?: "pull" | "issue";
  state?: string | null;
  pinned: boolean;
  source?: string | null;
  firstSeenAt?: string | null;
};

const db = () => getDb();
const MAX_PER_SESSION = 300;
const RESOLVE_PER_CALL = 6;

function access(user: CurrentUser, sessionId: string): "read" | "write" {
  if (isLocalSession(sessionId)) {
    const d = localSessionDetail(user, sessionId); // throws 404 without access
    return d.session.readOnly ? "read" : "write";
  }
  const a = sessionAccess(user, sessionId);
  if (!a) throw new HttpError(404, "session_not_found", "Conversation not found");
  return a;
}

function toPanel(r: typeof schema.conversationLinks.$inferSelect): PanelLink {
  const c = classifyUrl(r.url);
  const base = c ?? { url: r.url, kind: r.kind as LinkKind, domain: "" };
  return {
    ...base,
    kind: r.kind as LinkKind,
    title: r.title || linkFallbackTitle(base),
    state: r.state,
    pinned: r.pinned,
    source: r.source,
    firstSeenAt: r.firstSeenAt,
  };
}

function rows(sessionId: string) {
  return db().select().from(schema.conversationLinks).where(eq(schema.conversationLinks.sessionId, sessionId)).all();
}

function sorted(list: (typeof schema.conversationLinks.$inferSelect)[]): PanelLink[] {
  return list
    .filter((r) => !r.removed)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.firstSeenAt ?? a.createdAt).localeCompare(b.firstSeenAt ?? b.createdAt))
    .map(toPanel);
}

/** Artifact slugs → readable title ("jarvis-chat-context-20261030" → "Jarvis chat context · 2026-10-30"). */
export function artifactTitle(slug: string) {
  const m = slug.match(/^(.*?)-?(\d{4})(\d{2})(\d{2})$/);
  const words = (m ? m[1] : slug).replace(/[-_.]+/g, " ").trim();
  const t = words ? words[0]!.toUpperCase() + words.slice(1) : slug;
  return m ? `${t} · ${m[2]}-${m[3]}-${m[4]}` : t;
}

export function listPanelLinks(user: CurrentUser, sessionId: string): PanelLink[] {
  access(user, sessionId);
  return sorted(rows(sessionId));
}

/**
 * Record links seen in the transcript (idempotent; removed links stay removed),
 * resolve a few titles/states per call (GitHub read-only), return the panel.
 */
export async function syncPanelLinks(user: CurrentUser & Parameters<typeof resolveGithubRef>[0], sessionId: string, seen: ExtractedLink[]) {
  const a = access(user, sessionId);
  const existing = new Map(rows(sessionId).map((r) => [r.url, r]));
  if (a === "write") {
    const fresh = seen
      .map((l) => ({ l, c: classifyUrl(l.url) }))
      .filter(
        (x): x is { l: ExtractedLink; c: NonNullable<ReturnType<typeof classifyUrl>> } =>
          !!x.c && !existing.has(x.c.url) && !isFinanceContext({ url: x.c.url }),
      )
      .slice(0, Math.max(0, MAX_PER_SESSION - existing.size));
    for (const { l, c } of fresh) {
      const row = {
        sessionId,
        url: c.url,
        kind: c.kind,
        title: c.kind === "artifact" && c.slug ? artifactTitle(c.slug) : null,
        source: l.source,
        firstSeenAt: l.firstSeenAt ?? new Date().toISOString(),
      };
      db().insert(schema.conversationLinks).values(row).onConflictDoNothing().run();
      existing.set(c.url, { ...row, state: null, pinned: false, removed: false, resolvedAt: null, createdAt: new Date().toISOString() } as never);
    }
    const pending = [...existing.values()].filter((r) => r.kind === "github" && !r.resolvedAt && !r.removed).slice(0, RESOLVE_PER_CALL);
    await Promise.all(
      pending.map(async (r) => {
        const c = classifyUrl(r.url);
        if (!c?.repo || !c.number) return;
        const g = await resolveGithubRef(user, `${c.repo}#${c.number}`).catch(() => null);
        // GitHub down, rate-limited or no token yet: leave resolvedAt unset so a later call retries.
        if (!g) return;
        db()
          .update(schema.conversationLinks)
          .set({ title: g.title ?? null, state: g.state ?? null, resolvedAt: new Date().toISOString() })
          .where(and(eq(schema.conversationLinks.sessionId, sessionId), eq(schema.conversationLinks.url, r.url)))
          .run();
      }),
    );
  }
  return sorted(rows(sessionId));
}

export function patchPanelLink(user: CurrentUser, sessionId: string, url: string, patch: { pinned?: boolean; removed?: boolean }) {
  if (access(user, sessionId) !== "write") throw new HttpError(403, "read_only", "This conversation is read-only.");
  const c = classifyUrl(url);
  if (!c) throw new HttpError(400, "bad_url", "Not a link");
  const res = db()
    .update(schema.conversationLinks)
    .set(patch)
    .where(and(eq(schema.conversationLinks.sessionId, sessionId), eq(schema.conversationLinks.url, c.url)))
    .run();
  if (!res.changes) throw new HttpError(404, "link_not_found", "Link not found");
  return sorted(rows(sessionId));
}
