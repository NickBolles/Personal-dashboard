"use client";

/**
 * Tiny IndexedDB key-value store for drafts and bounded last-known snapshots.
 * Falls back to localStorage when IndexedDB is unavailable. Never store
 * secrets or auth responses here.
 */
const DB = "jarvis";
const STORE = "kv";
let dbp: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function hasIdb() {
  return typeof indexedDB !== "undefined";
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    if (!hasIdb()) throw new Error("no idb");
    const db = await open();
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } catch {
    try {
      const v = localStorage.getItem(`jarvis:${key}`);
      return v ? (JSON.parse(v) as T) : undefined;
    } catch {
      return undefined;
    }
  }
}

export async function kvSet(key: string, value: unknown) {
  try {
    if (!hasIdb()) throw new Error("no idb");
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try {
      localStorage.setItem(`jarvis:${key}`, JSON.stringify(value));
    } catch {
      /* storage full or blocked */
    }
  }
}

export async function kvDel(key: string) {
  try {
    if (!hasIdb()) throw new Error("no idb");
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try {
      localStorage.removeItem(`jarvis:${key}`);
    } catch {
      /* ignore */
    }
  }
}

/** Keep only the N most recent session snapshots. */
export async function rememberSession(id: string, data: unknown, limit = 10) {
  const index = ((await kvGet<string[]>("sessions:index")) ?? []).filter((x) => x !== id);
  index.unshift(id);
  for (const old of index.slice(limit)) await kvDel(`session:${old}`);
  await kvSet("sessions:index", index.slice(0, limit));
  await kvSet(`session:${id}`, { savedAt: new Date().toISOString(), data });
}

export async function clearAllLocal() {
  try {
    if (hasIdb()) indexedDB.deleteDatabase(DB);
  } catch {
    /* ignore */
  }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("jarvis:")) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
