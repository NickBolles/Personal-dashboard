import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { processSingleton } from "@/server/singleton";
import { currentVia } from "@/server/work/actor";
import { describeSkylightWrite, inverseOf, skylightWriteOp, type SkylightWriteOp } from "@/lib/skylight-write";
import { runSkylightWrite } from "@/integrations/skylight/write";

export function skylightWriteTarget(op: SkylightWriteOp, created: { itemId?: string; eventId?: string } = {}) {
  if ("choreId" in op) return op.choreId;
  if ("itemId" in op) return op.itemId;
  if ("eventId" in op) return op.eventId;
  if ("listId" in op) return created.itemId ?? op.listId;
  return created.eventId ?? "calendar";
}

export function recordWrite(
  op: SkylightWriteOp,
  user: { id: string },
  created: { itemId?: string; eventId?: string; toCategoryId?: string } = {},
  opts: { undoOf?: string } = {},
) {
  const inverse = opts.undoOf ? null : inverseOf(op, created);
  const row = {
    id: newId(),
    userId: user.id,
    via: currentVia(),
    op: op.op,
    target: skylightWriteTarget(op, created),
    label: describeSkylightWrite(op),
    payload: JSON.stringify(op),
    inverse: inverse ? JSON.stringify(inverse) : null,
    undoOf: opts.undoOf ?? null,
    at: new Date().toISOString(),
  };
  getDb().insert(schema.skylightWrites).values(row).run();
  return { ...row, inverse };
}

// Keep an inverse from running twice when two Undo requests overlap an upstream await.
const locks = processSingleton("skylight_undo_locks", () => new Set<string>());
export async function undoWrite(id: string, user: { id: string }, opts = { correlationId: newId() }) {
  const noUndo = () => new HttpError(409, "not_undoable", "That Skylight change can't be undone anymore.");
  if (locks.has(id)) throw noUndo();
  locks.add(id);
  try {
    const db = getDb();
    const S = schema.skylightWrites;
    const row = db.select().from(S).where(eq(S.id, id)).get();
    const age = row ? Date.now() - Date.parse(row.at) : NaN;
    if (!row || row.userId !== user.id || row.undoneAt || !row.inverse || !Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) throw noUndo();
    const parsed = skylightWriteOp.safeParse(JSON.parse(row.inverse));
    if (!parsed.success) throw noUndo();
    const result = await runSkylightWrite(parsed.data, user, opts);
    return db.transaction(() => {
      const undo = recordWrite(parsed.data, user, result.created, { undoOf: id });
      db.update(S).set({ undoneAt: undo.at }).where(eq(S.id, id)).run();
      return undo;
    });
  } finally {
    locks.delete(id);
  }
}
