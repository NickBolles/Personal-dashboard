import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { config } from "@/server/config";
import { newId, randomToken, sha256 } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { CAPTURE_LIMITS, type AttachmentView, type CaptureChannel, type CaptureFields, type CaptureTokenView } from "@/lib/ai";
import { captureFollowUp, detectSensitivity, effectiveAreaPolicy } from "@/server/ai/rules";
import { getAiSettings } from "@/server/ai/settings";
import { areaOf, enqueue } from "@/server/ai/jobs";
import { kickRunner } from "@/server/ai/runner";
import { createItem } from "@/server/work/store";
import { declaredMatches, imageSize, sniffMime } from "./sniff";
import { stripLocation } from "./exif";

/**
 * Quick capture (phase 5): text/URL/images into the Work inbox, then (with
 * work.ai and AI on) cheap triage → optional investigation. Capture always
 * works deterministically; AI follow-ups are skipped (with a reason) for
 * finance/credential-looking text, people without work.ai, or AI off.
 * Files live under ${JARVIS_DATA_DIR}/captures/<userId>/<id> (0600), never
 * under public/, and are served only by the authenticated route.
 */

const I = schema.workInbox;
const A = schema.captureAttachments;
const TK = schema.captureTokens;
const nowIso = () => new Date().toISOString();

export const CAPTURE_TOKEN_PREFIX = "jcap_";

// --- Capture tokens ---

function toTokenView(r: typeof TK.$inferSelect): CaptureTokenView {
  return {
    id: r.id,
    label: r.label,
    prefixHint: r.prefixHint,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    useCount: r.useCount,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    ratePerHour: r.ratePerHour,
    ratePerDay: r.ratePerDay,
    investigateMode: r.investigateMode as CaptureTokenView["investigateMode"],
  };
}

export function listCaptureTokens(userId: string) {
  return getDb().select().from(TK).where(eq(TK.userId, userId)).all().map(toTokenView);
}

export function createCaptureToken(
  user: CurrentUser,
  b: { label: string; expiresInDays?: number; ratePerHour?: number; ratePerDay?: number; investigateMode?: "inherit" | "triage_only" | "off" },
  correlationId: string,
) {
  const secret = randomToken(32);
  const token = `${CAPTURE_TOKEN_PREFIX}${secret}`;
  const id = newId("ctk");
  getDb()
    .insert(TK)
    .values({
      id,
      userId: user.id,
      label: b.label,
      tokenHash: sha256(token),
      prefixHint: secret.slice(0, 4),
      ratePerHour: b.ratePerHour ?? 30,
      ratePerDay: b.ratePerDay ?? 300,
      investigateMode: b.investigateMode ?? "inherit",
      expiresAt: new Date(Date.now() + (b.expiresInDays ?? 365) * 86400_000).toISOString(),
    })
    .run();
  audit({ actor: user.id, action: "capture_token.create", source: "capture", sourceRecord: id, result: "ok", correlationId, detail: { label: b.label } });
  return { token, tokenInfo: toTokenView(getDb().select().from(TK).where(eq(TK.id, id)).get()!) };
}

export function revokeCaptureToken(user: CurrentUser, id: string, correlationId: string) {
  const r = getDb()
    .update(TK)
    .set({ revokedAt: nowIso() })
    .where(and(eq(TK.id, id), eq(TK.userId, user.id), isNull(TK.revokedAt)))
    .run();
  if (!r.changes) {
    const exists = getDb()
      .select({ id: TK.id })
      .from(TK)
      .where(and(eq(TK.id, id), eq(TK.userId, user.id)))
      .get();
    if (!exists) throw new HttpError(404, "not_found", "Token not found");
  }
  audit({ actor: user.id, action: "capture_token.revoke", source: "capture", sourceRecord: id, result: "ok", correlationId });
  return { ok: true };
}

