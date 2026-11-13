/* Jarvis service worker.
 * - App shell: hashed static assets cache-first; pages network-first with an offline fallback.
 *   A cached page from an older build than the newest known release is not served on a merely
 *   slow network (it would boot an outdated app); see handleNavigate.
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
  if (event.data && event.data.type === "BUILD") event.waitUntil(noteBuild(String(event.data.build || "").trim()));
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
    const retry = res.status >= 500 || [401, 408, 429].includes(res.status);
    const attempts = (q.attempts || 0) + 1;
    if (res.ok) await idbReq(db, "queue", "readwrite", (s) => s.delete(q.clientCaptureId));
    // Refused for good (e.g. 413): kept as failed so the page can offer Retry / Discard.
    else await idbReq(db, "queue", "readwrite", (s) => s.put({ ...q, attempts, lastError: `HTTP ${res.status}`, failed: !retry || attempts >= 5 }));
  }
  db.close();
}

self.addEventListener("sync", (event) => {
  if (event.tag === "capture-flush") event.waitUntil(flushCaptureQueue());
});

/*
 * Newest release build this worker has seen: from the `x-jarvis-build` header of a page that came
 * from the network, or from the page itself (`{type: "BUILD"}` after `/api/health` reported a new
 * deploy). Persisted in a tiny meta cache so it survives the worker being stopped.
 */
const META = `${VERSION}-meta`;
const BUILD_KEY = "/__jarvis-build";
let latestBuild = null;

function validBuild(id) {
  return typeof id === "string" && /^[0-9a-f]{7,64}$/i.test(id);
}

async function noteBuild(id) {
  if (!validBuild(id) || id === latestBuild) return;
  latestBuild = id;
  try {
    const meta = await caches.open(META);
    await meta.put(BUILD_KEY, new Response(id));
  } catch {
    // storage full / unavailable: the in-memory value still applies
  }
}

async function knownBuild() {
  if (latestBuild) return latestBuild;
  try {
    const meta = await caches.open(META);
    const hit = await meta.match(BUILD_KEY);
    const id = hit ? (await hit.text()).trim() : "";
    if (validBuild(id)) latestBuild = id;
  } catch {
    // ignore
  }
  return latestBuild;
}

/** A cached page from an older (or unknown) build than the newest one we know is live. */
function staleShell(res, known) {
  return !!(res && known && res.headers.get("x-jarvis-build") !== known);
}

/**
 * Pages: network first. After 4 s a cached copy stands in, EXCEPT when that copy is from an older
 * build than the newest one known to be live: on a slow (not offline) network we keep waiting for
 * the server instead of booting an outdated shell. Offline (fetch rejects) still gets the cache.
 */
async function handleNavigate(req, url) {
  const cache = await caches.open(PAGES);
  const network = fetch(req).then((res) => {
    const build = res.headers.get("x-jarvis-build");
    if (res.ok && build) noteBuild(build);
    // Only cache successful, same-page responses (not login redirects).
    if (res.ok && !res.redirected && cacheable(url.pathname)) {
      cache.put(url.pathname, res.clone()).then(trimPages, () => undefined);
    }
    return res;
  });
  network.catch(() => undefined); // answered from cache meanwhile: no unhandled rejection
  try {
    return await Promise.race([network, timeout(4000)]);
  } catch (err) {
    const hit = cacheable(url.pathname) ? (await cache.match(url.pathname)) || (await cache.match("/home")) : undefined;
    if (err && err.message === "timeout" && staleShell(hit, await knownBuild())) {
      try {
        return await network;
      } catch {
        // went offline while waiting: an old page beats none
      }
    }
    if (hit) return hit;
    return (await caches.match("/offline")) || new Response("Offline", { status: 503 });
  }
}

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
    event.respondWith(handleNavigate(req, url));
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
      data: { url: data.url || "/alerts", id: data.id, ...(data.ref && data.answers ? { ref: data.ref, answers: data.answers } : {}) },
      // Inbox "Report ready": Open report / File it (files under the suggestion; see notificationclick).
      ...(data.actions ? { actions: data.actions } : {}),
    }),
  );
});

/**
 * "File it" (Report ready push, owner decision 2026-10-25): file the capture under its triage
 * suggestion straight from the notification with an authenticated, CSRF-headed POST (the
 * session cookie rides along; the route is idempotent). Returns null when that isn't possible
 * (signed out, suggestion gone, dismissed, offline) so the caller opens the Inbox entry instead.
 */
