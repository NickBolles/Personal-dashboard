import "server-only";
import { and, eq, isNull, gt, or } from "drizzle-orm";
import type { NextAction, PrimaryActionKind } from "@/lib/contracts";
import { iso, localDate, MINUTE, DAY } from "@/lib/time";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { newId } from "@/server/crypto";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { resolveIntegration } from "@/integrations/store";
import { runChecks } from "@/integrations/testing";
import { baseAction, classifyDateOnly, classifyInstant } from "@/integrations/actions";
import type { AdapterContext, SourceAdapter } from "@/integrations/types";
import { GoogleTasksClient } from "./google";
import { haConn, HomeAssistantClient } from "@/integrations/home-assistant/client";

const STALE = 5 * MINUTE;

type Provider = "google_tasks" | "home_assistant" | "jarvis";

function provider(): Provider {
  return (resolveIntegration("todos").config.provider as Provider) || "google_tasks";
}

export type TodoItem = {
  id: string;
  title: string;
  notes?: string;
  /** date-only (YYYY-MM-DD) or ISO instant */
  due?: string;
  completed: boolean;
  completedAt?: string;
  updatedAt?: string;
  url?: string;
};

function toAction(t: TodoItem, ctx: AdapterContext): NextAction {
  const dateOnly = t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due);
  const { reason, dueAt } = t.due
    ? dateOnly
      ? classifyDateOnly(t.due, ctx)
      : { reason: classifyInstant(t.due, ctx), dueAt: t.due }
    : { reason: "upcoming" as const, dueAt: undefined };
  return baseAction("todos", t.id, ctx, STALE, {
    title: t.title || "(untitled)",
    detail: t.notes?.slice(0, 140),
    status: t.completed ? "completed" : "open",
    priorityReason: reason,
    dueAt,
    dueIsDate: Boolean(dateOnly),
    updatedAt: t.completedAt ?? t.updatedAt ?? iso(ctx.now),
    href: `/todos#todo-${encodeURIComponent(t.id)}`,
    primaryAction: t.completed ? undefined : { kind: "complete", label: "Done" },
    secondaryActions: t.completed ? [] : ["snooze"],
  });
}

// --- providers ---

async function listGoogle(ctx: AdapterContext): Promise<TodoItem[]> {
  const tasks = await GoogleTasksClient.tasks({ completedMin: iso(ctx.now.getTime() - DAY) });
  return tasks
    .filter((t) => !t.deleted && (t.status === "needsAction" || t.completed))
    .map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes,
      // Google Tasks stores only the date part of `due` (time is always 00:00Z).
      due: t.due ? t.due.slice(0, 10) : undefined,
      completed: t.status === "completed",
      completedAt: t.completed,
      updatedAt: t.updated,
      url: t.webViewLink,
    }));
}

async function listHa(): Promise<TodoItem[]> {
  const entity = resolveIntegration("todos").config.haEntityId;
  if (!entity) throw new UpstreamError("Home Assistant", "unsupported", "Choose a to-do entity");
  const items = await HomeAssistantClient.todoItems(haConn(), entity);
  return items.map((i) => ({
    id: i.uid,
    title: i.summary,
    notes: i.description,
    due: i.due,
    completed: i.status === "completed",
    completedAt: i.completed,
  }));
}

function listLocal(ctx: AdapterContext): TodoItem[] {
  const since = iso(ctx.now.getTime() - DAY);
  return getDb()
    .select()
    .from(schema.localTodos)
    .where(or(isNull(schema.localTodos.completedAt), gt(schema.localTodos.completedAt, since)))
    .all()
    .map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes ?? undefined,
      due: t.dueAt ?? undefined,
      completed: Boolean(t.completedAt),
      completedAt: t.completedAt ?? undefined,
      updatedAt: t.updatedAt,
    }));
}

export async function listTodos(ctx: AdapterContext): Promise<TodoItem[]> {
  switch (provider()) {
    case "google_tasks":
      return listGoogle(ctx);
    case "home_assistant":
      return listHa();
    case "jarvis":
      return listLocal(ctx);
  }
}

export function createLocalTodo(input: { title: string; notes?: string; due?: string }) {
  if (provider() !== "jarvis") throw new HttpError(409, "not_canonical", "Todos are owned by another provider");
  const id = newId("todo");
  getDb().insert(schema.localTodos).values({ id, title: input.title, notes: input.notes, dueAt: input.due }).run();
  return id;
}

function tomorrow(tz: string) {
  return localDate(Date.now() + DAY, tz);
}

