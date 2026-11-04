import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { effectiveAreaPolicy } from "@/server/ai/rules";
import { addLink, conversationNodes, createItem, listItems, updateItem, type OpOut } from "@/server/work/store";
import { knownAgents, knownPeople } from "@/server/work/tags";
import { validateAssignee } from "@/lib/item-tags";
import { listActivity } from "@/server/work/activity";
import { fileConversation } from "@/server/work/conversations";
import { noteIndexedSession } from "@/server/work/conversation-index";
import { adoptSession } from "@/integrations/hermes/service";
import { getAgentSettings } from "@/server/agents/routing";
import { AGENT_RUN_STATES } from "@/lib/agent-runs";
import { STATUS_LABELS, WORK_STATUSES, isContainer, parseGithubUrl, type WorkItem } from "@/lib/work";
import type { AgentScope } from "@/lib/agent-access";
import type { AgentPrincipal } from "./tokens";

/**
 * Jarvis MCP tools (docs/agent-tools.md). Every tool:
 * - needs a scope; Finance and AI-excluded areas (and everything under them) are invisible —
 *   an id there answers "not found", exactly like an id that doesn't exist;
 * - validates its input with zod (strict, size-capped);
 * - writes through the normal store functions inside withVia("agent:<profile>") (mcp.ts), so
 *   every change is in Activity "by @profile", audit_log, and undoable from Activity;
 * - never settles, archives, moves, splits, merges or deletes: those become a Needs-you proposal.
 */

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().max(max);

/** Statuses an agent may set. Settling / abandoning / superseding is the owner's call. */
export const AGENT_STATUSES = WORK_STATUSES.filter((s) => s !== "settled" && s !== "abandoned" && s !== "superseded");
const REFUSED_STATUSES = new Set(["settled", "abandoned", "superseded"]);

export const DESTRUCTIVE_OPS = ["settle", "archive", "move", "split", "merge", "delete", "abandon"] as const;

type Ctx = { agent: AgentPrincipal; correlationId: string };

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  scope: AgentScope;
  input: S;
  run: (args: z.infer<S>, ctx: Ctx) => unknown | Promise<unknown>;
};

const tool = <S extends z.ZodType>(t: ToolDef<S>) => t as unknown as ToolDef;

// --- visibility -----------------------------------------------------------------------------

/** The owner's items an agent may see: no Finance / aiPolicy=excluded subtrees, no archived. */
export function agentItems(userId: string): { items: WorkItem[]; byId: Map<string, WorkItem> } {
  const all = listItems(userId);
  const byId = new Map(all.map((i) => [i.id, i]));
  const hidden = new Map<string, boolean>();
  const isHidden = (i: WorkItem | undefined, depth = 0): boolean => {
    if (!i) return true;
    const known = hidden.get(i.id);
    if (known !== undefined) return known;
    let h = i.archived;
    if (!h && i.parentId === null) h = effectiveAreaPolicy({ title: i.title, aiPolicy: i.settings?.aiPolicy ?? null }) === "excluded";
    if (!h && i.parentId !== null) h = depth > 60 ? true : isHidden(byId.get(i.parentId), depth + 1);
    hidden.set(i.id, h);
    return h;
  };
  const items = all.filter((i) => !isHidden(i));
  return { items, byId: new Map(items.map((i) => [i.id, i])) };
}

function visible(userId: string, itemId: string): WorkItem {
  const v = agentItems(userId).byId.get(itemId);
  if (!v) throw new HttpError(404, "not_found", "No item with that id (or it isn't available to agents)");
  return v;
}

const brief = (i: WorkItem) => ({
  id: i.id,
  kind: i.kind,
  title: i.title,
  status: i.status,
  nextAction: i.nextAction || undefined,
  assignee: i.assignee ?? undefined,
  tags: i.tags.length ? i.tags : undefined,
  decision: i.decision ? i.decision.question : undefined,
});

const CLOSED = new Set(["settled", "abandoned", "superseded"]);

