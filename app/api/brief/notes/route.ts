import type { z } from "zod";
import { api } from "@/server/http/api";
import { briefNoteCreateSchema } from "@/lib/brief";
import { BRIEF_CAP } from "@/server/brief";
import { addNote, listNotes } from "@/server/brief/store";

export const dynamic = "force-dynamic";

/** What the brief knows about this person: notes they wrote, notes they kept, and proposals waiting for them. */
export const GET = api(({ user }) => ({ notes: listNotes(user.id) }), { cap: BRIEF_CAP });

export const POST = api<z.infer<typeof briefNoteCreateSchema>>(({ user, body }) => ({ note: addNote(user.id, body.text) }), {
  body: briefNoteCreateSchema,
  cap: BRIEF_CAP,
});
