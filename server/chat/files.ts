import "server-only";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { config } from "@/server/config";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { isLocalSession } from "@/lib/assistant";
import { sessionAccess } from "@/integrations/hermes/service";
import { localSessionDetail } from "@/server/assistant/local";
import { getAiSettings } from "@/server/ai/settings";
import { isFinanceContext } from "@/lib/chat-context";
import { CHAT_FILE_LIMITS, classifyChatFile, fencedAttachment, FILE_MARK, type ChatFileKind, type ChatFileView } from "@/lib/chat-files";
import { imageSize, sniffMime } from "@/server/capture/sniff";
import { stripLocation } from "@/server/capture/exif";
import { extractPdfText } from "./pdf-text";

const T = schema.chatFiles;
const db = () => getDb();
/** Draft (never sent) files older than this are removed on the next upload. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest side of the copy sent to Hermes (its API caps a request at 10 MB). */
const MODEL_IMAGE_PX = 1600;
const THUMB_PX = 320;

export function chatFilesDir() {
  return path.join(config.dataDir, "chat-files");
}

/** Same rules as the conversation: owner/editors write, shared viewers read. */
export function conversationAccess(user: CurrentUser, sessionId: string): "read" | "write" {
  if (isLocalSession(sessionId)) {
    const d = localSessionDetail(user, sessionId); // throws 404 without access
    return d.session.readOnly ? "read" : "write";
  }
  const a = sessionAccess(user, sessionId);
  if (!a) throw new HttpError(404, "session_not_found", "Conversation not found");
  return a;
}

function view(r: typeof T.$inferSelect): ChatFileView {
  return {
    id: r.id,
    sessionId: r.sessionId,
    name: r.name,
    mime: r.mime,
    kind: r.kind as ChatFileKind,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    textStatus: (r.textStatus as ChatFileView["textStatus"]) ?? null,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
    locationRemoved: r.locationRemoved,
  };
}

/** Files that went out with a message in this conversation (Links panel → Files), newest first. */
export function listChatFiles(user: CurrentUser, sessionId: string): ChatFileView[] {
  conversationAccess(user, sessionId);
  return db()
    .select()
    .from(T)
    .where(eq(T.sessionId, sessionId))
    .orderBy(desc(T.createdAt))
    .all()
    .filter((r) => r.sentAt || r.userId === user.id)
    .map(view);
}

export type Upload = { name: string; type: string; bytes: Uint8Array };

/** Checks everything (type by magic bytes, size, finance) before anything is written. */
export function checkUpload(f: Upload): {
  kind: ChatFileKind;
  mime: string;
  bytes: Uint8Array;
  text: string | null;
  width: number | null;
  height: number | null;
  locationRemoved: boolean;
  textStatus: ChatFileView["textStatus"];
} {
  const name = (f.name || "file").slice(0, 200);
  const c = classifyChatFile(name, f.type, f.bytes.byteLength);
  if (!c.ok) throw new HttpError(c.reason.includes(" over ") ? 413 : 415, c.reason.includes(" over ") ? "file_too_large" : "unsupported_type", c.reason);
  if (isFinanceContext({ id: name })) throw new HttpError(403, "finance_blocked", "Finance files aren't sent to AI");
  let bytes = f.bytes;
  if (c.kind === "image") {
    const mime = sniffMime(bytes);
    if (!mime || !mime.startsWith("image/")) throw new HttpError(415, "unsupported_type", `${name.slice(0, 60)} isn't a PNG, JPEG, WebP or GIF picture`);
    let locationRemoved = false;
    if (getAiSettings().capture.stripLocation) {
      const r = stripLocation(new Uint8Array(bytes), mime);
      if (r.changed) {
        bytes = r.bytes;
        locationRemoved = true;
      }
    }
    const size = imageSize(bytes, mime);
    return { kind: "image", mime, bytes, text: null, width: size?.width ?? null, height: size?.height ?? null, locationRemoved, textStatus: null };
  }
  if (c.kind === "pdf") {
    if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new HttpError(415, "unsupported_type", `${name.slice(0, 60)} isn't a PDF`);
    const text = extractPdfText(bytes, CHAT_FILE_LIMITS.textChars + 1);
    const status = !text ? "none" : text.length > CHAT_FILE_LIMITS.textChars ? "truncated" : "ok";
    return {
      kind: "pdf",
      mime: "application/pdf",
      bytes,
      text: text.slice(0, CHAT_FILE_LIMITS.textChars) || null,
      width: null,
      height: null,
      locationRemoved: false,
      textStatus: status,
    };
  }
  if (sniffMime(bytes) !== "text/plain") throw new HttpError(415, "unsupported_type", `${name.slice(0, 60)} isn't plain UTF-8 text`);
  const full = new TextDecoder().decode(bytes);
  const status = full.length > CHAT_FILE_LIMITS.textChars ? "truncated" : "ok";
  return {
    kind: "text",
    mime: "text/plain",
    bytes,
    text: full.slice(0, CHAT_FILE_LIMITS.textChars),
    width: null,
    height: null,
    locationRemoved: false,
    textStatus: status,
  };
}

