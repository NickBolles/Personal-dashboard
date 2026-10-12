import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { importSchema, saveSchema, type WorkoutRow, type WorkoutSession } from "@/lib/workouts";

const table = schema.workoutSessions;
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function row(r: typeof table.$inferSelect): WorkoutRow {
  return { id: r.id, version: r.version, session: JSON.parse(r.document), source: r.source ? JSON.parse(r.source) : null };
}
export function listWorkouts(userId: string): WorkoutRow[] {
  return getDb()
    .select()
    .from(table)
    .where(eq(table.userId, userId))
    .all()
    .map(row)
    .sort((a, b) => b.session.date.localeCompare(a.session.date) || a.id.localeCompare(b.id));
}
export function saveWorkout(userId: string, input: unknown): WorkoutRow {
  const body = saveSchema.parse(input);
  const digest = hash(body);
  return getDb().transaction((tx) => {
    const receipt = tx
      .select()
      .from(schema.workoutRequests)
      .where(and(eq(schema.workoutRequests.userId, userId), eq(schema.workoutRequests.requestId, body.requestId)))
      .get();
    if (receipt) {
      if (receipt.hash !== digest) throw new HttpError(409, "request_reused", "Request ID already used for different content");
      return JSON.parse(receipt.response) as WorkoutRow;
    }
    const existing = tx.select().from(table).where(eq(table.id, body.id)).get();
    if ((existing && existing.userId !== userId) || (!existing && body.version !== 0)) throw new HttpError(404, "not_found", "Workout not found");
    if ((existing?.version ?? 0) !== body.version) throw new HttpError(409, "stale", "Workout changed elsewhere. Reload before editing.");
    if (existing?.source) throw new HttpError(409, "import_readonly", "Imported history is preserved read-only");
    // Only one active session per person. The transaction serializes create races.
    if (
      body.session.status === "active" &&
      tx
        .select()
        .from(table)
        .where(eq(table.userId, userId))
        .all()
        .some((r) => r.id !== body.id && (JSON.parse(r.document) as WorkoutSession).status === "active")
    )
      throw new HttpError(409, "active_session", "Resume your active workout first");
    const value = { userId, version: body.version + 1, document: JSON.stringify(body.session), updatedAt: new Date().toISOString() };
    if (existing)
      tx.update(table)
        .set(value)
        .where(and(eq(table.id, body.id), eq(table.userId, userId)))
        .run();
    else
      tx.insert(table)
        .values({ id: body.id, ...value })
        .run();
    const result = row(
      tx
        .select()
        .from(table)
        .where(and(eq(table.id, body.id), eq(table.userId, userId)))
        .get()!,
    );
    tx.insert(schema.workoutRequests)
      .values({ userId, requestId: body.requestId, hash: digest, response: JSON.stringify(result) })
      .run();
    return result;
  });
}
export function importWorkouts(userId: string, input: unknown) {
  const data = importSchema.parse(input);
  return getDb().transaction((tx) => {
    let imported = 0,
      skipped = 0;
    for (const workout of data.workouts) {
      const source = { workout, profile: data.profile, ...(data.liftAliases ? { liftAliases: data.liftAliases } : {}) };
      const digest = hash(source);
      const prior = tx
        .select()
        .from(table)
        .where(and(eq(table.userId, userId), eq(table.sourceId, workout.id)))
        .get();
      if (prior) {
        if (prior.sourceHash !== digest)
          throw new HttpError(409, "source_changed", "An imported source ID has changed. No sessions imported; preserve and review the original.");
        skipped++;
        continue;
      }
      // Never infer equipment, bilateral conventions or aliases from a legacy label.
      const session: WorkoutSession = {
        date: workout.date,
        title: workout.title,
        notes: workout.notes,
        status: "completed",
        exercises: workout.exercises.map((e) => ({
          name: e.name,
          unit: data.profile.units,
          equipment: "unknown",
          sets: (e.sets.length ? e.sets : [{ note: "Mentioned; no set details recorded" }]).map((s) => ({ ...s, done: true })),
        })),
      };
      tx.insert(table)
        .values({
          id: randomUUID(),
          userId,
          version: 1,
          document: JSON.stringify(session),
          source: JSON.stringify(source),
          sourceId: workout.id,
          sourceHash: digest,
        })
        .run();
      imported++;
    }
    return { imported, skipped };
  });
}
