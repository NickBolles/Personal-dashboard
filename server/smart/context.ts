import "server-only";
import type { CurrentUser } from "@/server/auth";
import { can } from "@/server/access";
import { adapterContext, cachedSource, scopeResult } from "@/server/sources";
import { localDate } from "@/lib/time";
import type { NextAction } from "@/lib/contracts";

/**
 * Context refs (`@ctx:<name>`) in a run's attached context are resolved here,
 * server-side, at send time. They replace the old pasted lists that were cut
 * to "…and N more" (spec §4.5).
 */
export const CTX_OVERDUE = "@ctx:overdue_todos";
export const OVERDUE_MAX_ROWS = 100;
export const OVERDUE_MAX_CHARS = 8000;

function overdueDate(a: NextAction, tz: string, today: string, now: Date) {
  if (a.status !== "open" || !a.dueAt) return undefined;
  // Date-only todos carry the end of that local day as an instant (integrations/actions.ts).
  const date = localDate(new Date(a.dueAt), tz);
  const late = a.dueIsDate ? date < today : new Date(a.dueAt) < now;
  return late ? date : undefined;
}

/**
 * Every overdue todo (up to 100), most recently due first, one line each:
 * `ref | title | due | source`. Titles are shortened before any row is
 * dropped so the list stays complete within 8 000 chars.
 */
export function formatOverdue(rows: { ref: string; title: string; due: string; source: string }[], maxChars = OVERDUE_MAX_CHARS) {
  const list = rows.slice(0, OVERDUE_MAX_ROWS);
  const head = `Overdue todos Jarvis can see (${rows.length} total${rows.length > list.length ? `, first ${list.length}` : ""}, most recently due first). Columns: ref | title | due | source`;
  const line = (r: (typeof list)[number], n: number) => `${r.ref} | ${r.title.length > n ? `${r.title.slice(0, n - 1)}…` : r.title} | ${r.due} | ${r.source}`;
  for (const n of [120, 80, 60, 40, 28, 20]) {
    const text = [head, ...list.map((r) => line(r, n))].join("\n");
    if (text.length <= maxChars) return text;
  }
  const out = [head];
  let len = head.length;
  for (const r of list) {
    const l = line(r, 20);
    if (len + l.length + 1 > maxChars - 30) {
      out.push(`(${list.length - (out.length - 1)} more not shown)`);
      break;
    }
    out.push(l);
    len += l.length + 1;
  }
  return out.join("\n");
}

export function overdueTodosContext(user: CurrentUser, now = new Date()): string {
  if (!can(user, "todos.view")) return "Overdue todos: not available to you.";
  const ctx = adapterContext(now);
  const actions = scopeResult(user, cachedSource("todos", now))?.data?.actions ?? [];
  const rows = actions
    .map((a) => ({ a, due: overdueDate(a, ctx.timezone, ctx.today, now) }))
    .filter((x): x is { a: NextAction; due: string } => Boolean(x.due))
    .sort((x, y) => (x.due < y.due ? 1 : x.due > y.due ? -1 : x.a.sourceId < y.a.sourceId ? -1 : 1))
    .map(({ a, due }) => ({ ref: `todo:${a.sourceId}`, title: a.title.replace(/[\n|]/g, " "), due, source: "Todos" }));
  return rows.length ? formatOverdue(rows) : "Overdue todos: none right now.";
}

/** Replace `@ctx:` refs in attached context with their server-built blocks. */
export function resolveContextRefs(user: CurrentUser, context: string | undefined): { context: string | undefined; blocks: string[] } {
  if (!context || !context.includes("@ctx:")) return { context, blocks: [] };
  const blocks: string[] = [];
  const rest = context
    .split("\n")
    .filter((l) => {
      if (l.trim() === CTX_OVERDUE) {
        blocks.push(overdueTodosContext(user));
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  return { context: rest || undefined, blocks };
}
