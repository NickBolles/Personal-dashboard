/**
 * Skylight write operations (Phase 0): the shared contract between the confirm cards (client),
 * POST /api/skylight/write and integrations/skylight/write.ts. Pure: no server imports.
 *
 * Every op is confirmed by the person first and is undoable by its inverse op
 * (`inverseOf`), which the server stores with the write and runs on Undo.
 */
import { z } from "zod";

/** Upstream ids go into URL paths: digits/letters/dashes only (recurring occurrences are `<id>-YYYY-MM-DD-HHMM`). */
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const title = z.string().trim().min(1).max(500);

/** Event fields as Jarvis edits them; times are offset ISO instants, all-day = dates (end exclusive). */
export const skylightEventFields = z.object({
  summary: title,
  allDay: z.boolean(),
  startsAt: z.string().min(10).max(40),
  endsAt: z.string().min(10).max(40),
  location: z.string().max(1000).nullish(),
  description: z.string().max(4000).nullish(),
  /** Original calendar target, retained by delete Undo instead of rediscovering Family. */
  calendarId: z.string().min(1).max(500).optional(),
  sourceCalendarId: z.string().regex(/^\d+$/).optional(),
  calendarAccountId: z.string().regex(/^\d+$/).optional(),
});
export type SkylightEventFields = z.infer<typeof skylightEventFields>;

/**
 * `categoryId` = who it is assigned to (kept for display/undo only: Skylight answers 422 "category_id must be
 * blank" when a completion names the member of a normally-assigned chore). `upForGrabs` = shared chore, whose
 * completion records who did it (the server sends the owner's member then).
 */
const chore = { choreId: id, title, instanceDate: day.optional(), instanceTime: hhmm.optional(), categoryId: id.nullish(), upForGrabs: z.boolean().optional() };

export const skylightWriteOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("chore.complete"), ...chore }),
  z.object({ op: z.literal("chore.reopen"), ...chore }),
  /** Skip this occurrence (completions status "skipped"); undone by reopen. */
  z.object({ op: z.literal("chore.skip"), ...chore }),
  /** Move a one-off chore to another day (`PUT /chores/{id}` `{start}`); recurring series are left to Skylight. */
  z.object({ op: z.literal("chore.reschedule"), choreId: id, title, start: day, previousStart: day }),
  /** Claim an up-for-grabs chore for the owner's member (`toCategoryId` resolved server-side when omitted). */
  z.object({ op: z.literal("chore.claim"), choreId: id, title, fromCategoryId: id.nullable(), toCategoryId: id.optional() }),
  /** Inverse of a claim: back to who/what it was assigned to before. */
  z.object({ op: z.literal("chore.assign"), choreId: id, title, toCategoryId: id.nullable() }),
  z.object({ op: z.literal("list.add"), listId: id, listLabel: z.string().max(200), label: title }),
  z.object({ op: z.literal("list.remove"), listId: id, listLabel: z.string().max(200), itemId: id, label: title }),
  z.object({ op: z.literal("list.check"), listId: id, listLabel: z.string().max(200), itemId: id, label: title }),
  z.object({ op: z.literal("list.uncheck"), listId: id, listLabel: z.string().max(200), itemId: id, label: title }),
  z.object({ op: z.literal("event.create"), event: skylightEventFields }),
  z.object({ op: z.literal("event.update"), eventId: id, event: skylightEventFields, previous: skylightEventFields }),
  z.object({ op: z.literal("event.delete"), eventId: id, previous: skylightEventFields }),
]);
export type SkylightWriteOp = z.infer<typeof skylightWriteOp>;
export type SkylightWriteKind = SkylightWriteOp["op"];

export type SkylightWriteResult = { ok: true; message: string; writeId: string; undoable: boolean };

/** One-line description for the confirm card and the Activity row. */
export function describeSkylightWrite(op: SkylightWriteOp): string {
  switch (op.op) {
    case "chore.complete":
      return `Mark “${op.title}” done in Skylight`;
    case "chore.reopen":
      return `Reopen “${op.title}” in Skylight`;
    case "chore.skip":
      return `Skip “${op.title}”${op.instanceDate ? ` for ${op.instanceDate}` : ""} in Skylight`;
    case "chore.reschedule":
      return `Move “${op.title}” to ${op.start} in Skylight`;
    case "chore.claim":
      return `Claim “${op.title}” (assign it to you in Skylight)`;
    case "chore.assign":
      return `Put “${op.title}” back to how it was assigned`;
    case "list.add":
      return `Add “${op.label}” to ${op.listLabel || "the list"}`;
    case "list.remove":
      return `Remove “${op.label}” from ${op.listLabel || "the list"}`;
    case "list.check":
      return `Check off “${op.label}” on ${op.listLabel || "the list"}`;
    case "list.uncheck":
      return `Uncheck “${op.label}” on ${op.listLabel || "the list"}`;
    case "event.create":
      return `Add “${op.event.summary}” to the family calendar`;
    case "event.update":
      return `Change “${op.previous.summary}” on the family calendar`;
    case "event.delete":
      return `Delete “${op.previous.summary}” from the family calendar`;
  }
}

/** Past-tense toast / Activity verb. */
export function doneLabel(op: SkylightWriteOp): string {
  switch (op.op) {
    case "chore.complete":
      return "Marked done";
    case "chore.reopen":
      return "Reopened";
    case "chore.skip":
      return "Skipped";
    case "chore.reschedule":
      return "Rescheduled";
    case "chore.claim":
      return "Claimed";
    case "chore.assign":
      return "Assignment restored";
    case "list.add":
      return "Added to list";
    case "list.remove":
      return "Removed from list";
    case "list.check":
      return "Checked off";
    case "list.uncheck":
      return "Unchecked";
    case "event.create":
      return "Event added";
    case "event.update":
      return "Event changed";
    case "event.delete":
      return "Event deleted";
  }
}

/**
 * The op that undoes `op`, given what the upstream call returned (created ids, the member a claim
 * resolved to). null = not undoable.
 */
export function inverseOf(op: SkylightWriteOp, created: { itemId?: string; eventId?: string; toCategoryId?: string | null } = {}): SkylightWriteOp | null {
  switch (op.op) {
    case "chore.complete":
      return { ...op, op: "chore.reopen" };
    case "chore.reopen":
      return { ...op, op: "chore.complete" };
    case "chore.skip":
      return { ...op, op: "chore.reopen" };
    case "chore.reschedule":
      return { ...op, start: op.previousStart, previousStart: op.start };
    case "chore.claim":
      return { op: "chore.assign", choreId: op.choreId, title: op.title, toCategoryId: op.fromCategoryId };
    case "chore.assign":
      return null;
    case "list.add":
      return created.itemId ? { op: "list.remove", listId: op.listId, listLabel: op.listLabel, itemId: created.itemId, label: op.label } : null;
    case "list.remove":
      return { op: "list.add", listId: op.listId, listLabel: op.listLabel, label: op.label };
    case "list.check":
      return { ...op, op: "list.uncheck" };
    case "list.uncheck":
      return { ...op, op: "list.check" };
    case "event.create":
      return created.eventId ? { op: "event.delete", eventId: created.eventId, previous: op.event } : null;
    case "event.update":
      return { op: "event.update", eventId: op.eventId, event: op.previous, previous: op.event };
    case "event.delete":
      return { op: "event.create", event: op.previous };
  }
}