/** Resolve a jcap_ bearer token (not revoked, not expired). Nothing else in Jarvis accepts these. */
export function captureTokenFromBearer(token: string) {
  if (!token.startsWith(CAPTURE_TOKEN_PREFIX)) return null;
  const r = getDb()
    .select()
    .from(TK)
    .where(eq(TK.tokenHash, sha256(token)))
    .get();
  if (!r || r.revokedAt || r.expiresAt <= nowIso()) return null;
  return r;
}

/** 429 with retry-after when a token exceeds its hourly/daily budget. */
export function checkTokenRate(t: typeof TK.$inferSelect, now = new Date()) {
  const count = (sinceMs: number) =>
    Number(
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(I)
        .where(and(eq(I.captureTokenId, t.id), gte(I.createdAt, new Date(now.getTime() - sinceMs).toISOString())))
        .get()?.n ?? 0,
    );
  if (count(3600_000) >= t.ratePerHour) return { ok: false as const, retryAfter: 3600 };
  if (count(86400_000) >= t.ratePerDay) return { ok: false as const, retryAfter: 86400 };
  return { ok: true as const };
}

export function touchToken(id: string) {
  getDb()
    .update(TK)
    .set({ lastUsedAt: nowIso(), useCount: sql`${TK.useCount} + 1` })
    .where(eq(TK.id, id))
    .run();
}

// --- Attachments ---

export function capturesDir() {
  return path.join(config.dataDir, "captures");
}

export type IncomingFile = { name: string; type: string; bytes: Uint8Array };

/** Validate every file before anything is written (limits, magic bytes, declared type). */
export function checkFiles(files: IncomingFile[]) {
  if (files.length > CAPTURE_LIMITS.files) throw new HttpError(413, "too_many_files", `At most ${CAPTURE_LIMITS.files} files`);
  return files.map((f) => {
    if (f.bytes.byteLength > CAPTURE_LIMITS.fileBytes) throw new HttpError(413, "file_too_large", `${f.name.slice(0, 60)} is over 10 MB`);
    const mime = sniffMime(f.bytes);
    if (!mime || !declaredMatches(f.type, mime))
      throw new HttpError(415, "unsupported_type", `${f.name.slice(0, 60)}: only PNG, JPEG, WebP, GIF or plain text`);
    return { ...f, mime, size: mime.startsWith("image/") ? imageSize(f.bytes, mime) : null };
  });
}

function removeStoredFiles(rows: { storageKey: string }[]) {
  for (const r of rows)
    try {
      fs.unlinkSync(path.join(capturesDir(), r.storageKey));
    } catch {
      /* already gone */
    }
}

