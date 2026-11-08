import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __setTestDatabase, getDb as db } from "@/server/db";
import * as schema from "@/server/db/schema";
import { claimInstance, userById, type CurrentUser } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { HermesExecutionClient } from "@/integrations/hermes/client";
import { startRun } from "@/integrations/hermes/service";
import { normalizeRunEvent } from "@/integrations/hermes/normalize";

let user: CurrentUser;
beforeEach(() => {
  __setTestDatabase();
  user = userById(claimInstance({ setupCode: "TESTCODE", name: "Test", passcode: "test-passcode" }))!;
  saveIntegration("hermes", { enabled: true, config: { baseUrl: "http://hermes.invalid" }, secrets: {} });
  vi.spyOn(HermesExecutionClient, "start").mockResolvedValue({ run_id: "run_queued", status: "queued" });
});
afterEach(() => vi.restoreAllMocks());

it("persists and replays queued acceptance without starting duplicate work", async () => {
  const input = { sessionId: "test-session", input: "Keep this message", idempotencyKey: "queued-key" };
  expect(await startRun(user, input, "test")).toMatchObject({ runId: "run_queued", status: "queued" });
  expect(db().select().from(schema.runs).get()).toMatchObject({ status: "queued", inputPreview: input.input });
  expect(await startRun(user, input, "test")).toMatchObject({ runId: "run_queued", status: "queued" });
  expect(HermesExecutionClient.start).toHaveBeenCalledTimes(1);
  await expect(startRun(user, { ...input, sessionId: "another-session" }, "test")).rejects.toThrow(/another request/);
});

it("normalizes the explicit upstream queue event", () => {
  expect(normalizeRunEvent({ event: "run.queued", seq: 3 } as never)).toEqual({ type: "run.queued", seq: 3 });
});
