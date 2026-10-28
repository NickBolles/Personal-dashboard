import "server-only";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { todosAdapter, dropTodo, reopenTodo } from "@/integrations/todos/adapter";
import { refreshSource } from "@/server/sources";
import { createItem, updateItem } from "@/server/work/store";
import { LIMITS } from "@/lib/jarvis-ui/catalog";
import { intentInSpec, intentKey, intentSchema, isExternal, type Intent } from "@/lib/jarvis-ui/intents";
import { addCalendarBlock, requireCalendarWrites } from "./calendar";
import { isTask, type AppliedEntry, type ApplyResult, type SurfaceView, type TaskRef } from "@/lib/jarvis-ui/types";
import { lookup, ownedSurface, sha256, storedSpec, todayLocal, toView, writeApplied } from "./store";

type Checked = { intent: Intent; hash: string; hydrated: Record<string, TaskRef> };

const capFor = (i: Intent) =>
  i.kind.startsWith("todo.")
    ? i.kind === "todo.promote"
      ? ["todos.edit", "work.use"]
      : ["todos.edit"]
    : i.kind === "calendar.block"
      ? ["home_assistant.calendar"]
      : ["work.use"];

/**
 * Validate the whole batch before writing anything. Any intent that isn't
 * well-formed, isn't offered by the stored spec, or points at something this
 * person can't see → 400 for the batch; Finance → 403 (spec §12).
 */
function check(user: CurrentUser, raw: unknown[], specOf: () => ReturnType<typeof storedSpec>, external: boolean): Checked[] {
  const spec = specOf();
  const today = todayLocal();
  const l = lookup(user);
  let creates = 0;
  return raw.map((r) => {
    const p = intentSchema.safeParse(r);
    if (!p.success) throw new HttpError(400, "invalid_intent", "That change isn't allowed");
    const intent = p.data;
    // External writes go only through their own approval, never mixed into an ordinary Apply.
    if (isExternal(intent) !== external)
      throw new HttpError(
        400,
        external ? "not_external" : "needs_approval",
        external ? "Only calendar blocks can be approved here" : "Calendar blocks need their own approval",
      );
    if (isExternal(intent)) requireCalendarWrites(user);
    if (!capFor(intent).every((c) => can(user, c))) throw new HttpError(403, "forbidden", "You don't have access to that.");
    if (!intentInSpec(spec, intent, today)) throw new HttpError(400, "not_offered", "That change wasn't offered by this reply");
    if (intent.kind === "item.create" || intent.kind === "todo.promote") creates++;
    if (creates > LIMITS.createsPerApply) throw new HttpError(400, "too_many", `At most ${LIMITS.createsPerApply} new items per apply`);
    const refs = ["ref" in intent ? intent.ref : undefined, "parentRef" in intent ? intent.parentRef : undefined].filter((x): x is string => Boolean(x));
    const hydrated: Checked["hydrated"] = {};
    for (const ref of refs) {
      const h = ref.startsWith("todo:") ? l.todo(ref) : l.item(ref);
      if ("unavailable" in h) {
        if (h.unavailable === "finance") throw new HttpError(403, "finance_excluded", "Finance is never changed from an AI reply");
        throw new HttpError(400, "unavailable", "Something in that change isn't available any more");
      }
      if (!isTask(h)) throw new HttpError(400, "unavailable", "Something in that change isn't available any more");
      hydrated[ref] = h;
    }
    return { intent, hash: sha256(intentKey(intent)).slice(0, 32), hydrated };
  });
}