/** Write one file to disk (0600) and return its attachment row; the row is inserted with the entry, in one transaction. */
function storeAttachmentFile(userId: string, inboxId: string, f: ReturnType<typeof checkFiles>[number]): typeof A.$inferInsert {
  const id = newId("att");
  const rel = path.join(userId.replace(/[^A-Za-z0-9_-]/g, ""), id.replace(/[^A-Za-z0-9_-]/g, ""));
  const abs = path.join(capturesDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(abs, f.bytes, { mode: 0o600 });
  return {
    id,
    userId,
    inboxId,
    kind: f.mime === "text/plain" ? "text" : "image",
    mime: f.mime,
    bytes: f.bytes.byteLength,
    sha256: crypto.createHash("sha256").update(f.bytes).digest("hex"),
    storageKey: rel,
    width: f.size?.width ?? null,
    height: f.size?.height ?? null,
  };
}

export function toAttachmentView(a: typeof A.$inferSelect): AttachmentView {
  return {
    id: a.id,
    kind: a.kind as "image" | "text",
    mime: a.mime,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    url: `/api/capture/attachments/${a.id}`,
  };
}

export function attachmentsFor(inboxIds: string[]) {
  if (!inboxIds.length) return new Map<string, AttachmentView[]>();
  const rows = getDb().select().from(A).where(isNull(A.deletedAt)).all();
  const out = new Map<string, AttachmentView[]>();
  for (const r of rows) if (inboxIds.includes(r.inboxId)) out.set(r.inboxId, [...(out.get(r.inboxId) ?? []), toAttachmentView(r)]);
  return out;
}

export function readAttachment(userId: string, id: string) {
  const a = getDb().select().from(A).where(eq(A.id, id)).get();
  if (!a || a.userId !== userId || a.deletedAt) throw new HttpError(404, "not_found", "Attachment not found");
  const abs = path.join(capturesDir(), a.storageKey);
  if (!abs.startsWith(capturesDir() + path.sep) || !fs.existsSync(abs)) throw new HttpError(404, "not_found", "Attachment not found");
  return { row: a, data: fs.readFileSync(abs) };
}

export function deleteAttachment(user: CurrentUser, id: string, correlationId: string) {
  const { row } = readAttachment(user.id, id);
  getDb().update(A).set({ deletedAt: nowIso() }).where(eq(A.id, id)).run();
  try {
    fs.unlinkSync(path.join(capturesDir(), row.storageKey));
  } catch {
    /* already gone */
  }
  audit({ actor: user.id, action: "capture.attachment_delete", source: "capture", sourceRecord: id, result: "ok", correlationId });
  return { ok: true };
}

// --- Create ---

export type CaptureCtx = {
  channel: CaptureChannel;
  deviceId?: string | null;
  token?: typeof TK.$inferSelect | null;
  correlationId: string;
};

export type CaptureResult = { entryId: string; created: boolean; triage: "queued" | "skipped"; reason?: string };

export function createCapture(user: CurrentUser, fields: CaptureFields, files: IncomingFile[], ctx: CaptureCtx): CaptureResult {
  const db = getDb();
  // An offline capture queued by another account on this browser is never filed into this one's inbox.
  if (fields.queuedBy && fields.queuedBy !== user.id) throw new HttpError(409, "wrong_account", "This capture was saved by someone else on this device");
  if (fields.clientCaptureId) {
    const prev = db
      .select()
      .from(I)
      .where(and(eq(I.userId, user.id), eq(I.clientCaptureId, fields.clientCaptureId)))
      .get();
    if (prev)
      return {
        entryId: prev.id,
        created: false,
        triage: prev.triageState === "queued" || prev.triageState === "done" ? "queued" : "skipped",
        reason: prev.triageSkipReason ?? undefined,
      };
  }
  const settings = getAiSettings();
  // Optional (Settings → AI → Captures): drop GPS from photo metadata before anything is stored.
  let locationStripped = 0;
  const checked = checkFiles(files).map((f) => {
    if (!settings.capture.stripLocation || f.mime === "text/plain") return f;
    const r = stripLocation(f.bytes, f.mime);
    if (r.changed) locationStripped++;
    return r.changed ? { ...f, bytes: r.bytes } : f;
  });
  const text = (fields.text ?? "").slice(0, CAPTURE_LIMITS.text);
  const [first, ...rest] = text.split(/\r?\n/);
  const title = (
    fields.title?.trim() ||
    first?.trim() ||
    (fields.url ? new URL(fields.url).hostname : "") ||
    (checked.length ? "Screenshot" : "Capture")
  ).slice(0, 200);
  const note = (fields.title?.trim() ? text : [first && first.length > 200 ? first.slice(200) : "", ...rest].join("\n")).trim().slice(0, CAPTURE_LIMITS.text);
  if (!title && !note && !fields.url && !checked.length) throw new HttpError(400, "empty", "Write something to capture");
  const sensitivity = detectSensitivity([title, note, fields.url ?? ""].join("\n"));
  const id = newId("inb");
  const at = nowIso();
  // Files first, then the entry and its attachment rows atomically: a failed write (e.g. disk full) leaves
  // no entry behind, so an offline replay with the same clientCaptureId saves the whole capture again.
  const rows: (typeof A.$inferInsert)[] = [];
  try {
    for (const f of checked) rows.push(storeAttachmentFile(user.id, id, f));
  } catch {
    removeStoredFiles(rows);
    throw new HttpError(507, "storage_failed", "Couldn't save the attachments; try again");
  }
  try {
    db.transaction((tx) => {
      tx.insert(I)
        .values({
          id,
          userId: user.id,
          source: "capture",
          title,
          note,
          url: fields.url || null,
          reason: ctx.channel === "pwa_share" ? "You shared it" : ctx.channel === "shortcut" ? "Captured from a shortcut" : "You captured it",
          channel: ctx.channel,
          deviceId: ctx.deviceId ?? null,
          captureTokenId: ctx.token?.id ?? null,
          clientCaptureId: fields.clientCaptureId ?? null,
          sensitivity,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      for (const r of rows) tx.insert(A).values(r).run();
    });
  } catch (e) {
    removeStoredFiles(rows);
    throw e;
  }
  if (ctx.token) touchToken(ctx.token.id);
  audit({
    actor: user.id,
    action: "capture.create",
    source: "capture",
    sourceRecord: id,
    result: "ok",
    correlationId: ctx.correlationId,
    detail: { channel: ctx.channel, files: checked.length, token: ctx.token?.id ?? null, ...(locationStripped ? { locationStripped } : {}) },
  });
  // Follow-up decision.
  const mode = captureFollowUp(settings.capture.auto, ctx.token?.investigateMode as "inherit" | "triage_only" | "off" | undefined, fields.investigate);
  const skip = (reason: string): CaptureResult => {
    db.update(I).set({ triageState: "skipped", triageSkipReason: reason }).where(eq(I.id, id)).run();
    return { entryId: id, created: true, triage: "skipped", reason };
  };
  if (fields.parentId) fileDirect(user, id, fields.parentId, ctx.correlationId);
  if (!user.capabilities.has("work.ai")) return skip("ai_not_allowed");
  if (!settings.enabled) return skip("ai_disabled");
  if (sensitivity === "credentials") return skip("credentials_detected");
  if (sensitivity === "finance") return skip("finance_detected");
  if (mode === "off") return skip("off");
  return queueFollowUp(user, id, mode, ctx.correlationId);
}

function queueFollowUp(user: CurrentUser, id: string, mode: "triage_and_investigate" | "triage_only", correlationId: string): CaptureResult {
  const entry = getDb().select().from(I).where(eq(I.id, id)).get()!;
  try {
    if (entry.acceptedItemId) {
      // Filed directly: no triage needed; investigate it if allowed.
      if (mode === "triage_only") throw new Error("triage_only");
      enqueue({
        userId: user.id,
        kind: "investigate",
        subjectType: "inbox",
        subjectId: id,
        clientKey: `cap${id.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`,
        correlationId,
      });
    } else {
      enqueue({
        userId: user.id,
        kind: "triage",
        subjectType: "inbox",
        subjectId: id,
        clientKey: `cap${id.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`,
        params: { investigateMode: mode === "triage_only" ? "triage_only" : "auto" },
        correlationId,
      });
    }
    getDb().update(I).set({ triageState: "queued" }).where(eq(I.id, id)).run();
    kickRunner();
    return { entryId: id, created: true, triage: "queued" };
  } catch (e) {
    const reason = e instanceof HttpError ? e.code : "skipped";
    getDb().update(I).set({ triageState: "skipped", triageSkipReason: reason }).where(eq(I.id, id)).run();
    return { entryId: id, created: true, triage: "skipped", reason };
  }
}

function fileDirect(user: CurrentUser, inboxId: string, parentId: string, correlationId: string) {
  const parent = getDb()
    .select()
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, parentId), eq(schema.workItems.userId, user.id)))
    .get();
  if (!parent) return;
  const e = getDb().select().from(I).where(eq(I.id, inboxId)).get()!;
  const item = createItem(user, { kind: "thread", parentId, title: e.title, summary: e.note }, correlationId);
  getDb().update(I).set({ acceptedAt: nowIso(), acceptedItemId: item.id, updatedAt: nowIso() }).where(eq(I.id, inboxId)).run();
  moveCaptureToItem(e, item.id);
}

