import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can, type Capable } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { listSessions } from "@/server/assistant";
import { isConfigured } from "@/integrations/store";
import { listDevices } from "@/integrations/home-assistant/devices";
import { listPeople } from "@/server/people";
import { ROLE_LABELS } from "@/lib/modules";
import { matchScore } from "@/lib/search";
import { STATUS_LABELS, KIND_LABELS, parseAreaSettings, type WorkItem } from "@/lib/work";
import { REF_TYPE_LABELS, parseRefQuery, type Reference, type RefOption, type RefOptionsResponse, type RefSection, type RefType } from "@/lib/references";
import { getDetail, listItems } from "@/server/work/store";
import { searchGithubRefs, resolveGithubRef } from "@/server/work/github-search";

/**
 * Composer references (lib/references.ts): the `@` picker's options and the
 * server-side resolution of sent references into context snapshots. Every
 * option and every resolution is filtered by what the person may see; Finance
 * is never offered and never resolved (it's never sent to the AI layer).
 */

type Viewer = CurrentUser & Capable;
const TIMEOUT_MS = 4000;
const PER_SECTION = 6;

function bounded<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref?.())]);
}

function pathFor(items: WorkItem[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return (id: string) => {
    const parts: string[] = [];
    for (let c = byId.get(byId.get(id)?.parentId ?? ""); c && parts.length < 6; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title);
    return parts.join(" › ");
  };
}

function rank<T extends { _s: number; label: string }>(rows: T[], q: string) {
  return (q ? rows.filter((r) => r._s > 0).sort((a, b) => b._s - a._s) : rows).slice(0, PER_SECTION).map(({ _s, ...r }) => r as Omit<T, "_s">);
}

/** The `@` picker: typed sections (areas, work, conversations, people, devices, files & links). */
export async function referenceOptions(user: Viewer, raw: string): Promise<RefOptionsResponse> {
  const { type, q } = parseRefQuery(raw.slice(0, 100));
  const want = (t: RefType) => !type || type === t;
  const sections: RefSection[] = [];
  const partial: string[] = [];
  const work = can(user, "work.use") ? listItems(user.id) : [];
  const path = pathFor(work);

  if (want("area") && work.length) {
    const options = rank(
      work
        .filter((i) => i.parentId === null)
        .map((i) => ({ type: "area" as const, id: i.id, label: i.title, detail: "Area", _s: q ? matchScore(q, i.title) : 1 })),
      q,
    );
    if (options.length) sections.push({ type: "area", label: REF_TYPE_LABELS.area, options });
  }
  if (want("item") && work.length) {
    const rows = work
      .filter((i) => i.parentId !== null && i.kind !== "conversation")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((i) => ({
        type: "item" as const,
        id: i.id,
        label: i.title,
        detail: `${KIND_LABELS[i.kind]} · ${STATUS_LABELS[i.status]}${path(i.id) ? ` · ${path(i.id)}` : ""}`,
        _s: q ? matchScore(q, i.title, i.summary, i.nextAction) : 1,
      }));
    const options = rank(rows, q);
    if (options.length) sections.push({ type: "item", label: REF_TYPE_LABELS.item, options });
  }
  const tasks: Promise<void>[] = [];
  if (want("chat") && can(user, "hermes.chat")) {
    tasks.push(
      bounded(listSessions(user, {}))
        .then((r) => {
          if (r.unavailable.length) partial.push(...r.unavailable);
          const options = rank(
            r.sessions
              .filter((s) => !s.archived)
              .map((s) => ({
                type: "chat" as const,
                id: s.id,
                label: s.title || "Untitled conversation",
                detail: s.readOnly ? "Shared with you" : (s.preview ?? undefined)?.slice(0, 80),
                _s: q ? matchScore(q, s.title, s.preview) : 1,
              })),
            q,
          );
          if (options.length) sections.push({ type: "chat", label: REF_TYPE_LABELS.chat, options });
        })
        .catch(() => void partial.push("Conversations")),
    );
  }
  if (want("person")) {
    const options = rank(
      listPeople()
        .filter((p) => !p.disabled)
        .map((p) => ({ type: "person" as const, id: p.id, label: p.name, detail: ROLE_LABELS[p.role].label, _s: q ? matchScore(q, p.name, p.username) : 1 })),
      q,
    );
    if (options.length) sections.push({ type: "person", label: REF_TYPE_LABELS.person, options });
  }
  if (want("device") && can(user, "home_assistant.view") && isConfigured("home_assistant")) {
    tasks.push(
      bounded(listDevices({ doors: true, lights: true, cameras: false, doorControls: false, lightControls: false }))
        .then((d) => {
          const options = rank(
            [...d.doors, ...d.lights].map((x) => ({
              type: "device" as const,
              id: x.entityId,
              label: x.name,
              detail: `${x.kind} · ${x.state}`,
              _s: q ? matchScore(q, x.name, x.entityId, x.kind) : 1,
            })),
            q,
          );
          if (options.length) sections.push({ type: "device", label: REF_TYPE_LABELS.device, options });
        })
        .catch(() => void partial.push("Devices")),
    );
  }
  if (want("file") && work.length) {
    const ids = work.map((i) => i.id);
    const links = getDb()
      .select()
      .from(schema.workLinks)
      .where(and(inArray(schema.workLinks.itemId, ids), eq(schema.workLinks.kind, "url")))
      .orderBy(desc(schema.workLinks.createdAt))
      .limit(200)
      .all();
    const byId = new Map(work.map((i) => [i.id, i]));
    const options = rank(
      links.map((l) => ({
        type: "file" as const,
        id: l.id,
        label: l.title || l.url || "Link",
        detail: `${byId.get(l.itemId)?.title ?? ""} · ${l.url ? new URL(l.url).hostname : ""}`,
        _s: q ? matchScore(q, l.title, l.url ?? "") : 1,
      })),
      q,
    );
    if (options.length) sections.push({ type: "file", label: REF_TYPE_LABELS.file, options });
  }
  await Promise.all(tasks);
  const order: RefType[] = ["area", "item", "chat", "person", "device", "file"];
  sections.sort((a, b) => order.indexOf(a.type as RefType) - order.indexOf(b.type as RefType));
  return { sections, partial };
}

/** `#` picker: PRs/issues in the repo (read-only GitHub search) plus ones already linked to your work. */
export async function githubRefOptions(user: Viewer, repo: string | null, q: string): Promise<RefOptionsResponse & { repo: string | null; searched: boolean }> {
  const r = await searchGithubRefs(user, repo, q);
  const options: RefOption[] = r.items.map((i) => ({
    type: "gh",
    id: `${i.repo}#${i.number}`,
    label: `${i.repo.split("/")[1]}#${i.number} ${i.title}`.slice(0, 80),
    detail: `${i.kind === "pull" ? "PR" : "Issue"} · ${i.state}${i.linked ? " · linked" : ""}`,
  }));
  return {
    sections: options.length ? [{ type: "gh", label: repo ? `GitHub · ${repo}` : "GitHub", options }] : [],
    partial: r.partial,
    repo,
    searched: r.searched,
  };
}

// --- resolution: references → context snapshot text ---

async function resolveOne(user: Viewer, r: Reference): Promise<string | null> {
  switch (r.type) {
    case "area":
    case "item": {
      if (!can(user, "work.use")) return null;
      try {
        const d = getDetail(user.id, r.id);
        const p = d.packets[0];
        const lines = [
          `${KIND_LABELS[d.item.kind]}: ${[...d.breadcrumb.map((b) => b.title), d.item.title].join(" › ")} — ${STATUS_LABELS[d.item.status]}`,
          d.item.summary ? `Summary: ${d.item.summary.slice(0, 600)}` : "",
          d.item.nextAction ? `Next action: ${d.item.nextAction}` : "",
          p ? `Objective (packet v${p.version}): ${p.objective.slice(0, 600)}` : "",
          d.validations.length
            ? `Validations: ${d.validations.map((v) => `${v.metric} ${v.comparator} ${v.threshold}${v.unit} (${v.status})`).join("; ")}`
            : "",
          d.children.length
            ? `Children: ${d.children
                .slice(0, 12)
                .map((c) => `${c.title} (${STATUS_LABELS[c.status]})`)
                .join("; ")}`
            : "",
          d.links.length
            ? `Links: ${d.links
                .slice(0, 8)
                .map((l) => `${l.title || l.targetId}${l.externalState ? ` (${l.externalState})` : ""}`)
                .join("; ")}`
            : "",
        ];
        return lines.filter(Boolean).join("\n");
      } catch {
        return null;
      }
    }
    case "chat": {
      if (!can(user, "hermes.chat")) return null;
      // Hermes owns the content; pass the reference (the agent can open its own sessions).
      return `Conversation “${r.label}” (session id ${r.id})`;
    }
    case "person": {
      const p = listPeople().find((x) => x.id === r.id && !x.disabled);
      return p ? `Person: ${p.name} (${ROLE_LABELS[p.role].label})` : null;
    }
    case "device": {
      if (!can(user, "home_assistant.view") || !isConfigured("home_assistant")) return null;
      try {
        const d = await bounded(listDevices({ doors: true, lights: true, cameras: false, doorControls: false, lightControls: false }));
        const x = [...d.doors, ...d.lights].find((v) => v.entityId === r.id);
        return x ? `Device: ${x.name} (${x.entityId}) — ${x.kind}, ${x.state}${x.lastChanged ? ` since ${x.lastChanged}` : ""}` : null;
      } catch {
        return `Device: ${r.label} (${r.id}) — state unavailable`;
      }
    }
    case "file": {
      if (!can(user, "work.use")) return null;
      const row = getDb()
        .select({ link: schema.workLinks, item: schema.workItems })
        .from(schema.workLinks)
        .innerJoin(schema.workItems, eq(schema.workItems.id, schema.workLinks.itemId))
        .where(and(eq(schema.workLinks.id, r.id), eq(schema.workItems.userId, user.id)))
        .get();
      return row ? `Link: ${row.link.title} — ${row.link.url} (on “${row.item.title}”)` : null;
    }
    case "gh": {
      const g = await resolveGithubRef(user, r.id);
      return g ? `GitHub ${g.kind === "pull" ? "PR" : "issue"} ${r.id}: ${g.title ?? r.label} — ${g.state}` : `GitHub ${r.id}: ${r.label}`;
    }
  }
}

/** Snapshot text for the references in a message (only what this person may see; unknown or forbidden ones are skipped). */
export async function resolveReferences(user: Viewer, refs: Reference[]): Promise<string> {
  const blocks = await Promise.all(refs.slice(0, 12).map((r) => resolveOne(user, r).catch(() => null)));
  const lines = blocks.filter((b): b is string => !!b);
  return lines.length ? `Referenced:\n${lines.map((b) => `- ${b.replace(/\n/g, "\n  ")}`).join("\n")}` : "";
}

/** Area defaults for a run in this conversation (its node's area, else the area of an item linking it). */
export function areaDefaultsFor(user: CurrentUser, sessionId: string) {
  if (!can(user as Viewer, "work.use")) return null;
  const items = listItems(user.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  let start: WorkItem | undefined = items.find((i) => i.kind === "conversation" && i.sessionId === sessionId);
  if (!start) {
    const link = getDb()
      .select({ itemId: schema.workLinks.itemId })
      .from(schema.workLinks)
      .innerJoin(schema.workItems, eq(schema.workItems.id, schema.workLinks.itemId))
      .where(and(eq(schema.workItems.userId, user.id), eq(schema.workLinks.kind, "chat_session"), eq(schema.workLinks.targetId, sessionId)))
      .get();
    start = link ? byId.get(link.itemId) : undefined;
  }
  let area = start;
  for (let n = 0; area?.parentId && n < 100; n++) area = byId.get(area.parentId);
  if (!area || area.parentId !== null) return null;
  const raw = getDb().select({ settings: schema.workItems.settings }).from(schema.workItems).where(eq(schema.workItems.id, area.id)).get();
  return { area: { id: area.id, title: area.title, builtIn: area.builtIn }, settings: parseAreaSettings(raw?.settings) };
}

export function assertAreaOwned(user: CurrentUser, areaId: string) {
  const row = getDb()
    .select({ id: schema.workItems.id, kind: schema.workItems.kind })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, areaId), eq(schema.workItems.userId, user.id)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "Area not found");
  if (row.kind === "note") throw new HttpError(400, "note_parent", "Notes can't hold conversations");
}
