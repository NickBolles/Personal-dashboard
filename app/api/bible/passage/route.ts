import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { loadPack } from "@/server/bible/store";
import { lookupPassage, WEB_ATTRIBUTION } from "@/lib/bible/web";
import { parseScriptureRef } from "@/lib/workflows/scripture";

export const dynamic = "force-dynamic";

/** #142: verse text for a reference from the local pack only (no network). */
export const GET = api(
  ({ req }) => {
    const parsed = parseScriptureRef(req.nextUrl.searchParams.get("ref") ?? "");
    if (!parsed.ok) throw new HttpError(422, parsed.error, parsed.message);
    const pack = loadPack();
    if (!pack) throw new HttpError(404, "bible_not_installed", "The offline Bible isn't downloaded");
    const { verses, truncated } = lookupPassage(pack, parsed.ref);
    return { ref: parsed.ref.display, translation: pack.translation, version: pack.version, verses, truncated, attribution: WEB_ATTRIBUTION };
  },
  { cap: "work.use" },
);