/**
 * Filing a capture: its attachments move to the item, and the captured URL plus
 * each attachment become links on the item, so nothing is lost once the entry
 * leaves the inbox (attachment links stay owner-only via /api/capture/attachments).
 */
export function moveCaptureToItem(entry: { id: string; url: string | null; title: string }, itemId: string) {
  const db = getDb();
  db.update(A).set({ itemId }).where(eq(A.inboxId, entry.id)).run();
  const L = schema.workLinks;
  const have = new Set(
    db
      .select({ url: L.url })
      .from(L)
      .where(eq(L.itemId, itemId))
      .all()
      .map((l) => l.url),
  );
  const add = (url: string, title: string) => {
    if (have.has(url)) return;
    have.add(url);
    db.insert(L)
      .values({ id: newId(), itemId, kind: "url", url, title: title.slice(0, 300), role: "source" })
      .run();
  };
  if (entry.url) {
    let host = entry.url;
    try {
      host = new URL(entry.url).hostname;
    } catch {
      /* keep the raw url as the title */
    }
    add(entry.url, entry.title && entry.title !== host ? entry.title : host);
  }
  const atts = db
    .select()
    .from(A)
    .where(and(eq(A.inboxId, entry.id), isNull(A.deletedAt)))
    .all();
  atts.forEach((a, i) => add(toAttachmentView(a).url, `${a.kind === "image" ? "Captured image" : "Captured text"}${atts.length > 1 ? ` ${i + 1}` : ""}`));
}