async function mutate(id: string, kind: PrimaryActionKind, opts: { until?: string; timezone: string }) {
  const snoozeDate = opts.until ?? tomorrow(opts.timezone);
  switch (provider()) {
    case "google_tasks": {
      if (kind === "complete") await GoogleTasksClient.patch(id, { status: "completed" });
      else await GoogleTasksClient.patch(id, { due: `${snoozeDate}T00:00:00.000Z` });
      // Readback before reporting success.
      const after = await GoogleTasksClient.get(id);
      if (kind === "complete" && after.status !== "completed") throw new UpstreamError("Google Tasks", "bad_response", "Google did not confirm completion");
      if (kind === "snooze" && after.due?.slice(0, 10) !== snoozeDate)
        throw new UpstreamError("Google Tasks", "bad_response", "Google did not confirm the new due date");
      return;
    }
    case "home_assistant": {
      const entity = resolveIntegration("todos").config.haEntityId;
      const conn = haConn();
      await HomeAssistantClient.callService(conn, "todo", "update_item", {
        entity_id: entity,
        item: id,
        ...(kind === "complete" ? { status: "completed" } : { due_date: snoozeDate }),
      });
      const items = await HomeAssistantClient.todoItems(conn, entity);
      const after = items.find((i) => i.uid === id);
      if (!after) throw new UpstreamError("Home Assistant", "not_found", "Item disappeared");
      if (kind === "complete" && after.status !== "completed")
        throw new UpstreamError("Home Assistant", "bad_response", "Home Assistant did not confirm completion");
      return;
    }
    case "jarvis": {
      const now = new Date().toISOString();
      const res = getDb()
        .update(schema.localTodos)
        .set(kind === "complete" ? { completedAt: now, updatedAt: now } : { dueAt: snoozeDate, updatedAt: now })
        .where(and(eq(schema.localTodos.id, id)))
        .run();
      if (!res.changes) throw new HttpError(404, "not_found", "Todo not found");
    }
  }
}

export const todosAdapter: SourceAdapter = {
  source: "todos",
  staleAfterMs: STALE,
  async fetch(ctx) {
    const items = await listTodos(ctx);
    return { actions: items.map((t) => toAction(t, ctx)), extra: { provider: provider(), items } };
  },
  async act(sourceId, kind, opts) {
    if (kind !== "complete" && kind !== "snooze") throw new HttpError(400, "unsupported", "Unsupported action");
    const tz = (await import("@/server/settings")).getPreferences().timezone;
    try {
      await mutate(sourceId, kind, { until: opts.until, timezone: tz });
      audit({
        actor: opts.actor,
        action: `todos.${kind}`,
        source: "todos",
        sourceRecord: sourceId,
        result: "ok",
        correlationId: opts.correlationId,
        detail: { until: opts.until },
      });
    } catch (err) {
      audit({
        actor: opts.actor,
        action: `todos.${kind}`,
        source: "todos",
        sourceRecord: sourceId,
        result: "error",
        correlationId: opts.correlationId,
        detail: { error: (err as Error).message },
      });
      throw err;
    }
    return { ok: true, message: kind === "complete" ? "Marked done" : "Snoozed" };
  },
  async test() {
    const p = provider();
    let lists: { id: string; title: string }[] = [];
    if (p === "jarvis") {
      return runChecks([{ name: "Built-in list", run: async () => "Todos are stored in Jarvis" }]);
    }
    if (p === "home_assistant") {
      return runChecks([
        {
          name: "Read to-do entity",
          run: async () => {
            const items = await listHa();
            return `${items.filter((i) => !i.completed).length} open items`;
          },
        },
      ]);
    }
    return runChecks(
      [
        {
          name: "Refresh Google access token",
          run: async () => {
            await (await import("./google")).accessToken();
            return "Token OK";
          },
        },
        {
          name: "List task lists",
          run: async () => {
            lists = await GoogleTasksClient.lists();
            return `${lists.length} lists: ${lists.map((l) => l.title).join(", ")}`;
          },
        },
        {
          name: "Read tasks",
          run: async () => {
            const t = await GoogleTasksClient.tasks();
            return `${t.filter((x) => x.status === "needsAction").length} open tasks`;
          },
        },
      ],
      () => [
        {
          field: "taskListId",
          label: "Task list",
          options: [{ value: "@default", label: "Default list" }, ...lists.map((l) => ({ value: l.id, label: l.title }))],
        },
      ],
    );
  },
};
