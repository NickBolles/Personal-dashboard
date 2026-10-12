import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("@/integrations/hermes/client", () => ({
  hermesConn: () => ({ baseUrl: "http://fixture" }),
  HermesSessionClient: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  HermesExecutionClient: { start: vi.fn(), status: vi.fn(), stop: vi.fn() },
}));
vi.mock("@/server/settings", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
import { HermesExecutionClient as runs, HermesSessionClient as sessions } from "@/integrations/hermes/client";
import { runStructured } from "@/integrations/hermes/structured";
import { setSetting } from "@/server/settings";
import { UpstreamError } from "@/server/http/errors";

it.each(["unauthorized", "unreachable", "timeout", "not_found", "conflict", "unsupported", "bad_response"] as const)(
  "preserves %s transport classification without exposing its message",
  async (kind) => {
    vi.mocked(sessions.create).mockRejectedValue(new UpstreamError("Hermes", kind, "PRIVATE TOKEN"));
    const error = await runStructured(request).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("PRIVATE");
    expect(setSetting).toHaveBeenCalledWith("hermes_sync_failure:skylight", expect.objectContaining({ code: kind }));
    expect(JSON.stringify(vi.mocked(setSetting).mock.calls)).not.toContain("PRIVATE");
    expect(runs.start).not.toHaveBeenCalled();
  },
);
it("preserves unauthorized polling failures and retains the unconfirmed worker", async () => {
  vi.mocked(runs.status).mockRejectedValue(new UpstreamError("Hermes", "unauthorized", "PRIVATE TOKEN"));
  const error = await runStructured({ ...request, source: "daily_compass_complete" }).catch((e) => e);
  expect(error.kind).toBe("unauthorized");
  expect(error.message).not.toContain("PRIVATE");
  expect(runs.stop).toHaveBeenCalledTimes(1);
  expect(sessions.remove).not.toHaveBeenCalled();
  expect(setSetting).toHaveBeenCalledWith("hermes_sync_failure:daily_compass", expect.objectContaining({ code: "unauthorized", cleanup: "retained" }));
});
const request = {
  source: "skylight",
  label: "Skylight",
  task: "PRIVATE PROMPT",
  schema: z.object({ events: z.array(z.unknown()), chores: z.array(z.unknown()) }),
  example: {},
  timeoutMs: 120_000,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(sessions.create).mockResolvedValue({ session: { id: "session_fixture" } });
  vi.mocked(sessions.update).mockResolvedValue({ session: { id: "session_fixture" } });
  vi.mocked(sessions.remove).mockResolvedValue({ deleted: true });
  vi.mocked(runs.start).mockResolvedValue({ run_id: "run_fixture", status: "queued" });
  vi.mocked(runs.stop).mockResolvedValue({ status: "stopping" });
});
afterEach(() => vi.useRealTimers());
it("retains a nonterminal session after bounded stop/wait within 120 seconds", async () => {
  vi.mocked(runs.status).mockResolvedValue({ run_id: "run_fixture", status: "running" });
  const started = Date.now();
  const result = runStructured(request).catch((e) => e);
  await vi.advanceTimersByTimeAsync(120_000);
  expect((await result).kind).toBe("timeout");
  expect(Date.now() - started).toBeLessThanOrEqual(120_000);
  expect(runs.stop).toHaveBeenCalledTimes(1);
  expect(sessions.remove).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(setSetting).mock.calls)).not.toContain("PRIVATE");
  expect(setSetting).toHaveBeenCalledWith("hermes_sync_failure:skylight", expect.objectContaining({ cleanup: "retained", runId: "run_fixture" }));
});
it.each(["completed", "failed"])("cleans up confirmed terminal %s", async (status) => {
  vi.mocked(runs.status).mockResolvedValue({ run_id: "run_fixture", status, output: '{"events":[],"chores":[]}', error: "PRIVATE TOKEN" });
  const result = await runStructured(request).catch((e) => e);
  expect(sessions.remove).toHaveBeenCalledTimes(1);
  expect(runs.stop).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
it("waits for cancelled status but retains it because handler cancellation is not worker exit", async () => {
  vi.mocked(runs.status)
    .mockResolvedValueOnce({ run_id: "run_fixture", status: "waiting_for_approval" })
    .mockResolvedValueOnce({ run_id: "run_fixture", status: "stopping" })
    .mockResolvedValue({ run_id: "run_fixture", status: "cancelled" });
  const result = runStructured(request).catch((e) => e);
  await vi.advanceTimersByTimeAsync(2000);
  await result;
  expect(runs.stop).toHaveBeenCalledTimes(1);
  expect(sessions.remove).not.toHaveBeenCalled();
  expect(runs.status).toHaveBeenCalledTimes(3);
});
it("retains ambiguous start failures without a run id and sanitizes errors", async () => {
  vi.mocked(runs.start).mockRejectedValue(new Error("PRIVATE TOKEN"));
  const error = await runStructured(request).catch((e) => e);
  expect(error.message).not.toContain("PRIVATE");
  expect(sessions.remove).not.toHaveBeenCalled();
});

it.each([
  ["daily_compass", "failed", "daily_compass"],
  ["daily_compass_complete", "failed", "daily_compass"],
  ["daily_compass", "interrupted", "daily_compass"],
  ["daily_compass_complete", "interrupted", "daily_compass"],
  ["unknown_source", "failed", "other"],
])("attributes %s %s diagnostics to %s", async (source, status, diagnosticSource) => {
  vi.mocked(runs.status).mockResolvedValue({ run_id: "run_fixture", status });
  await expect(runStructured({ ...request, source })).rejects.toMatchObject({ kind: "bad_response" });
  expect(setSetting).toHaveBeenCalledExactlyOnceWith(
    `hermes_sync_failure:${diagnosticSource}`,
    expect.objectContaining({ code: "bad_response", status, cleanup: status === "failed" ? "deleted" : "retained" }),
  );
  expect(sessions.remove).toHaveBeenCalledTimes(status === "failed" ? 1 : 0);
});

it("cleans up hide failure before start without launching a visible run", async () => {
  vi.mocked(sessions.update).mockRejectedValue(new Error("PRIVATE"));
  await runStructured(request).catch(() => undefined);
  expect(runs.start).not.toHaveBeenCalled();
  expect(sessions.remove).toHaveBeenCalledTimes(1);
});
it.each(["unknown", "interrupted"])("retains %s status even when stop fails", async (status) => {
  vi.mocked(runs.status).mockResolvedValue({ run_id: "run_fixture", status });
  vi.mocked(runs.stop).mockRejectedValue(new Error("PRIVATE 409"));
  const result = runStructured(request).catch((e) => e);
  await vi.advanceTimersByTimeAsync(120_000);
  await result;
  expect(sessions.remove).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(setSetting).mock.calls)).not.toContain("PRIVATE");
});
it("retains after a status transport failure during terminal wait", async () => {
  vi.mocked(runs.status).mockResolvedValueOnce({ run_id: "run_fixture", status: "waiting_for_approval" }).mockRejectedValue(new Error("PRIVATE"));
  await runStructured(request).catch(() => undefined);
  expect(runs.stop).toHaveBeenCalledTimes(1);
  expect(sessions.remove).not.toHaveBeenCalled();
});
it("aborts hanging safe cleanup within the overall budget", async () => {
  vi.mocked(runs.status).mockResolvedValue({ run_id: "run_fixture", status: "completed", output: '{"events":[],"chores":[]}' });
  vi.mocked(sessions.remove).mockImplementation(() => new Promise(() => {}));
  const result = runStructured(request);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await result).toEqual({ events: [], chores: [] });
  expect(vi.mocked(sessions.remove).mock.calls[0]![2]!.aborted).toBe(true);
});
