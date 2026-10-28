import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const settingsStore = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/integrations/hermes/client", () => ({
  hermesConn: () => ({ baseUrl: "http://fixture" }),
  HermesSessionClient: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  HermesExecutionClient: { start: vi.fn(), status: vi.fn(), stop: vi.fn() },
}));
vi.mock("@/server/settings", () => ({
  getSetting: vi.fn((k: string) => (k === "ai.settings" ? settingsStore.value : undefined)),
  setSetting: vi.fn(),
}));

import { HermesExecutionClient as runs, HermesSessionClient as sessions } from "@/integrations/hermes/client";
import { runStructured, syncModel } from "@/integrations/hermes/structured";
import { meterFrom, subscriptionMeter, USAGE_STALE_MS } from "@/server/ai/meter";
import { getAiSettings } from "@/server/ai/settings";
import { DEFAULT_AI_SETTINGS, tierRun } from "@/lib/ai";

const now = new Date("2026-10-28T15:00:00Z");
const codex = { mode: "codex" as const, stopAtPct: 48 };
const snap = (usedPct: number | null, ageMs = 60_000) => ({
  usedPct,
  resetsAt: "2026-11-04T07:31:18Z",
  fetchedAt: new Date(now.getTime() - ageMs).toISOString(),
});

describe("subscription meter states", () => {
  it("api mode: $ budget, background allowed, no warning", () => {
    expect(meterFrom(DEFAULT_AI_SETTINGS.billing, null, now)).toMatchObject({ state: "api", backgroundAllowed: true, warning: null });
    expect(DEFAULT_AI_SETTINGS.billing).toEqual({ mode: "api", stopAtPct: 48 });
  });
  it("under the line: ok, 'Codex 12% of week'", () => {
    expect(meterFrom(codex, snap(12), now)).toMatchObject({
      state: "ok",
      backgroundAllowed: true,
      summary: "Codex 12% of week",
      warning: null,
      provider: "openai-codex",
    });
    expect(meterFrom(codex, snap(47.9), now).backgroundAllowed).toBe(true);
  });
  it("at/over 48% used: background stops, chat gets a warning", () => {
    const m = meterFrom(codex, snap(48), now);
    expect(m).toMatchObject({ state: "stop", backgroundAllowed: false });
    expect(m.warning).toMatch(/48%.*chat still works/);
  });
  it("stale (> 2 h) or missing/unreadable: fail closed", () => {
    expect(meterFrom(codex, snap(5, USAGE_STALE_MS + 1000), now)).toMatchObject({ state: "stale", backgroundAllowed: false });
    expect(meterFrom(codex, snap(5, USAGE_STALE_MS - 1000), now).state).toBe("ok");
    expect(meterFrom(codex, null, now)).toMatchObject({ state: "missing", backgroundAllowed: false, summary: "Codex usage unknown" });
    expect(meterFrom(codex, snap(null), now).state).toBe("missing");
    expect(meterFrom({ mode: "claude", stopAtPct: 48 }, snap(54), now)).toMatchObject({ state: "stop", provider: "anthropic", summary: "Claude 54% of week" });
  });
});

describe("usage snapshot file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-usage-"));
    process.env.JARVIS_HERMES_USAGE_FILE = path.join(dir, "usage.json");
  });
  afterEach(() => {
    delete process.env.JARVIS_HERMES_USAGE_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
    settingsStore.value = {};
  });
  const write = (body: unknown) => fs.writeFileSync(process.env.JARVIS_HERMES_USAGE_FILE!, typeof body === "string" ? body : JSON.stringify(body));

  it("reads the provider's weekly window from the hermes-usage-export.sh format", () => {
    write({
      version: 1,
      fetched_at: now.toISOString(),
      providers: {
        "openai-codex": { weekly_used_percent: 4, weekly_resets_at: "2026-11-04T07:31:18+00:00", plan: "Prolite", fetched_at: now.toISOString(), error: null },
        anthropic: { weekly_used_percent: 54, weekly_resets_at: null, fetched_at: now.toISOString(), error: null },
      },
    });
    const s = { ...getAiSettings(), billing: codex };
    expect(subscriptionMeter(now, s)).toMatchObject({ state: "ok", usedPct: 4, resetsAt: "2026-11-04T07:31:18+00:00" });
    expect(subscriptionMeter(now, { ...s, billing: { mode: "claude", stopAtPct: 48 } }).state).toBe("stop");
  });
  it("garbage, a failed provider fetch or no file → missing (fail closed)", () => {
    const s = { ...getAiSettings(), billing: codex };
    expect(subscriptionMeter(now, s).state).toBe("missing");
    write("{not json");
    expect(subscriptionMeter(now, s).state).toBe("missing");
    write({ fetched_at: now.toISOString(), providers: { "openai-codex": { weekly_used_percent: null, error: "HTTPError" } } });
    expect(subscriptionMeter(now, s).state).toBe("missing");
  });
});

