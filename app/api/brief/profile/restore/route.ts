import type { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { briefRestoreSchema } from "@/lib/brief";
import { BRIEF_CAP } from "@/server/brief";
import { restoreProfile } from "@/server/brief/store";

/** Undo of "Forget everything" or of an import, once, within a minute of it, by the token that change returned. */
export const POST = api<z.infer<typeof briefRestoreSchema>>(
  ({ user, body, correlationId }) => {
    const restored = restoreProfile(user.id, body.token);
    audit({ actor: user.id, action: "brief.profile.restore", source: "ai", sourceRecord: user.id, result: "ok", correlationId, detail: restored });
    return { ok: true, ...restored };
  },
  { body: briefRestoreSchema, cap: BRIEF_CAP },
);
