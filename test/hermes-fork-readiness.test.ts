import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, userById, type CurrentUser } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { HermesExecutionClient, HermesSessionClient } from "@/integrations/hermes/client";
import { forkSession } from "@/integrations/hermes/service";
import type { HermesMessage } from "@/integrations/hermes/types";

let user: CurrentUser;
const data: HermesMessage[] = [
  { id: 1, role: "user", content: "Earlier context" },
  { id: 2, role: "assistant", content: "Answer" },
  { id: 3, role: "user", content: "Later" },
];
const page = (rows = data) => ({ data: rows, pagination: { limit: 500, offset: 0, order: "oldest", returned: rows.length } });
const fork = () => forkSession(user, "parent", { fromMessageId: "2", prompt: "Continue", idempotencyKey: "fork-test" }, "test");

beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Test", passcode: "test-passcode" });
  user = userById(id)!;
  saveIntegration("hermes", { enabled: true, config: { baseUrl: "http://hermes.invalid" }, secrets: { apiKey: "synthetic-only" } });
  vi.spyOn(HermesSessionClient, "messages").mockResolvedValue(page());
  vi.spyOn(HermesSessionClient, "get").mockResolvedValue({ session: { id: "parent", title: "Parent" } });
  vi.spyOn(HermesSessionClient, "create").mockResolvedValue({ session: { id: "child" } });
  vi.spyOn(HermesSessionClient, "fork").mockResolvedValue({ session: { id: "native-child" } });
  vi.spyOn(HermesExecutionClient, "start").mockResolvedValue({ run_id: "run_test", status: "started" });
});
afterEach(() => vi.restoreAllMocks());

it("seeds the entire supported text prefix, without later messages", async () => {
  await fork();
  expect(HermesSessionClient.messages).toHaveBeenCalledWith(expect.anything(), "parent", { limit: 500, offset: 0, order: "oldest", includeCompacted: true });
  expect(HermesExecutionClient.start).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ conversationHistory: data.slice(0, 2).map(({ role, content }) => ({ role, content })) }),
  );
});
it.each([
  ["missing pagination", { data }],
  ["latest window", { data, pagination: { limit: 500, offset: 0, order: "latest", returned: 3 } }],
  ["offset window", { data, pagination: { limit: 500, offset: 1, order: "oldest", returned: 3 } }],
  ["inconsistent returned count", { data, pagination: { limit: 500, offset: 0, order: "oldest", returned: 99 } }],
  ["bounded window", page([...data, ...Array.from({ length: 497 }, (_, i) => ({ id: i + 4, role: "user", content: "more" }))])],
])("rejects %s before any upstream write", async (_, response) => {
  vi.mocked(HermesSessionClient.messages).mockResolvedValue(response);
  await expect(fork()).rejects.toThrow(/complete|truncated|limit/i);
  expect(HermesSessionClient.create).not.toHaveBeenCalled();
  expect(HermesExecutionClient.start).not.toHaveBeenCalled();
});
it.each([
  { role: "tool", content: "tool output" },
  { tool_calls: [{ id: "call", function: { name: "terminal" } }] },
  { content: [{ type: "image_url", image_url: "synthetic" }] },
  { reasoning: "private reasoning" },
  { reasoning_content: "private reasoning" },
  { display_kind: "hidden" },
  { content: null },
  { role: "system", content: "System context" },
])("rejects unsupported prefix context %j before creating a child", async (extra) => {
  vi.mocked(HermesSessionClient.messages).mockResolvedValue(page([{ ...data[0]!, ...extra }, data[1]!]));
  await expect(fork()).rejects.toThrow(/text-only|unsupported/i);
  expect(HermesSessionClient.create).not.toHaveBeenCalled();
  expect(HermesExecutionClient.start).not.toHaveBeenCalled();
});
it("preserves empty text rather than filtering it out", async () => {
  vi.mocked(HermesSessionClient.messages).mockResolvedValue(page([{ ...data[0]!, content: "" }, data[1]!]));
  await fork();
  expect(HermesExecutionClient.start).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      conversationHistory: [
        { role: "user", content: "" },
        { role: "assistant", content: "Answer" },
      ],
    }),
  );
});
it("returns not found for an absent target without writes", async () => {
  vi.mocked(HermesSessionClient.messages).mockResolvedValue(page([data[0]!]));
  await expect(fork()).rejects.toThrow(/no longer/);
  expect(HermesSessionClient.create).not.toHaveBeenCalled();
});
it("keeps native latest-state forks independent of text limitations", async () => {
  await forkSession(user, "parent", {}, "test");
  expect(HermesSessionClient.fork).toHaveBeenCalled();
  expect(HermesSessionClient.messages).not.toHaveBeenCalled();
});