async function execute(user: CurrentUser, c: Checked, correlationId: string): Promise<{ message: string; undo: Record<string, unknown> }> {
  const i = c.intent;
  const opts = { actor: user.id, correlationId };
  // Completed elsewhere since the reply was written: nothing to do, and nothing to undo.
  const target = "ref" in i ? c.hydrated[i.ref] : undefined;
  if (i.kind.startsWith("todo.") && target && "done" in target && target.done) return { message: "Already done", undo: { type: "none" } };
  switch (i.kind) {
    case "todo.complete":
      await todosAdapter.act!(i.ref.slice(5), "complete", opts);
      return { message: "Marked done", undo: { type: "reopen" } };
    case "todo.snooze": {
      const h = c.hydrated[i.ref]!;
      await todosAdapter.act!(i.ref.slice(5), "snooze", { ...opts, until: i.date });
      // Only a date-only due can be restored exactly; a due time or "no due date" can't (no undo offered).
      return { message: `Moved to ${i.date}`, undo: h.due && !("timed" in h && h.timed) ? { type: "snooze", date: h.due } : { type: "none" } };
    }
    case "todo.drop":
      await dropTodo(i.ref.slice(5), i.note, opts);
      return { message: "Dropped (marked done)", undo: { type: "reopen" } };
    case "todo.promote": {
      const t = c.hydrated[i.ref]!;
      const item = createItem(
        user,
        { parentId: i.parentRef.slice(5), kind: "thread", title: t.title.slice(0, 200), summary: "Promoted from a todo in a smart reply." },
        correlationId,
      );
      return { message: "Filed as a work item", undo: { type: "archive", itemId: item.id } };
    }
    case "item.update": {
      const id = i.ref.slice(5);
      const before = lookup(user).items.get(id)!;
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(i.patch) as (keyof typeof i.patch)[]) prev[k] = before[k];
      updateItem(user, id, { ...i.patch, ...(i.patch.status ? { reason: "From a smart reply" } : {}) }, correlationId);
      return { message: "Updated", undo: { type: "item", itemId: id, patch: prev } };
    }
    case "item.create": {
      const item = createItem(
        user,
        { parentId: i.parentRef.slice(5), kind: i.itemKind ?? "thread", title: i.title, nextAction: i.nextAction, targetDate: i.targetDate ?? null },
        correlationId,
      );
      return { message: "Created", undo: { type: "archive", itemId: item.id } };
    }
    case "calendar.block":
      // The title is the live one from Jarvis, never client- or model-supplied.
      return addCalendarBlock(user, i, c.hydrated[i.ref]!.title);
  }
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Apply/undo read the surface's applied history, await upstream writes, then
 * write the history back. Serialize them per surface (one server process) so
 * an overlapping request can't overwrite another's entries.
 */
async function withSurfaceLock<T>(surfaceId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(surfaceId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(surfaceId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(surfaceId) === tail) locks.delete(surfaceId);
  }
}

export function applyIntents(
  user: CurrentUser,
  body: { surfaceId: string; intents: unknown[]; idempotencyKey: string; external?: true },
  correlationId: string,
) {
  return withSurfaceLock(body.surfaceId, () => applyLocked(user, body, correlationId));
}

export function undoIntent(user: CurrentUser, body: { surfaceId: string; intentHash: string }, correlationId: string) {
  return withSurfaceLock(body.surfaceId, () => undoLocked(user, body, correlationId));
}