// --- tools ----------------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  tool({
    name: "jarvis_tree",
    description:
      "List the owner's areas → projects → items (status, next action, assignee, open decision). Optional areaId to start from one area or project; depth 1–4 (default 3). Closed items are left out unless includeClosed. Finance and AI-excluded areas are never listed.",
    scope: "work.read",
    input: z.object({ areaId: id.optional(), depth: z.number().int().min(1).max(4).optional(), includeClosed: z.boolean().optional() }).strict(),
    run: ({ areaId, depth = 3, includeClosed = false }, { agent }) => {
      const { items } = agentItems(agent.user.id);
      const kids = new Map<string | null, WorkItem[]>();
      for (const i of items) {
        if (i.kind === "conversation") continue;
        if (!includeClosed && CLOSED.has(i.status) && !isContainer(i)) continue;
        kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
      }
      let budget = 400;
      const walk = (parent: string | null, d: number): unknown[] =>
        (kids.get(parent) ?? [])
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .flatMap((i) => {
            if (budget-- <= 0) return [];
            const children = d < depth ? walk(i.id, d + 1) : [];
            const more = d >= depth ? (kids.get(i.id)?.length ?? 0) : 0;
            return [{ ...brief(i), ...(children.length ? { children } : {}), ...(more ? { moreChildren: more } : {}) }];
          });
      if (areaId) visible(agent.user.id, areaId);
      return { nodes: walk(areaId ?? null, 1), truncated: budget < 0 };
    },
  }),
  tool({
    name: "jarvis_search",
    description: "Find items by words in the title, next action or summary. Returns up to 25 matches with their path.",
    scope: "work.read",
    input: z.object({ q: text(200).min(1) }).strict(),
    run: ({ q }, { agent }) => {
      const { items, byId } = agentItems(agent.user.id);
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const path = (i: WorkItem) => {
        const out: string[] = [];
        for (let p = i.parentId ? byId.get(i.parentId) : undefined, n = 0; p && n < 10; p = p.parentId ? byId.get(p.parentId) : undefined, n++)
          out.unshift(p.title);
        return out.join(" › ");
      };
      const hits = items
        .filter((i) => i.kind !== "conversation")
        .filter((i) => {
          const hay = `${i.title} ${i.nextAction} ${i.summary}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
        .slice(0, 25);
      return { items: hits.map((i) => ({ ...brief(i), path: path(i) })) };
    },
  }),
  tool({
    name: "jarvis_get_item",
    description: "One item: fields, summary, children, links (PRs, issues, URLs), open decision, agent runs and the last 10 activity rows.",
    scope: "work.read",
    input: z.object({ id }).strict(),
    run: ({ id: itemId }, { agent }) => {
      const i = visible(agent.user.id, itemId);
      const { items } = agentItems(agent.user.id);
      const links = getDb()
        .select({
          kind: schema.workLinks.kind,
          title: schema.workLinks.title,
          url: schema.workLinks.url,
          targetId: schema.workLinks.targetId,
          state: schema.workLinks.externalState,
        })
        .from(schema.workLinks)
        .where(eq(schema.workLinks.itemId, i.id))
        .all();
      const runs = getDb()
        .select()
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.userId, agent.user.id), eq(schema.agentRuns.itemId, i.id)))
        .orderBy(desc(schema.agentRuns.updatedAt))
        .limit(10)
        .all()
        .map((r) => ({ runId: r.id, title: r.title, profile: r.profile, state: r.state, summary: r.summary, prUrl: r.prUrl, updatedAt: r.updatedAt }));
      const activity = listActivity(agent.user, { item: i.id, limit: 10 }).items.map((a) => ({
        at: a.at,
        actor: a.via ? `@${a.via}` : a.actor.name,
        verb: a.verb,
        detail: a.detail,
      }));
      return {
        item: {
          ...brief(i),
          parentId: i.parentId,
          summary: i.summary,
          startDate: i.startDate,
          targetDate: i.targetDate,
          updatedAt: i.updatedAt,
          statusLabel: STATUS_LABELS[i.status],
        },
        decision: i.decision,
        children: items.filter((c) => c.parentId === i.id && c.kind !== "conversation").map(brief),
        links,
        agentRuns: runs,
        activity,
      };
    },
  }),
  tool({
    name: "jarvis_create_item",
    description:
      "Create an item under a parent (area, project or item). kind: project | thread | investigation | note (default thread). Agents can't create areas. Undoable by the owner from Activity.",
    scope: "work.write",
    input: z
      .object({
        parentId: id,
        title: text(200).min(1),
        kind: z.enum(["project", "thread", "investigation", "note"]).optional(),
        summary: text(8000).optional(),
        nextAction: text(500).optional(),
        assignee: text(120).optional(),
      })
      .strict(),
    run: ({ parentId, title, kind = "thread", summary, nextAction, assignee }, { agent, correlationId }) => {
      const parent = visible(agent.user.id, parentId);
      if (parent.kind === "note" || parent.kind === "conversation") throw new HttpError(400, "bad_parent", "Notes and conversations can't hold items");
      // Validate the assignee first so a rejected one never leaves a committed item behind.
      if (assignee) {
        const a = validateAssignee(assignee, { agents: knownAgents(), people: knownPeople().map((p) => p.id) });
        if (!a.ok) throw new HttpError(400, "assignee", a.error);
      }
      const out: OpOut = {};
      let item = createItem(agent.user, { parentId, kind, title, summary, nextAction }, correlationId, out);
      if (assignee) item = updateItem(agent.user, item.id, { assignee }, correlationId);
      return { item: brief(item), undoOpId: out.op?.id ?? null };
    },
  }),
  tool({
    name: "jarvis_update_item",
    description:
      'Update an item: title, summary, nextAction, status, reason (for the status change), assignee ("agent:<profile>" | null), tags, startDate/targetDate (YYYY-MM-DD). Partial. Settling, abandoning or superseding is refused — use jarvis_request_change.',
    scope: "work.write",
    input: z
      .object({
        id,
        title: text(200).min(1).optional(),
        summary: text(8000).optional(),
        nextAction: text(500).optional(),
        status: z.enum(WORK_STATUSES).optional(),
        reason: text(500).optional(),
        assignee: text(120).nullable().optional(),
        tags: z.array(text(64)).max(20).optional(),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        targetDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
      })
      .strict(),
    run: ({ id: itemId, ...patch }, { agent, correlationId }) => {
      if (patch.status && REFUSED_STATUSES.has(patch.status))
        throw new HttpError(403, "owner_only", `Only the owner can mark work ${STATUS_LABELS[patch.status]}. Use jarvis_request_change to propose it.`);
      const cur = visible(agent.user.id, itemId);
      if (cur.status === "settled" && patch.status) throw new HttpError(403, "owner_only", "Settled work is the owner's to reopen. Use jarvis_request_change.");
      if (!Object.values(patch).some((v) => v !== undefined)) throw new HttpError(400, "empty", "Nothing to update");
      const out: OpOut = {};
      const item = updateItem(agent.user, itemId, patch, correlationId, out);
      return { item: brief(item), undoOpId: out.op?.id ?? null };
    },
  }),
  tool({
    name: "jarvis_add_note",
    description: "Add a note (a note item with a body) under an item, e.g. a progress note or findings. Undoable.",
    scope: "work.write",
    input: z.object({ itemId: id, title: text(200).min(1), body: text(8000).optional() }).strict(),
    run: ({ itemId, title, body }, { agent, correlationId }) => {
      const parent = visible(agent.user.id, itemId);
      if (parent.kind === "note" || parent.kind === "conversation")
        throw new HttpError(400, "bad_parent", "Add the note to the item, not to a note or conversation");
      const out: OpOut = {};
      const item = createItem(agent.user, { parentId: itemId, kind: "note", title, summary: body }, correlationId, out);
      return { item: brief(item), undoOpId: out.op?.id ?? null };
    },
  }),
  tool({
    name: "jarvis_link",
    description: "Link a GitHub PR or issue URL, or an https URL (e.g. an artifacts board), to an item. Jarvis doesn't fetch the URL.",
    scope: "work.write",
    input: z.object({ itemId: id, url: z.string().trim().max(2000), title: text(300).optional(), kind: z.enum(["pr", "issue", "url"]).optional() }).strict(),
    run: async ({ itemId, url, title, kind }, { agent, correlationId }) => {
      visible(agent.user.id, itemId);
      const gh = parseGithubUrl(url);
      const resolved = kind ?? (gh ? (gh.kind === "pull" ? "pr" : "issue") : "url");
      if (resolved === "url" && !/^https:\/\//i.test(url)) throw new HttpError(400, "url", "Only https URLs can be linked");
      const link = await addLink(
        agent.user,
        itemId,
        { kind: resolved === "pr" ? "github_pr" : resolved === "issue" ? "github_issue" : "url", url, ...(title ? { title } : {}) },
        correlationId,
      );
      return { link: { id: link.id, kind: link.kind, title: link.title, url: link.url } };
    },
  }),
  tool({
    name: "jarvis_raise_decision",
    description: "Ask the owner a decision on an item (shows in Needs you). Up to 6 one-tap choices. One open decision per item.",
    scope: "decisions.write",
    input: z.object({ itemId: id, question: text(500).min(1), choices: z.array(text(120).min(1)).max(6).optional() }).strict(),
    run: ({ itemId, question, choices }, { agent, correlationId }) => {
      const cur = visible(agent.user.id, itemId);
      if (cur.kind === "conversation") throw new HttpError(400, "decision_kind", "Ask on the work item, not the conversation");
      if (cur.decision) throw new HttpError(409, "decision_open", "That item already has an open decision; wait for the owner's answer");
      const item = updateItem(agent.user, itemId, { decision: { question: `@${agent.profile}: ${question}`.slice(0, 500), choices } }, correlationId);
      return { item: brief(item) };
    },
  }),
  tool({
    name: "jarvis_request_change",
    description:
      "Propose a change only the owner may make (settle, archive, move, split, merge, delete, abandon). Nothing changes: it becomes a Needs-you decision the owner acts on.",
    scope: "decisions.write",
    input: z.object({ itemId: id, op: z.enum(DESTRUCTIVE_OPS), reason: text(500).min(1), targetId: id.optional() }).strict(),
    run: ({ itemId, op, reason, targetId }, { agent, correlationId }) => {
      const cur = visible(agent.user.id, itemId);
      if (cur.decision) throw new HttpError(409, "decision_open", "That item already has an open decision; wait for the owner's answer");
      const target = targetId ? visible(agent.user.id, targetId) : null;
      const what = `${op}${target ? ` → “${target.title}”` : ""}`;
      const item = updateItem(
        agent.user,
        itemId,
        { decision: { question: `@${agent.profile} proposes: ${what}. ${reason}`.slice(0, 500), choices: ["Do it", "Not now"] } },
        correlationId,
      );
      return { item: brief(item), proposed: op, note: "The owner decides in Needs you; nothing was changed." };
    },
  }),
  tool({
    name: "jarvis_list_decisions",
    description: "Open owner decisions on items (Needs you), newest first.",
    scope: "work.read",
    input: z.object({}).strict(),
    run: (_args, { agent }) => {
      const { items } = agentItems(agent.user.id);
      return {
        decisions: items
          .filter((i) => i.decision)
          .sort((a, b) => (b.decision!.askedAt || b.updatedAt).localeCompare(a.decision!.askedAt || a.updatedAt))
          .slice(0, 50)
          .map((i) => ({ itemId: i.id, title: i.title, question: i.decision!.question, choices: i.decision!.choices, askedAt: i.decision!.askedAt })),
      };
    },
  }),
  tool({
    name: "jarvis_file_conversation",
    description:
      "File one of this agent's own Hermes conversations (by session id, on this token's profile) under an item or area so it shows in Jarvis. Hidden, Bot Chat and sub-agent sessions are refused.",
    scope: "conversations.file",
    input: z.object({ sessionId: z.string().trim().min(1).max(200), itemId: id }).strict(),
    run: async ({ sessionId, itemId }, { agent, correlationId }) => {
      visible(agent.user.id, itemId);
      // A conversation already filed somewhere agents can't see (Finance, AI-excluded) stays put.
      const existing = conversationNodes(agent.user.id).get(sessionId);
      if (existing) visible(agent.user.id, existing.id);
      const profile = agent.profile === "default" ? null : agent.profile;
      if (profile && !getAgentSettings().routes.some((r) => r.profile === profile))
        throw new HttpError(400, "unknown_profile", "This agent's profile has no route in Settings → Agents");
      const adopted = await adoptSession(agent.user, { profile, sessionId }, correlationId);
      try {
        noteIndexedSession(agent.user.id, adopted.session);
      } catch {
        // cache only
      }
      const res = await fileConversation(agent.user, { sessionId, itemId }, correlationId);
      return { conversationItemId: res.item.id, filedUnder: res.itemId };
    },
  }),
  tool({
    name: "jarvis_run_start",
    description: "Register an agent run (e.g. a delegated sub-agent) on a work item; it shows in the item's Agent panel. Returns runId for jarvis_run_update.",
    scope: "runs.write",
    input: z.object({ itemId: id, title: text(200).min(1), hermesSessionId: z.string().trim().max(200).optional() }).strict(),
    run: ({ itemId, title, hermesSessionId }, { agent, correlationId }) => {
      const item = visible(agent.user.id, itemId);
      if (item.parentId === null || item.kind === "conversation")
        throw new HttpError(400, "bad_item", "Record runs on a project or item, not an area or conversation");
      const runId = newId("arun");
      const at = new Date().toISOString();
      getDb().transaction((tx) => {
        tx.insert(schema.agentRuns)
          .values({
            id: runId,
            userId: agent.user.id,
            itemId,
            tokenId: agent.tokenId,
            profile: agent.profile,
            title,
            state: "running",
            hermesSessionId: hermesSessionId ?? null,
            startedAt: at,
            updatedAt: at,
          })
          .run();
        tx.insert(schema.workEvents)
          .values({ id: newId(), itemId, actor: agent.user.id, kind: "agent_run", reason: `started agent run: ${title}`, via: agent.via, at })
          .run();
      });
      audit({ actor: agent.via, action: "agent.run_start", source: "agent", sourceRecord: runId, result: "ok", correlationId, detail: { itemId } });
      return { runId };
    },
  }),
  tool({
    name: "jarvis_run_update",
    description:
      "Update a run you started: state running | waiting | done | failed, a short summary, and the PR URL. A done/failed update is posted to the item's Activity.",
    scope: "runs.write",
    input: z.object({ runId: id, state: z.enum(AGENT_RUN_STATES), summary: text(2000).optional(), prUrl: z.string().trim().max(500).optional() }).strict(),
    run: ({ runId, state, summary, prUrl }, { agent, correlationId }) => {
      const db = getDb();
      const run = db
        .select()
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.userId, agent.user.id), eq(schema.agentRuns.profile, agent.profile)))
        .get();
      if (!run) throw new HttpError(404, "not_found", "No run with that id for this agent");
      visible(agent.user.id, run.itemId);
      let pr: string | null | undefined;
      if (prUrl !== undefined) {
        const gh = parseGithubUrl(prUrl);
        if (!gh || gh.kind !== "pull") throw new HttpError(400, "pr_url", "prUrl must be a GitHub pull request URL");
        pr = gh.url;
      }
      const at = new Date().toISOString();
      const terminal = state === "done" || state === "failed";
      db.transaction((tx) => {
        tx.update(schema.agentRuns)
          .set({
            state,
            updatedAt: at,
            ...(summary !== undefined ? { summary } : {}),
            ...(pr !== undefined ? { prUrl: pr } : {}),
            finishedAt: terminal ? at : null,
          })
          .where(eq(schema.agentRuns.id, runId))
          .run();
        if (terminal && run.state !== state)
          tx.insert(schema.workEvents)
            .values({
              id: newId(),
              itemId: run.itemId,
              actor: agent.user.id,
              kind: "agent_run",
              reason: `agent run ${state === "done" ? "finished" : "failed"}: ${run.title}`,
              via: agent.via,
              at,
            })
            .run();
      });
      audit({ actor: agent.via, action: "agent.run_update", source: "agent", sourceRecord: runId, result: "ok", correlationId, detail: { state } });
      return { runId, state };
    },
  }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
