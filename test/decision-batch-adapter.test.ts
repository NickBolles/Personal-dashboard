import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { __setTestDatabase, getDb } from "@/server/db";
import * as schema from "@/server/db/schema";
import { claimInstance, userById, type CurrentUser } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { startRun } from "@/integrations/hermes/service";
import { answerPayload, type AnswerQuestion } from "@/lib/jarvis-ui/answers";
let user: CurrentUser;
beforeEach(() => {
  __setTestDatabase();
  user = userById(claimInstance({ setupCode: "TESTCODE", name: "Test", passcode: "test-passcode" }))!;
  saveIntegration("hermes", { enabled: true, config: { baseUrl: "http://hermes.invalid" }, secrets: {} });
});
afterEach(() => vi.restoreAllMocks());
it("one consolidated answer uses real Hermes send DTO and replay key, never decision/item writes", async () => {
  const questions: AnswerQuestion[] = [
    {
      id: "reply:budget",
      ref: "D-9001",
      title: "Discuss budget",
      context: "Conversation only",
      required: true,
      kind: "choice",
      options: [{ id: "discuss", label: "Discuss first" }],
    },
  ];
  const input = answerPayload(questions, { "reply:budget": { choice: "discuss" } });
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("http://hermes.invalid/v1/runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ session_id: "isolated-batch-thread", input });
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("batch-owner-fixture");
    return new Response(JSON.stringify({ run_id: "batch-run", status: "queued" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const request = { sessionId: "isolated-batch-thread", input, idempotencyKey: "batch-owner-fixture" };
  expect(await startRun(user, request, "fixture")).toMatchObject({ runId: "batch-run", status: "queued" });
  expect(await startRun(user, request, "fixture")).toMatchObject({ runId: "batch-run", status: "queued" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(getDb().select().from(schema.decisions).all()).toEqual([]);
  expect(getDb().select().from(schema.workItems).all()).toEqual([]);
});
