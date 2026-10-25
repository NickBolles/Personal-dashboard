/* Jarvis service worker.
 * - App shell: hashed static assets cache-first; pages network-first with an offline fallback.
 * - Private pages (Finance, Chat, Settings, People) are never cached, and the page
 *   cache is wiped on sign-out (postMessage "CLEAR_PRIVATE" from the page).
 * - API responses are never cached here (auth + live data). Bounded snapshots live in IndexedDB.
 * - Web Push: show notifications and deep-link to the exact context on click.
 */
const VERSION = "jarvis-sw-v2";
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
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
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/alerts", self.location.origin).href;
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