async function applyLocked(
  user: CurrentUser,
  body: { surfaceId: string; intents: unknown[]; idempotencyKey: string; external?: true },
  correlationId: string,
): Promise<{ results: ApplyResult[]; surface: SurfaceView }> {
  const row = ownedSurface(user.id, body.surfaceId);
  const applied = JSON.parse(row.appliedJson) as AppliedEntry[];
  // Idempotent replay: the same apply call returns what it did the first time.
  // Idempotent replay: the same key returns the complete, ordered response it got the first time.
  const replay = applied.filter((e) => e.key === body.idempotencyKey);
  if (replay.length)
    return {
      results: replay.map((e) => ({ intentHash: e.intentHash, ok: e.ok, message: e.message, ...(e.code ? { code: e.code } : {}) })),
      surface: toView(row, user),
    };

  const checked = check(user, body.intents, () => storedSpec(row), body.external === true);
  const results: ApplyResult[] = [];
  const at = new Date().toISOString();
  let touchedTodos = false;
  for (const c of checked) {
    const live = applied.find((e) => e.intentHash === c.hash && e.ok && !e.undone && !e.noop);
    if (live) {
      // Recorded (as a no-op) so a replay of this key returns the full response.
      applied.push({ intentHash: c.hash, intent: c.intent, ok: true, noop: true, message: "Already applied", at, key: body.idempotencyKey });
      results.push({ intentHash: c.hash, ok: true, message: "Already applied" });
      continue;
    }
    try {
      const r = await execute(user, c, correlationId);
      if (c.intent.kind.startsWith("todo.")) touchedTodos = true;
      applied.push({ intentHash: c.hash, intent: c.intent, ok: true, message: r.message, at, key: body.idempotencyKey, undo: r.undo });
      results.push({ intentHash: c.hash, ok: true, message: r.message });
    } catch (err) {
      const e = err as HttpError;
      const message = e instanceof HttpError || (e as Error).name === "UpstreamError" ? (e as Error).message : "Couldn't apply that change";
      const code = e.code ?? "failed";
      applied.push({ intentHash: c.hash, intent: c.intent, ok: false, message, code, at, key: body.idempotencyKey });
      results.push({ intentHash: c.hash, ok: false, message, code });
    }
  }
  writeApplied(row.id, applied);
  if (touchedTodos) await refreshSource("todos").catch(() => undefined);
  audit({
    actor: user.id,
    action: "smart.apply",
    source: "smart",
    sourceRecord: row.id,
    result: results.every((r) => r.ok) ? "ok" : "error",
    correlationId,
    detail: {
      kinds: checked.map((c) => c.intent.kind),
      external: body.external === true,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
  });
  return { results, surface: toView({ ...row, appliedJson: JSON.stringify(applied) }, user) };
}

async function undoLocked(user: CurrentUser, body: { surfaceId: string; intentHash: string }, correlationId: string) {
  const row = ownedSurface(user.id, body.surfaceId);
  const applied = JSON.parse(row.appliedJson) as AppliedEntry[];
  const entry = applied.find((e) => e.intentHash === body.intentHash && e.ok && !e.undone && !e.noop);
  if (!entry) throw new HttpError(404, "not_found", "Nothing to undo");
  const u = entry.undo ?? { type: "none" };
  const intent = intentSchema.parse(entry.intent);
  const opts = { actor: user.id, correlationId };
  switch (u.type) {
    case "reopen":
      if (!can(user, "todos.edit")) throw new HttpError(403, "forbidden", "You don't have access to that.");
      await reopenTodo((intent as { ref: string }).ref.slice(5), opts);
      break;
    case "snooze":
      if (!can(user, "todos.edit")) throw new HttpError(403, "forbidden", "You don't have access to that.");
      await todosAdapter.act!((intent as { ref: string }).ref.slice(5), "snooze", { ...opts, until: u.date as string });
      break;
    case "archive":
      if (!can(user, "work.use")) throw new HttpError(403, "forbidden", "You don't have access to that.");
      updateItem(user, u.itemId as string, { archived: true }, correlationId);
      break;
    case "item":
      if (!can(user, "work.use")) throw new HttpError(403, "forbidden", "You don't have access to that.");
      updateItem(
        user,
        u.itemId as string,
        { ...(u.patch as Record<string, never>), ...((u.patch as { status?: string }).status ? { reason: "Undo from a smart reply" } : {}) },
        correlationId,
      );
      break;
    default:
      throw new HttpError(409, "no_undo", "That change can't be undone here");
  }
  entry.undone = true;
  writeApplied(row.id, applied);
  if (intent.kind.startsWith("todo.")) await refreshSource("todos").catch(() => undefined);
  audit({ actor: user.id, action: "smart.undo", source: "smart", sourceRecord: row.id, result: "ok", correlationId, detail: { kind: intent.kind } });
  return { ok: true, message: "Undone", surface: toView({ ...row, appliedJson: JSON.stringify(applied) }, user) };
}