export function saveChatFile(user: CurrentUser, sessionId: string, f: Upload, correlationId: string): ChatFileView {
  if (conversationAccess(user, sessionId) !== "write") throw new HttpError(403, "read_only", "This conversation is read-only");
  pruneDrafts(user.id);
  const drafts = db()
    .select({ id: T.id })
    .from(T)
    .where(and(eq(T.sessionId, sessionId), eq(T.userId, user.id), isNull(T.sentAt)))
    .all();
  if (drafts.length >= CHAT_FILE_LIMITS.perMessage * 2) throw new HttpError(429, "too_many_files", "Send or remove some attachments first");
  const c = checkUpload(f);
  const id = newId("cf");
  const rel = path.join(user.id.replace(/[^A-Za-z0-9_-]/g, ""), id.replace(/[^A-Za-z0-9_-]/g, ""));
  const abs = path.join(chatFilesDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(abs, c.bytes, { mode: 0o600 });
  const row = db()
    .insert(T)
    .values({
      id,
      sessionId,
      userId: user.id,
      name: (f.name || "file").replace(/[\r\n\0]/g, " ").slice(0, 200),
      mime: c.mime,
      kind: c.kind,
      bytes: c.bytes.byteLength,
      width: c.width,
      height: c.height,
      storageKey: rel,
      extractedText: c.text,
      textStatus: c.textStatus,
      locationRemoved: c.locationRemoved,
    })
    .returning()
    .get();
  audit({
    actor: user.id,
    action: "chat.file.upload",
    source: "jarvis",
    sourceRecord: sessionId,
    result: "ok",
    correlationId,
    detail: { id, kind: c.kind, bytes: c.bytes.byteLength, locationRemoved: c.locationRemoved },
  });
  return view(row);
}

function rowFor(user: CurrentUser, sessionId: string, id: string) {
  conversationAccess(user, sessionId);
  const r = db()
    .select()
    .from(T)
    .where(and(eq(T.id, id), eq(T.sessionId, sessionId)))
    .get();
  // Drafts are private to the person composing; sent files follow the conversation.
  if (!r || (!r.sentAt && r.userId !== user.id)) throw new HttpError(404, "not_found", "File not found");
  return r;
}

export function readChatFile(user: CurrentUser, sessionId: string, id: string) {
  const row = rowFor(user, sessionId, id);
  const data = fs.readFileSync(path.join(chatFilesDir(), row.storageKey));
  return { row, data };
}

/** Small JPEG/PNG preview for chips, bubbles and the Files panel (GIF/WebP as-is when sharp is missing). */
export async function chatFileThumbnail(user: CurrentUser, sessionId: string, id: string): Promise<{ mime: string; data: Uint8Array }> {
  const { row, data } = readChatFile(user, sessionId, id);
  if (row.kind !== "image") throw new HttpError(404, "not_found", "No preview");
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(data, { animated: false })
      .rotate()
      .resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    return { mime: "image/webp", data: new Uint8Array(out) };
  } catch {
    return { mime: row.mime, data: new Uint8Array(data) };
  }
}

