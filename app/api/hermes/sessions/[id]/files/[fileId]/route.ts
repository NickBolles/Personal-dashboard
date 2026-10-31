import { api } from "@/server/http/api";
import { chatFileThumbnail, deleteChatFile, readChatFile } from "@/server/chat/files";

export const dynamic = "force-dynamic";

const HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store, private",
  "content-security-policy": "default-src 'none'; sandbox",
};

/** Download (or `?thumb=1` preview). Same access as the conversation; drafts only for their uploader. */
export const GET = api<undefined, { id: string; fileId: string }>(
  async ({ req, user, params }) => {
    if (new URL(req.url).searchParams.get("thumb")) {
      const t = await chatFileThumbnail(user, params.id, params.fileId);
      return new Response(new Uint8Array(t.data), { headers: { ...HEADERS, "content-type": t.mime, "content-length": String(t.data.byteLength) } });
    }
    const { row, data } = readChatFile(user, params.id, params.fileId);
    const safe = row.name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || row.id;
    return new Response(new Uint8Array(data), {
      headers: {
        ...HEADERS,
        "content-type": row.mime,
        "content-length": String(data.byteLength),
        "content-disposition": `${row.kind === "image" ? "inline" : "attachment"}; filename="${safe}"`,
      },
    });
  },
  { cap: "hermes.chat" },
);

export const DELETE = api<undefined, { id: string; fileId: string }>(
  ({ user, params, correlationId }) => deleteChatFile(user, params.id, params.fileId, correlationId),
  { cap: "hermes.chat" },
);
