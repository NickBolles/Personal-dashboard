import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Loads public/sw.js in a sandbox with in-memory Cache Storage and a scripted fetch. */
function loadWorker(fetchImpl: (req: { url: string }) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    const key = (k: string | { url: string }) => (typeof k === "string" ? k : new URL(k.url).pathname);
    return {
      match: async (k: string) => m.get(key(k))?.clone(),
      put: async (k: string, r: Response) => void m.set(key(k), r),
      keys: async () => [...m.keys()],
      delete: async (k: string) => m.delete(key(k)),
      addAll: async () => undefined,
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
    match: async (k: string) => {
      for (const m of stores.values()) if (m.has(k)) return m.get(k)!.clone();
      return undefined;
    },
  };
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    location: { origin: "https://jarvis.test" },
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    registration: {},
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Response, URL, setTimeout, clearTimeout, Promise, console });
  vm.runInContext(readFileSync(path.join(import.meta.dirname, "../public/sw.js"), "utf8"), ctx);
  return {
    ctx: ctx as unknown as { handleNavigate: (req: { url: string }, url: URL) => Promise<Response>; noteBuild: (id: string) => Promise<void> },
    open,
    message: async (data: unknown) => {
      const waits: Promise<unknown>[] = [];
      listeners.message({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
  };
}

const page = (body: string, build?: string) => new Response(body, { status: 200, headers: build ? { "x-jarvis-build": build } : {} });
const OLD = "3116bdd0a6404868df899b9aadc97fbbadff2e11";
const NEW = "4a7c9e1f00112233445566778899aabbccddeeff";
const req = { url: "https://jarvis.test/home" };

describe("sw.js navigation and new builds", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves the cached page after 4 s when it is the newest known build", async () => {
    const w = loadWorker(() => new Promise(() => undefined));
    await (await w.open("jarvis-sw-v3-pages")).put("/home", page("cached", OLD));
    await w.ctx.noteBuild(OLD);
    const res = w.ctx.handleNavigate(req, new URL(req.url));
    await vi.advanceTimersByTimeAsync(4001);
    expect(await (await res).text()).toBe("cached");
  });

  it("keeps waiting for the network instead of booting an older cached shell", async () => {
    let answer: (r: Response) => void = () => undefined;
    const w = loadWorker(() => new Promise((r) => (answer = r)));
    await (await w.open("jarvis-sw-v3-pages")).put("/home", page("old shell", OLD));
    await w.message({ type: "BUILD", build: NEW });
    let settled = false;
    const res = w.ctx.handleNavigate(req, new URL(req.url)).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(6000);
    expect(settled).toBe(false);
    answer(page("fresh", NEW));
    expect(await (await res).text()).toBe("fresh");
  });

  it("treats cached pages without a build header as stale once a build is known", async () => {
    let answer: (r: Response) => void = () => undefined;
    const w = loadWorker(() => new Promise((r) => (answer = r)));
    await (await w.open("jarvis-sw-v3-pages")).put("/home", page("pre-header shell"));
    await w.message({ type: "BUILD", build: NEW });
    const res = w.ctx.handleNavigate(req, new URL(req.url));
    await vi.advanceTimersByTimeAsync(5000);
    answer(page("fresh", NEW));
    expect(await (await res).text()).toBe("fresh");
  });

  it("still serves the old page when actually offline", async () => {
    const w = loadWorker(() => Promise.reject(new TypeError("Failed to fetch")));
    await (await w.open("jarvis-sw-v3-pages")).put("/home", page("old shell", OLD));
    await w.message({ type: "BUILD", build: NEW });
    const res = await w.ctx.handleNavigate(req, new URL(req.url));
    expect(await res.text()).toBe("old shell");
  });

  it("learns the live build from network pages and ignores junk BUILD messages", async () => {
    const w = loadWorker(async () => page("fresh", NEW));
    await w.message({ type: "BUILD", build: "<script>" });
    await (await w.ctx.handleNavigate(req, new URL(req.url))).text();
    await vi.advanceTimersByTimeAsync(0);
    const meta = await w.open("jarvis-sw-v3-meta");
    expect(await (await meta.match("/__jarvis-build"))?.text()).toBe(NEW);
    const pages = await w.open("jarvis-sw-v3-pages");
    expect(await (await pages.match("/home"))?.text()).toBe("fresh");
  });
});
