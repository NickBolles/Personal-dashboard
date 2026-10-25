import { api } from "@/server/http/api";
import { deleteAttachment, readAttachment } from "@/server/capture";

export const dynamic = "force-dynamic";

/** Owner-only file download: stored MIME, nosniff, never cached. */
export const GET = api<undefined, { id: string }>(
  ({ user, params }) => {
    const { row, data } = readAttachment(user.id, params.id);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": row.mime,
        "content-length": String(data.byteLength),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store, private",
        "content-disposition": row.kind === "image" ? "inline" : `attachment; filename="${row.id}.txt"`,
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  },
  { cap: "work.use" },
);

export const DELETE = api<undefined, { id: string }>(({ user, params, correlationId }) => deleteAttachment(user, params.id, correlationId), {
  cap: "work.use",
});
