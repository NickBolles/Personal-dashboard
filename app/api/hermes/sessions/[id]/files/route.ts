import { NextResponse } from "next/server";
import { api, readBodyCapped } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { CHAT_FILE_LIMITS } from "@/lib/chat-files";
import { listChatFiles, saveChatFile } from "@/server/chat/files";

export const dynamic = "force-dynamic";

/** Files in this conversation (Links panel → Files). */
export const GET = api<undefined, { id: string }>(({ user, params }) => ({ files: listChatFiles(user, params.id) }), { cap: "hermes.chat" });

/** Upload one attachment (multipart `file`). It stays a draft until a run sends it. */
export const POST = api<undefined, { id: string }>(
  async ({ req, user, params, correlationId }) => {
    const type = req.headers.get("content-type") ?? "";
    if (!type.startsWith("multipart/form-data")) throw new HttpError(415, "multipart_required", "Upload as multipart/form-data");
    const raw = await readBodyCapped(req, CHAT_FILE_LIMITS.fileBytes + 64 * 1024, "File is over 25 MB");
    const form = await new Response(new Uint8Array(raw), { headers: { "content-type": type } }).formData();
    const f = form.get("file");
    if (!f || typeof f === "string") throw new HttpError(400, "file_required", "No file in the upload");
    const file = saveChatFile(user, params.id, { name: f.name || "file", type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }, correlationId);
    return NextResponse.json({ file }, { status: 201, headers: { "cache-control": "no-store" } });
  },
  { cap: "hermes.chat" },
);
