import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { getOwner } from "@/server/auth";
import { parseTranscriptPath, readSubagentLog } from "@/server/chat/subagent-log";

export const dynamic = "force-dynamic";

/**
 * A delegated sub-agent's live transcript (read-only, owner only, tail of the file, credentials masked).
 * `?path=<transcriptPath>` as a run reports it, or `?profile=&delegationId=&task=`; `?tail=<bytes>` (≤256 KB).
 */
export const GET = api(
  ({ req, user }) => {
    if (user.id !== getOwner()?.id) throw new HttpError(403, "forbidden", "Only the owner can read sub-agent logs");
    const q = req.nextUrl.searchParams;
    const given = q.get("path");
    const ref = given !== null ? parseTranscriptPath(given) : { profile: q.get("profile"), delegationId: q.get("delegationId"), task: q.get("task") };
    if (!ref) throw new HttpError(400, "bad_path", "That isn't a sub-agent transcript path");
    const log = readSubagentLog(ref, q.get("tail"));
    return Response.json(log, { headers: { "cache-control": "no-store" } });
  },
  { cap: "hermes.chat" },
);