/** Manual (re-)investigate from the inbox; "Send anyway" passes financeOverride (never for credentials or excluded areas). */
export function investigateEntry(
  user: CurrentUser,
  id: string,
  b: { model?: string; instructions?: string; budgetOverride?: boolean; financeOverride?: boolean },
  correlationId: string,
) {
  const e = getDb()
    .select()
    .from(I)
    .where(and(eq(I.id, id), eq(I.userId, user.id)))
    .get();
  if (!e || e.source !== "capture") throw new HttpError(404, "not_found", "Capture not found");
  if (e.sensitivity === "credentials") throw new HttpError(403, "ai_sensitive", "Not sent to AI: it looks like it contains a credential.");
  if (e.acceptedItemId && effectiveAreaPolicy(areaOf(user.id, e.acceptedItemId)) === "excluded")
    throw new HttpError(403, "ai_excluded_area", "AI actions are off for this area.");
  const r = enqueue({
    userId: user.id,
    kind: "investigate",
    subjectType: "inbox",
    subjectId: id,
    clientKey: newId("inv")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 40),
    model: b.model ?? null,
    params: { ...(b.instructions ? { instructions: b.instructions } : {}), ...(b.financeOverride ? { financeOverride: true } : {}) },
    budgetOverride: b.budgetOverride,
    financeOverride: b.financeOverride,
    correlationId,
  });
  kickRunner();
  return r;
}

export function captureStatus(userId: string, id: string, tokenId?: string) {
  const e = getDb()
    .select()
    .from(I)
    .where(and(eq(I.id, id), eq(I.userId, userId)))
    .get();
  if (!e || e.source !== "capture" || (tokenId && e.captureTokenId !== tokenId)) throw new HttpError(404, "not_found", "Capture not found");
  return { id: e.id, createdAt: e.createdAt, triageState: e.triageState, suggestedTitle: e.suggestedTitle ?? undefined, reportReady: !!e.latestReportId };
}