async function fileFromNotification(url) {
  const u = new URL(url, self.location.origin);
  const entry = u.searchParams.get("entry");
  if (u.origin !== self.location.origin || (u.pathname !== "/inbox" && u.searchParams.get("view") !== "inbox") || !entry) return null;
  try {
    const res = await fetch(`/api/work/inbox/${encodeURIComponent(entry)}/file-suggestion`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-jarvis-csrf": "1" },
    });
    if (!res.ok || res.redirected) return null;
    const j = await res.json();
    return j && typeof j.itemId === "string" ? j : null;
  } catch {
    return null;
  }
}

async function openOrFocus(target) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of all) {
    if (new URL(client.url).origin === self.location.origin && "focus" in client) {
      await client.focus();
      if ("navigate" in client) return client.navigate(target);
      return;
    }
  }
  return self.clients.openWindow(target);
}

/**
 * CW-5 one-tap answer (low-risk decisions only; the server refuses `via: "push"` on risk-flagged ones).
 * Answers with the session cookie + CSRF header, then confirms in place with an Undo action. Returns null
 * when it couldn't (signed out, already answered, offline) so the caller opens the decision instead.
 */
async function answerFromNotification(ref, answer) {
  if (!/^D-\d{1,9}$/.test(ref || "") || typeof answer !== "string" || !answer) return null;
  try {
    const res = await fetch(`/api/coordinator/decisions/${encodeURIComponent(ref)}/answer`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-jarvis-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ answer, via: "push" }),
    });
    if (!res.ok || res.redirected) return null;
    const j = await res.json();
    return { ref, answer, opId: j && j.op && typeof j.op.id === "string" ? j.op.id : null };
  } catch {
    return null;
  }
}

async function undoFromNotification(opId) {
  if (typeof opId !== "string" || !/^[\w-]{1,80}$/.test(opId)) return false;
  try {
    const res = await fetch(`/api/work/ops/${encodeURIComponent(opId)}/undo`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-jarvis-csrf": "1" },
    });
    return res.ok && !res.redirected;
  } catch {
    return false;
  }
}

/** Notification tap (exported as a SW global so e2e can drive it). Resolves with what it did. */
async function handleNotificationClick(action, data, tag) {
  const url = (data && data.url) || "/alerts";
  if (action && action.startsWith("answer:") && data && data.answers && typeof data.answers[action] === "string") {
    const answered = await answerFromNotification(data.ref, data.answers[action]);
    if (answered) {
      await self.registration
        .showNotification(`Answered ${answered.ref}`, {
          body: answered.answer.slice(0, 160),
          icon: "/icons/icon-192.png",
          badge: "/icons/badge-72.png",
          tag: tag || undefined,
          data: { url, undoOp: answered.opId },
          ...(answered.opId ? { actions: [{ action: "undo", title: "Undo" }] } : {}),
        })
        .catch(() => undefined);
      return { answered };
    }
    // Couldn't answer from here (signed out, changed, offline): open the decision.
    const target = new URL(url, self.location.origin).href;
    await openOrFocus(target).catch(() => undefined);
    return { opened: target };
  }
  if (action === "undo" && data && data.undoOp) {
    const undone = await undoFromNotification(data.undoOp);
    if (undone) {
      await self.registration
        .showNotification("Undone", { body: "The answer was taken back.", icon: "/icons/icon-192.png", badge: "/icons/badge-72.png", tag: tag || undefined, data: { url } })
        .catch(() => undefined);
      return { undone: true };
    }
    const target = new URL(url, self.location.origin).href;
    await openOrFocus(target).catch(() => undefined);
    return { opened: target };
  }
  if (action === "file" && (url.startsWith("/inbox?") || url.includes("view=inbox"))) {
    const filed = await fileFromNotification(url);
    if (filed) {
      // Confirm in place (no window opens); tapping the confirmation opens the new item.
      await self.registration
        .showNotification(filed.already ? "Already filed" : "Filed", {
          body: `${filed.title}${filed.parentTitle ? ` → ${filed.parentTitle}` : ""}`.slice(0, 160),
          icon: "/icons/icon-192.png",
          badge: "/icons/badge-72.png",
          tag: tag || undefined,
          data: { url: `/areas?item=${encodeURIComponent(filed.itemId)}` },
        })
        .catch(() => undefined);
      return { filed };
    }
    // Not signed in / suggestion gone / dismissed / offline: open the Inbox entry to file it by hand.
    const fallback = new URL(url + (url.includes("?") ? "&" : "?") + "do=file", self.location.origin).href;
    await openOrFocus(fallback).catch(() => undefined);
    return { opened: fallback };
  }
  const target = new URL(url, self.location.origin).href;
  await openOrFocus(target).catch(() => undefined);
  return { opened: target };
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event.action, event.notification.data, event.notification.tag));
});
