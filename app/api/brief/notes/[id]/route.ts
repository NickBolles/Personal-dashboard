import type { z } from "zod";
import { api } from "@/server/http/api";
import { briefNotePatchSchema } from "@/lib/brief";
import { BRIEF_CAP } from "@/server/brief";
import { patchNote, removeNote } from "@/server/brief/store";

type P = { id: string };

/** Edit a note, keep a proposal (`state: "active"`) or dismiss it (`state: "dismissed"`). */
export const PATCH = api<z.infer<typeof briefNotePatchSchema>, P>(({ user, body, params }) => ({ note: patchNote(user.id, params.id, body) }), {
  body: briefNotePatchSchema,
  cap: BRIEF_CAP,
});

/** Forget a note. The response carries it so the client can offer Undo (re-adding the same text restores it). */
export const DELETE = api<undefined, P>(({ user, params }) => ({ note: removeNote(user.id, params.id) }), { cap: BRIEF_CAP });
