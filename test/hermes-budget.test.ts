import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, userById } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { HermesExecutionClient, HermesSessionClient, hermesConn, HERMES_BUSY_MESSAGE } from "@/integrations/hermes/client";
import { __relayStats, relayRunEvents } from "@/integrations/hermes/service";
import { syncSessionTitle } from "@/integrations/hermes/structured";
import { __resetHermesBudget, acquireHermesSlot, busyBackoffMs, hermesBudgetStats, withHermesLane } from "@/server/http/hermes-budget";
import { UpstreamError } from "@/server/http/errors";

vi.mock("@/server/agents/routing", async (original) => ({
  ...(await original<typeof import("@/server/agents/routing")>()),
  connForProfile: () => ({ baseUrl: "http://unit.invalid/" }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));
const decoder = () => new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>;

beforeEach(() => {
  __resetHermesBudget({ max: 4, maxStreams: 2, reserve: 1, ratePerSec: 1000, burst: 1000 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Hermes connection budget", () => {
  it("keeps the reserved slots for people and serves interactive waiters first", async () => {
    const bg = await Promise.all([acquireHermesSlot("background"), acquireHermesSlot("background"), acquireHermesSlot("background")]);
    expect(hermesBudgetStats()).toMatchObject({ active: 3, background: 3 });
    // A 4th background request must not take the reserved slot …
    let bgGranted = false;
    const bg4 = acquireHermesSlot("background").then((s) => ((bgGranted = true), s));
    await flush();
    expect(bgGranted).toBe(false);
    // … which an interactive request gets at once.
    const mine = await acquireHermesSlot("interactive");
    expect(hermesBudgetStats().active).toBe(4);
    // Full: an interactive waiter queued after the background one is still served first.
    let order: string[] = [];
    const i2 = acquireHermesSlot("interactive").then((s) => (order.push("interactive"), s));
    await flush();
    mine.release();
    await flush();
    expect(order).toEqual(["interactive"]);
    expect(bgGranted).toBe(false);
    (await i2).release();
    bg[0]!.release();
    await flush();
    expect(bgGranted).toBe(true);
    (await bg4).release();
    bg[1]!.release();
    bg[2]!.release();
    expect(hermesBudgetStats()).toMatchObject({ active: 0, queued: 0 });
    order = [];
  });

  it("caps open streams and lets a waiter give up", async () => {
    const a = await acquireHermesSlot("stream");
    const b = await acquireHermesSlot("stream");
    const onQueued = vi.fn();
    const ctl = new AbortController();
    const c = acquireHermesSlot("stream", { signal: ctl.signal, onQueued });
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(hermesBudgetStats()).toMatchObject({ streams: 2, queuedStreams: 1 });
    ctl.abort();
    await expect(c).rejects.toBeDefined();
    expect(hermesBudgetStats().queued).toBe(0);
    a.release();
    a.release(); // idempotent
    b.release();
    expect(hermesBudgetStats()).toMatchObject({ active: 0, streams: 0 });
  });

  it("limits the request rate with a token bucket", async () => {
    __resetHermesBudget({ max: 10, maxStreams: 2, reserve: 1, ratePerSec: 20, burst: 2 });
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) (await acquireHermesSlot("interactive")).release();
    // 2 from the burst, then one every 50 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });

  it("backs off progressively", () => {
    expect(busyBackoffMs(0, () => 0)).toBe(300);
    expect(busyBackoffMs(3, () => 0)).toBe(3000);
    expect(busyBackoffMs(9, () => 1)).toBe(3900);
  });
});

describe("429 from the proxy", () => {
  beforeEach(() => {
    __setTestDatabase();
    claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    saveIntegration("hermes", { enabled: true, config: { baseUrl: "http://hermes.invalid" }, secrets: {} });
  });

  const busy = () => new Response("max connections reached: 10", { status: 429, headers: { "content-type": "text/plain" } });
  const created = () => new Response(JSON.stringify({ session: { id: "s1", title: "x" } }), { status: 200, headers: { "content-type": "application/json" } });

  it("retries and succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy()).mockResolvedValue(created());
    vi.stubGlobal("fetch", fetchMock);
    const p = HermesSessionClient.create(hermesConn(), { title: "x" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toMatchObject({ session: { id: "s1" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(hermesBudgetStats().active).toBe(0);
  });

  it("gives up with a plain busy error (503), sooner for background work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn().mockImplementation(async () => busy());
    vi.stubGlobal("fetch", fetchMock);
    const p = HermesSessionClient.create(hermesConn(), { title: "x" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = (await p) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.kind).toBe("busy");
    expect(err.message).toBe(HERMES_BUSY_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    fetchMock.mockClear();
    const q = withHermesLane("background", () => HermesSessionClient.create(hermesConn(), { title: "x" })).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(((await q) as UpstreamError).kind).toBe("busy");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry other errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(HermesSessionClient.create(hermesConn(), { title: "x" })).rejects.toMatchObject({ kind: "bad_response", status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("shared run relays", () => {
  let owner: string;
  beforeEach(() => {
    __setTestDatabase();
    owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    saveIntegration("hermes", { enabled: true, config: { baseUrl: "http://hermes.invalid" }, secrets: {} });
    for (const runId of ["run-a", "run-b"])
      getDb().insert(schema.runs).values({ runId, sessionId: "s1", userId: owner, idempotencyKey: runId, status: "running" }).run();
  });

  /** An upstream SSE body the test writes to. */
  function upstreamBody() {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    const enc = new TextEncoder();
    return {
      res: new Response(body),
      send: (event: Record<string, unknown>) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)),
      end: () => ctl.close(),
    };
  }
  async function readUntil(reader: ReadableStreamDefaultReader<string>, needle: string, acc = { text: "" }) {
    while (!acc.text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      acc.text += value;
    }
    return acc.text;
  }

  it("serves every watcher of a run from one upstream stream and replays what a late joiner missed", async () => {
    const up = upstreamBody();
    const events = vi.spyOn(HermesExecutionClient, "events").mockResolvedValue(up.res);
    const me = userById(owner)!;
    const a = relayRunEvents(me, "run-a", undefined, new AbortController().signal).pipeThrough(decoder()).getReader();
    await flush();
    up.send({ event: "message.delta", delta: "Hello ", seq: 0 });
    await readUntil(a, "Hello");
    const b = relayRunEvents(me, "run-a", undefined, new AbortController().signal).pipeThrough(decoder()).getReader();
    up.send({ event: "message.delta", delta: "world", seq: 1 });
    const bText = await readUntil(b, "world");
    expect(bText).toContain("Hello ");
    expect(events).toHaveBeenCalledTimes(1);
    expect(__relayStats()).toEqual([{ runId: "run-a", subscribers: 2, waiting: false, done: false }]);
    expect(hermesBudgetStats().streams).toBe(1);
    up.send({ event: "run.completed", output: "Hello world", seq: 2 });
    up.end();
    await readUntil(a, "completed");
    await readUntil(b, "completed");
    await flush();
    expect(__relayStats()).toEqual([]);
    expect(hermesBudgetStats().streams).toBe(0);
  });

  it("queues a relay when the stream budget is full, then streams it", async () => {
    __resetHermesBudget({ max: 4, maxStreams: 1, reserve: 1, ratePerSec: 1000, burst: 1000 });
    const first = upstreamBody();
    const second = upstreamBody();
    vi.spyOn(HermesExecutionClient, "events").mockImplementation(async (_c, runId) => (runId === "run-a" ? first.res : second.res));
    const me = userById(owner)!;
    const a = relayRunEvents(me, "run-a", undefined, new AbortController().signal).pipeThrough(decoder()).getReader();
    await flush();
    const b = relayRunEvents(me, "run-b", undefined, new AbortController().signal).pipeThrough(decoder()).getReader();
    expect(await readUntil(b, "run.queued")).toContain('"reason":"connections"');
    first.send({ event: "run.completed", output: "done", seq: 0 });
    first.end();
    await readUntil(a, "completed");
    await flush();
    second.send({ event: "message.delta", delta: "now streaming", seq: 0 });
    expect(await readUntil(b, "now streaming")).toContain("now streaming");
    second.end();
  });

  it("closes the upstream when the last watcher leaves", async () => {
    const up = upstreamBody();
    let upstreamSignal: AbortSignal | undefined;
    vi.spyOn(HermesExecutionClient, "events").mockImplementation(async (_c, _r, _l, signal) => ((upstreamSignal = signal), up.res));
    const me = userById(owner)!;
    const ctl = new AbortController();
    const a = relayRunEvents(me, "run-a", undefined, ctl.signal).pipeThrough(decoder()).getReader();
    await flush();
    up.send({ event: "message.delta", delta: "x", seq: 0 });
    await readUntil(a, '"x"');
    ctl.abort();
    await flush();
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

it("gives every sync session its own title (a retained one can't block the next sync)", () => {
  const a = syncSessionTitle("daily_compass");
  expect(a).toMatch(/^jarvis-sync:daily_compass:[0-9a-f]{8}$/);
  expect(syncSessionTitle("daily_compass")).not.toBe(a);
});