export function deleteChatFile(user: CurrentUser, sessionId: string, id: string, correlationId: string) {
  const row = rowFor(user, sessionId, id);
  if (row.userId !== user.id && conversationAccess(user, sessionId) !== "write") throw new HttpError(403, "forbidden", "You can't remove this file");
  db().delete(T).where(eq(T.id, id)).run();
  removeStored([row]);
  audit({ actor: user.id, action: "chat.file.delete", source: "jarvis", sourceRecord: sessionId, result: "ok", correlationId, detail: { id } });
  return { ok: true };
}

function removeStored(rows: { storageKey: string }[]) {
  for (const r of rows)
    try {
      fs.unlinkSync(path.join(chatFilesDir(), r.storageKey));
    } catch {
      /* already gone */
    }
}

function pruneDrafts(userId: string) {
  const cutoff = new Date(Date.now() - DRAFT_TTL_MS).toISOString();
  const old = db()
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), isNull(T.sentAt)))
    .all()
    .filter((r) => r.createdAt < cutoff);
  if (!old.length) return;
  db()
    .delete(T)
    .where(
      inArray(
        T.id,
        old.map((r) => r.id),
      ),
    )
    .run();
  removeStored(old);
}

/** Image as a data URL for Hermes: downscaled + re-encoded (drops all metadata) so a message stays under Hermes' 10 MB cap. */
async function modelImageUrl(row: typeof T.$inferSelect, data: Buffer): Promise<string> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(data, { animated: false })
      .rotate()
      .resize(MODEL_IMAGE_PX, MODEL_IMAGE_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    if (data.byteLength > 1.4 * 1024 * 1024) throw new HttpError(413, "image_too_large", `${row.name.slice(0, 60)} is too large to send without resizing`);
    return `data:${row.mime};base64,${data.toString("base64")}`;
  }
}

export type PreparedFiles = { imageUrls: string[]; textBlocks: string[]; marker: string; ids: string[] };

/** Draft files picked for this message → image parts + fenced text blocks + the hidden bubble marker. */
export async function prepareRunFiles(user: CurrentUser, sessionId: string, ids: string[]): Promise<PreparedFiles | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  if (unique.length > CHAT_FILE_LIMITS.perMessage) throw new HttpError(400, "too_many_files", `At most ${CHAT_FILE_LIMITS.perMessage} files per message`);
  if (conversationAccess(user, sessionId) !== "write") throw new HttpError(403, "read_only", "This conversation is read-only");
  const rows = db()
    .select()
    .from(T)
    .where(and(inArray(T.id, unique), eq(T.sessionId, sessionId), eq(T.userId, user.id)))
    .all();
  if (rows.length !== unique.length) throw new HttpError(404, "file_not_found", "An attachment is gone — attach it again");
  const ordered = unique.map((id) => rows.find((r) => r.id === id)!);
  const imageUrls: string[] = [];
  const textBlocks: string[] = [];
  for (const r of ordered) {
    if (isFinanceContext({ id: r.name })) throw new HttpError(403, "finance_blocked", "Finance files aren't sent to AI");
    if (r.kind === "image") imageUrls.push(await modelImageUrl(r, fs.readFileSync(path.join(chatFilesDir(), r.storageKey))));
    else if (r.extractedText)
      textBlocks.push(fencedAttachment(r.name, r.extractedText, r.textStatus === "truncated" ? `first ${CHAT_FILE_LIMITS.textChars} characters` : undefined));
    else textBlocks.push(`Attached file: ${r.name.replace(/[\r\n`]/g, " ")} (PDF attached — text not extracted; it may be a scan)`);
  }
  const marker = `Attachments: ${ordered.map((r) => `${FILE_MARK}${r.id}`).join(" ")}`;
  return { imageUrls, textBlocks, marker, ids: unique };
}

export function markFilesSent(ids: string[], runId: string) {
  if (!ids.length) return;
  db().update(T).set({ runId, sentAt: new Date().toISOString() }).where(inArray(T.id, ids)).run();
}
