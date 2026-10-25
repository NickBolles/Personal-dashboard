/* Jarvis service worker.
 * - App shell: hashed static assets cache-first; pages network-first with an offline fallback.
 * - Private pages (Finance, Chat, Settings, People) are never cached, and the page
 *   cache is wiped on sign-out (postMessage "CLEAR_PRIVATE" from the page).
 * - API responses are never cached here (auth + live data). Bounded snapshots live in IndexedDB.
 * - Web Push: show notifications and deep-link to the exact context on click.
 * - POST share target (/share-target): stage the shared text/files in IndexedDB
 *   (jarvis-share) and open /share?staged=<id>; nothing is sent until the person saves.
 * - Background Sync "capture-flush": send captures queued offline (jarvis-capture-queue).
 */
const VERSION = "jarvis-sw-v3";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const PRECACHE = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/badge-72.png"];
const MAX_PAGES = 30;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  if (event.data === "CLEAR_PRIVATE") {
    // Signed out: forget every cached page (they're one person's data).
    event.waitUntil(caches.delete(PAGES).then(() => event.source?.postMessage?.("CLEARED_PRIVATE")));
  }
});

/** Pages that hold one person's private data: always network, never cached. */
const NO_CACHE = ["/login", "/onboarding", "/join", "/finance", "/chat", "/settings", "/people"];
function cacheable(pathname) {
  return !NO_CACHE.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

async function trimPages() {
  const cache = await caches.open(PAGES);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(k);
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

const SHARE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"];
const SHARE_MAX_FILES = 4;
const SHARE_MAX_BYTES = 10 * 1024 * 1024;

function idb(name, store, key) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store, { keyPath: key });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbReq(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const q = fn(db.transaction(store, mode).objectStore(store));
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}

async function handleShareTarget(req) {
  try {
    const form = await req.formData();
    const files = [];
    const rejected = [];
    for (const f of form.getAll("files")) {
      if (typeof f === "string") continue;
      if (files.length >= SHARE_MAX_FILES || !SHARE_TYPES.includes(f.type) || f.size > SHARE_MAX_BYTES) rejected.push(String(f.name || "file").slice(0, 80));
      else files.push({ name: f.name || "shared", type: f.type, blob: f });
    }
    const str = (k) => (typeof form.get(k) === "string" ? String(form.get(k)).slice(0, 8000) : undefined);
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const db = await idb("jarvis-share", "staged", "id");
    await idbReq(db, "staged", "readwrite", (s) => s.put({ id, title: str("title"), text: str("text"), url: str("url"), files, rejected, createdAt: new Date().toISOString() }));
    // Keep the 10 newest.
    const all = await idbReq(db, "staged", "readonly", (s) => s.getAll());
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const old of all.slice(10)) await idbReq(db, "staged", "readwrite", (s) => s.delete(old.id));
    db.close();
    return Response.redirect(new URL(`/share?staged=${id}`, self.location.origin).href, 303);
  } catch {
    return Response.redirect(new URL("/share?error=sw", self.location.origin).href, 303);
  }
}

async function flushCaptureQueue() {
  const db = await idb("jarvis-capture-queue", "queue", "clientCaptureId");
  const list = (await idbReq(db, "queue", "readonly", (s) => s.getAll())).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const q of list) {
    if (q.failed) continue;
    const fd = new FormData();
    for (const [k, v] of Object.entries(q.fields || {})) if (v) fd.set(k, v);
    fd.set("clientCaptureId", q.clientCaptureId);
    if (q.userId) fd.set("queuedBy", q.userId);
    for (const f of q.files || []) fd.append("files", f.blob, f.name);
    let res;
    try {
      res = await fetch("/api/capture", { method: "POST", body: fd, headers: { "x-jarvis-csrf": "1" }, credentials: "same-origin" });
    } catch {
      break; // still offline: keep everything
    }
    // Queued by someone else on this browser: leave it for them (the server refused it).
    if (res.status === 409) continue;
    const keep = res.status >= 500 || [401, 408, 429].includes(res.status);
    if (!keep) await idbReq(db, "queue", "readwrite", (s) => s.delete(q.clientCaptureId));
    else {
      const attempts = (q.attempts || 0) + 1;
      await idbReq(db, "queue", "readwrite", (s) => s.put({ ...q, attempts, lastError: `HTTP ${res.status}`, failed: attempts >= 5 }));
    }
  }
  db.close();
}

self.addEventListener("sync", (event) => {
  if (event.tag === "capture-flush") event.waitUntil(flushCaptureQueue());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method === "POST" && new URL(req.url).pathname === "/share-target" && new URL(req.url).origin === self.location.origin) {
    event.respondWith(handleShareTarget(req));
    return;
  }
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API, auth, or streams.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/")) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGES);
        try {
          const res = await Promise.race([fetch(req), timeout(4000)]);
          // Only cache successful, same-page responses (not login redirects).
          if (res.ok && !res.redirected && cacheable(url.pathname)) {
            cache.put(url.pathname, res.clone());
            trimPages();
          }
          return res;
        } catch {
          const hit = cacheable(url.pathname) ? (await cache.match(url.pathname)) || (await cache.match("/home")) : undefined;
          if (hit) return hit;
          return (await caches.match("/offline")) || new Response("Offline", { status: 503 });
        }
      })(),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Jarvis", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Jarvis";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: data.tag || data.id,
      renotify: data.severity === "critical",
      requireInteraction: data.severity === "critical",
      data: { url: data.url || "/alerts", id: data.id },
      // Inbox "Report ready": Open report / File it (filing happens in the page, with CSRF).
      ...(data.actions ? { actions: data.actions } : {}),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = event.notification.data?.url || "/alerts";
  if (event.action === "file" && url.includes("view=inbox")) url += (url.includes("?") ? "&" : "?") + "do=file";
  const target = new URL(url, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) return client.navigate(target);
          return;
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
