/**
 * Approving a Hermes command from Jarvis (prod bug: every tap returned
 * `Hermes returned 400 … invalid_params`). Production Hermes resolves `/v1/runs` approvals
 * through the session-authority run path, which accepts EXACTLY
 * `{ choice, request_id, execution_generation }` and names the prompt `prompt_id` in its
 * `approval.request` event and `GET /v1/runs/{id}` `pending_controls`. Jarvis sent
 * `{ choice, request_id: undefined }`. These tests pin the request per choice, the endpoint,
 * and run the whole path against the mock Hermes (which now validates params like the gateway).
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, userById, type CurrentUser } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { demoPresets } from "@/integrations/demo";
import { HermesExecutionClient } from "@/integrations/hermes/client";
import { approvalBody, pendingApprovalPrompt } from "@/integrations/hermes/service";
import { normalizeRunEvent } from "@/integrations/hermes/normalize";
import { createSession, getRun, respondApproval, startRun } from "@/server/assistant";

const CHOICES = ["once", "session", "always", "deny"] as const;
const prompt = (id = "p1", generation = 3) => ({
  kind: "approval",
  prompt_id: id,
  execution_generation: generation,
  command: "python -c 'print(1)'",
  description: "script execution via -e/-c flag",
  choices: [...CHOICES],
});
const authority = (prompts = [prompt()]) => ({ execution_generation: 3, pending_controls: prompts });

describe("approvalBody (exact upstream request per choice)", () => {
  it.each(CHOICES)("session-authority Hermes: %s → exactly { choice, request_id, execution_generation }", (choice) => {
    const body = approvalBody(authority(), choice, "p1");
    expect(body).toStrictEqual({ choice, request_id: "p1", execution_generation: 3 });
    expect(Object.keys(body!).sort()).toEqual(["choice", "execution_generation", "request_id"]);
  });

  it("a card without an id (built before the fix) answers the one waiting prompt", () => {
    expect(approvalBody(authority(), "once")).toStrictEqual({ choice: "once", request_id: "p1", execution_generation: 3 });
  });

  it("never answers a different prompt than the card showed", () => {
    expect(approvalBody(authority([prompt("p2")]), "once", "p1")).toBeNull();
    expect(approvalBody(authority([prompt("p1"), prompt("p2")]), "once")).toBeNull();
    expect(approvalBody(authority([]), "deny", "p1")).toBeNull();
    expect(pendingApprovalPrompt({ pending_controls: [{ ...prompt(), kind: "clarify" }] })).toBeUndefined();
  });

  it.each(CHOICES)("legacy run store (no execution_generation): %s → { choice, request_id }", (choice) => {
    expect(approvalBody({}, choice, "r1")).toStrictEqual({ choice, request_id: "r1" });
    expect(approvalBody({ execution_generation: null }, choice)).toStrictEqual({ choice });
  });

  it("reads prompt_id from authority approval events and settles on approval.settled", () => {
    const req = normalizeRunEvent({ event: "approval.request", ...prompt("abc") } as never);
    expect(req).toMatchObject({ type: "approval.requested", requestId: "abc", choices: [...CHOICES] });
    expect(normalizeRunEvent({ event: "approval.settled", prompt_id: "abc", execution_generation: 3 } as never)).toMatchObject({
      type: "approval.resolved",
      requestId: "abc",
    });
  });
});

describe("endpoint", () => {
  afterEach(() => vi.restoreAllMocks());
  it("POSTs the body unchanged to /v1/runs/{id}/approval", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "resolved", prompt_id: "p1" }), { status: 200, headers: { "content-type": "application/json" } }),
      );
    await HermesExecutionClient.approve({ baseUrl: "http://hermes.invalid" }, "run_x/y", { choice: "deny", request_id: "p1", execution_generation: 3 });
    const [url, init] = fetchSpy.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe("http://hermes.invalid/v1/runs/run_x%2Fy/approval");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toStrictEqual({ choice: "deny", request_id: "p1", execution_generation: 3 });
  });
});

describe("against the mock Hermes (validates like the gateway)", () => {
  let server: Server;
  let base: string;
  let user: CurrentUser;
  const cid = "corr";

  beforeAll(async () => {
    server = startMockServer({ port: 0 });
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.JARVIS_MOCK_UPSTREAM_URL = base;
    __setTestDatabase();
    const owner = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
    user = userById(owner)!;
    const h = demoPresets()!.hermes!;
    saveIntegration("hermes", { enabled: true, config: h.config, secrets: h.secrets });
  });
  afterAll(() => server?.close());

  async function waitingRun(tag: string) {
    const s = await createSession(user, `approval ${tag}`);
    const run = await startRun(user, { sessionId: s.id, input: "please delete the build folder", idempotencyKey: `appr-${tag}` }, cid);
    for (let i = 0; i < 100; i++) {
      const r = await getRun(user, run.runId);
      if (r.status === "waiting_for_approval" && r.pendingApproval) return r;
      await new Promise((x) => setTimeout(x, 30));
    }
    throw new Error("run never asked for approval");
  }

  it("the old Jarvis body is refused with 400 invalid_params (the production error)", async () => {
    const r = await waitingRun("old");
    await expect(HermesExecutionClient.approve(h(), r.runId, { choice: "once", request_id: undefined })).rejects.toThrow(/400.*invalid_params/);
    await expect(HermesExecutionClient.approve(h(), r.runId, { choice: "deny" })).rejects.toThrow(/invalid_params/);
    await respondApproval(user, r.runId, { choice: "deny", requestId: r.pendingApproval!.requestId }, cid);
  });

  it.each(["deny", "once"] as const)("respondApproval(%s) resolves the waiting prompt", async (choice) => {
    const r = await waitingRun(`ok-${choice}`);
    expect(r.pendingApproval).toMatchObject({ command: "rm -rf build", choices: ["once", "session", "always", "deny"] });
    expect(r.pendingApproval!.requestId).toMatch(/^[0-9a-f]+$/);
    const spy = vi.spyOn(HermesExecutionClient, "approve");
    await expect(respondApproval(user, r.runId, { choice, requestId: r.pendingApproval!.requestId }, cid)).resolves.toMatchObject({ status: "resolved" });
    expect(spy.mock.calls[0][2]).toStrictEqual({ choice, request_id: r.pendingApproval!.requestId, execution_generation: 1 });
    spy.mockRestore();
    // Answered: a second tap is a clear 409, not a raw upstream error.
    await expect(respondApproval(user, r.runId, { choice, requestId: r.pendingApproval!.requestId }, cid)).rejects.toMatchObject({
      status: 409,
      code: "approval_not_pending",
    });
  });

  it("a card with no request id (pre-fix client) still answers the single waiting prompt", async () => {
    const r = await waitingRun("noid");
    await expect(respondApproval(user, r.runId, { choice: "deny" }, cid)).resolves.toMatchObject({ status: "resolved" });
  });

  const h = () => ({ baseUrl: demoPresets()!.hermes!.config.baseUrl as string, apiKey: demoPresets()!.hermes!.secrets.apiKey as string });
});
