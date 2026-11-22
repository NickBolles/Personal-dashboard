import type { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { briefImportSchema } from "@/lib/brief";
import { BRIEF_CAP } from "@/server/brief";
import { exportProfile, importProfile, resetProfile } from "@/server/brief/store";

export const dynamic = "force-dynamic";

/** Export what this person taught the brief (their active notes) as JSON. */
export const GET = api(({ user }) => exportProfile(user.id), { cap: BRIEF_CAP });

/** Import notes from an export. Adds what is missing; never removes or replaces. */
export const POST = api<z.infer<typeof briefImportSchema>>(({ user, body }) => importProfile(user.id, body.notes), { body: briefImportSchema, cap: BRIEF_CAP });

/** Forget everything the brief learned about this person: notes, proposals and feedback. Briefs already built stay. */
export const DELETE = api(
  ({ user, correlationId }) => {
    resetProfile(user.id);
    audit({ actor: user.id, action: "brief.profile.reset", source: "ai", sourceRecord: user.id, result: "ok", correlationId });
    return { ok: true };
  },
  { cap: BRIEF_CAP },
);