describe("background syncs (Skylight / Daily Compass)", () => {
  const request = { source: "skylight", label: "Skylight", task: "t", schema: z.object({ ok: z.boolean() }), example: {}, timeoutMs: 5_000 };
  beforeEach(() => {
    vi.mocked(sessions.create).mockResolvedValue({ session: { id: "session_fixture" } } as never);
    vi.mocked(sessions.update).mockResolvedValue({ session: { id: "session_fixture" } } as never);
    vi.mocked(sessions.remove).mockResolvedValue({ deleted: true } as never);
    vi.mocked(runs.start).mockResolvedValue({ run_id: "run_fixture", status: "queued" } as never);
    vi.mocked(runs.status).mockResolvedValue({ run_id: "run_fixture", status: "completed", output: '{"ok":true}' } as never);
  });
  afterEach(() => {
    vi.clearAllMocks();
    settingsStore.value = {};
    delete process.env.JARVIS_HERMES_USAGE_FILE;
  });

  it("send the triage tier's provider + reasoning with its model (no Hermes alias needed)", async () => {
    settingsStore.value = {
      models: { triage: "gpt-6.1-sol", standard: null, deep: null },
      providers: { triage: "openai-codex", standard: null, deep: null },
      reasoning: { triage: "low", standard: null, deep: "high" },
      hermes: { perRunModel: true, midRunCost: false, imageInput: false },
    };
    await expect(runStructured(request)).resolves.toEqual({ ok: true });
    expect(vi.mocked(sessions.create).mock.calls[0][1]).toMatchObject({ model: "gpt-6.1-sol", provider: "openai-codex" });
    expect(vi.mocked(runs.start).mock.calls[0][1]).toMatchObject({
      model: "gpt-6.1-sol",
      provider: "openai-codex",
      modelOptions: { reasoning: { effort: "low" } },
    });
  });

  it("tierRun: provider only with the tier's own model; nothing when per-run models are off", () => {
    const s = {
      ...DEFAULT_AI_SETTINGS,
      models: { triage: null, standard: "gpt-6.1-sol", deep: "gpt-6.1-sol" },
      providers: { triage: "openai-codex", standard: "openai-codex", deep: "openai-codex" },
      reasoning: { triage: null, standard: "medium" as const, deep: "high" as const },
      hermes: { perRunModel: true, midRunCost: false, imageInput: false },
    };
    expect(tierRun(s, "deep")).toEqual({ model: "gpt-6.1-sol", provider: "openai-codex", modelOptions: { reasoning: { effort: "high" } } });
    expect(tierRun(s, "standard", "claude-sonnet-5")).toEqual({ model: "claude-sonnet-5", provider: null, modelOptions: { reasoning: { effort: "medium" } } });
    expect(tierRun(s, "triage")).toEqual({ model: null, provider: null, modelOptions: null });
    expect(tierRun({ ...s, hermes: { ...s.hermes, perRunModel: false } }, "deep")).toEqual({ model: null, provider: null, modelOptions: null });
  });

  it("send the triage tier model instead of the profile default", async () => {
    settingsStore.value = {
      models: { triage: "jarvis-triage", standard: null, deep: null },
      hermes: { perRunModel: true, midRunCost: false, imageInput: false },
    };
    expect(syncModel()).toBe("jarvis-triage");
    await expect(runStructured(request)).resolves.toEqual({ ok: true });
    expect(vi.mocked(sessions.create).mock.calls[0][1]).toMatchObject({ model: "jarvis-triage" });
    expect(vi.mocked(runs.start).mock.calls[0][1]).toMatchObject({ model: "jarvis-triage" });
  });

  it("send no model when Hermes doesn't honour per-run models", async () => {
    settingsStore.value = { models: { triage: "jarvis-triage", standard: null, deep: null } };
    await runStructured(request);
    expect(vi.mocked(runs.start).mock.calls[0][1]).not.toHaveProperty("model");
  });

  it("stop before calling Hermes when the subscription meter says no", async () => {
    process.env.JARVIS_HERMES_USAGE_FILE = path.join(os.tmpdir(), "jarvis-usage-does-not-exist.json");
    settingsStore.value = { billing: codex };
    const e = await runStructured(request).catch((x) => x);
    expect(e.message).toMatch(/Skylight sync paused: Codex usage can't be read/);
    expect(sessions.create).not.toHaveBeenCalled();
    // A person's own request (Daily Compass completion, connection test) still goes through.
    await expect(runStructured({ ...request, interactive: true })).resolves.toEqual({ ok: true });
  });
});
