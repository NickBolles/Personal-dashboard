import { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { bibleStatus, installPack, removePack } from "@/server/bible/store";

export const dynamic = "force-dynamic";

/** #142: offline WEB pack status (installed or not; off by default). */
export const GET = api(() => bibleStatus(), { cap: "work.use" });

const installBody = z.object({ confirm: z.literal(true) }).strict();

/** Opt-in download of the pinned pack; checksum verified before anything is written. */
export const POST = api<z.infer<typeof installBody>>(
  async ({ user, correlationId }) => {
    try {
      const m = await installPack();
      audit({ actor: user.id, action: "bible.pack.install", result: "ok", correlationId, detail: { version: m.version, sha256: m.sourceSha256 } });
    } catch (err) {
      audit({ actor: user.id, action: "bible.pack.install", result: "error", correlationId, detail: { error: (err as Error).message.slice(0, 200) } });
      throw err;
    }
    return bibleStatus();
  },
  { cap: "admin", body: installBody },
);

export const DELETE = api(
  ({ user, correlationId }) => {
    removePack();
    audit({ actor: user.id, action: "bible.pack.remove", result: "ok", correlationId });
    return bibleStatus();
  },
  { cap: "admin" },
);
