"use client";

/**
 * Offline capture queue (spec §10.3) and the share-target staging store, both
 * in IndexedDB. Queued captures carry a clientCaptureId so the server dedupes
 * replays: a capture made offline is delivered exactly once.
 */

export type QueuedCapture = {
  clientCaptureId: string;
  fields: Record<string, string>;
  files: { name: string; type: string; blob: Blob }[];
  createdAt: string;
  attempts: number;
  lastError?: string;
  failed?: boolean;
  /** the account that queued it: replays carry it and the server refuses another account (409) */
  userId?: string;
};

const QUEUE_DB = "jarvis-capture-queue";
const SHARE_DB = "jarvis-share";
export const QUEUE_MAX = 50;
export const QUEUE_MAX_BYTES = 50 * 1024 * 1024;
export const QUEUE_EVENT = "jarvis:capture-queue";

function open(name: string, store: string, key: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store, { keyPath: key });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const queueDb = () => open(QUEUE_DB, "queue", "clientCaptureId");

export async function listQueue(): Promise<QueuedCapture[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await queueDb();
  const all = await tx<QueuedCapture[]>(db, "queue", "readonly", (s) => s.getAll() as IDBRequest<QueuedCapture[]>);
  db.close();
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function queueCapture(item: QueuedCapture) {
  const list = await listQueue();
  const bytes = list.reduce((n, q) => n + q.files.reduce((m, f) => m + f.blob.size, 0), 0) + item.files.reduce((m, f) => m + f.blob.size, 0);
  if (list.length >= QUEUE_MAX || bytes > QUEUE_MAX_BYTES) throw new Error("This phone's capture queue is full. Reconnect to send what's waiting.");
  const db = await queueDb();
  await tx(db, "queue", "readwrite", (s) => s.put(item));
  db.close();
  notifyQueue();
  try {
    // getRegistration() resolves (possibly undefined) right away; `ready` would hang without an active worker.
    const reg = await navigator.serviceWorker?.getRegistration();
    await (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } })?.sync?.register("capture-flush");
  } catch {
    /* Background Sync isn't everywhere; the page flushes on online/visibility */
  }
}

async function removeQueued(id: string) {
  const db = await queueDb();
  await tx(db, "queue", "readwrite", (s) => s.delete(id));
  db.close();
}

/** Failed captures: try them again, or drop them. */
export async function retryFailed() {
  const db = await queueDb();
  for (const q of await listQueue()) if (q.failed) await tx(db, "queue", "readwrite", (s) => s.put({ ...q, failed: false, attempts: 0 }));
  db.close();
  notifyQueue();
  return flushQueue();
}

export async function discardFailed() {
  const db = await queueDb();
  for (const q of await listQueue()) if (q.failed) await tx(db, "queue", "readwrite", (s) => s.delete(q.clientCaptureId));
  db.close();
  notifyQueue();
}

export async function clearQueue() {
  const db = await queueDb();
  await tx(db, "queue", "readwrite", (s) => s.clear());
  db.close();
  notifyQueue();
}

function notifyQueue() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(QUEUE_EVENT));
}

export function captureForm(fields: Record<string, string>, files: { name: string; blob: Blob }[]) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) fd.set(k, v);
  for (const f of files) fd.append("files", f.blob, f.name);
  return fd;
}

export type SendResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string; code?: string; retry: boolean };

/** POST one capture. Network errors, 5xx, 401, 408 and 429 are retryable (kept in the queue). */
export async function sendCapture(fields: Record<string, string>, files: { name: string; blob: Blob }[]): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch("/api/capture", { method: "POST", body: captureForm(fields, files), headers: { "x-jarvis-csrf": "1" }, credentials: "same-origin" });
  } catch {
    return { ok: false, status: 0, error: "offline", retry: true };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, body };
  const retry = res.status >= 500 || [401, 408, 429].includes(res.status);
  const b = body as { error?: string; code?: string };
  return { ok: false, status: res.status, error: b.error ?? `Failed (${res.status})`, code: b.code, retry };
}

let flushing = false;
/** Send everything waiting, oldest first. Max 5 attempts per capture, then marked failed. */
export async function flushQueue() {
  if (flushing || typeof indexedDB === "undefined") return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const q of await listQueue()) {
      if (q.failed) continue;
      const r = await sendCapture({ ...q.fields, clientCaptureId: q.clientCaptureId, ...(q.userId ? { queuedBy: q.userId } : {}) }, q.files);
      // Saved by another account on this browser: leave it for them.
      if (r.status === 409 && !r.ok && r.code === "wrong_account") continue;
      if (r.ok) {
        await removeQueued(q.clientCaptureId);
        sent++;
        continue;
      }
      if (!r.retry) {
        // Refused (e.g. 413 over the request limit): keep it as failed so the person can recover or discard it.
        const db = await queueDb();
        await tx(db, "queue", "readwrite", (s) => s.put({ ...q, attempts: q.attempts + 1, lastError: r.error, failed: true }));
        db.close();
        continue;
      }
      if (r.status === 0) break; // still offline
      const db = await queueDb();
      await tx(db, "queue", "readwrite", (s) => s.put({ ...q, attempts: q.attempts + 1, lastError: r.error, failed: q.attempts + 1 >= 5 }));
      db.close();
    }
  } finally {
    flushing = false;
    notifyQueue();
  }
  return sent;
}

// --- Share target staging (written by public/sw.js) ---

export type StagedShare = {
  id: string;
  title?: string;
  text?: string;
  url?: string;
  files: { name: string; type: string; blob: Blob }[];
  rejected?: string[];
  createdAt: string;
};

export async function readStaged(id: string): Promise<StagedShare | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await open(SHARE_DB, "staged", "id");
  const row = await tx<StagedShare | undefined>(db, "staged", "readonly", (s) => s.get(id) as IDBRequest<StagedShare | undefined>);
  db.close();
  return row ?? null;
}

export async function deleteStaged(id: string) {
  const db = await open(SHARE_DB, "staged", "id");
  await tx(db, "staged", "readwrite", (s) => s.delete(id));
  db.close();
}

export function newClientCaptureId() {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
}
