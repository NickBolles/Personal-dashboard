/** Filed conversations tell the agent where they are, what's open there and whether it has Jarvis tools. */
import { beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { mintAgentToken } from "@/server/agent-access/tokens";
import { filedChatContext } from "@/server/work/chat-context";

const cid = "test";
let owner: CurrentUser;

describe("filedChatContext", () => {
  beforeEach(() => {
    __setTestDatabase();
    const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    owner = resolveUser(new Headers(), createSession(id).token)!;
  });

  it("a chat on its area's own profile still gets the area path, open items with ids, and a no-tools note", () => {
    const area = store.createItem(owner, { kind: "area", title: "General Dev" }, cid);
    store.updateItem(owner, area.id, { settings: { agentMode: "devchief" } }, cid);
    const project = store.createItem(owner, { kind: "project", title: "Jarvis", parentId: area.id }, cid);
    const open = store.createItem(owner, { kind: "thread", title: "Lantern settle check", parentId: project.id }, cid);
    store.updateItem(owner, open.id, { status: "in_progress", nextAction: "Confirm the merge" }, cid);
    const done = store.createItem(owner, { kind: "thread", title: "Old abandoned idea", parentId: project.id }, cid);
    store.updateItem(owner, done.id, { status: "abandoned", reason: "test" }, cid);
    store.createItem(owner, { kind: "thread", title: "Elsewhere thread", parentId: area.id }, cid);
    store.placeConversation(owner, { sessionId: "api_settle", parentId: project.id, title: "Help me settle" }, cid);

    const text = filedChatContext(owner, "api_settle", "devchief")!;
    expect(text).toContain("General Dev › Jarvis");
    expect(text).toContain(`project id ${project.id}`);
    expect(text).toContain(`Lantern settle check (thread, id ${open.id}) — next: Confirm the merge`);
    expect(text).not.toContain("Old abandoned idea");
    expect(text).not.toContain("Elsewhere thread");
    expect(text).toContain("no Jarvis item tools");

    mintAgentToken(owner, { name: "Dev", profile: "devchief", scopes: ["work.read"] }, cid);
    expect(filedChatContext(owner, "api_settle", "devchief")).toContain("jarvis_request_change");
  });

  it("returns nothing for unfiled chats and AI-excluded areas; Finance areas get context (#243)", () => {
    expect(filedChatContext(owner, "api_none", null)).toBeNull();
    const area = store.createItem(owner, { kind: "area", title: "Private" }, cid);
    store.updateItem(owner, area.id, { settings: { aiPolicy: "excluded" } }, cid);
    store.placeConversation(owner, { sessionId: "api_private", parentId: area.id, title: "Private chat" }, cid);
    expect(filedChatContext(owner, "api_private", null)).toBeNull();
    const finance = store.createItem(owner, { kind: "area", title: "Finance" }, cid);
    store.placeConversation(owner, { sessionId: "api_fin", parentId: finance.id, title: "Budget" }, cid);
    store.createItem(owner, { kind: "thread", title: "Pay card ending 4111111111111111", parentId: finance.id }, cid);
    const fin = filedChatContext(owner, "api_fin", null);
    expect(fin).toContain("filed in Jarvis under: Finance");
    expect(fin).not.toContain("4111111111111111");
    // Exclude from AI still wins on a Finance area.
    store.updateItem(owner, finance.id, { settings: { aiPolicy: "excluded" } }, cid);
    expect(filedChatContext(owner, "api_fin", null)).toBeNull();
    const ok = store.createItem(owner, { kind: "area", title: "Home" }, cid);
    const taxes = store.createItem(owner, { kind: "project", title: "Tax return 2026", parentId: ok.id }, cid);
    store.placeConversation(owner, { sessionId: "api_tax", parentId: taxes.id, title: "Paperwork" }, cid);
    expect(filedChatContext(owner, "api_tax", null)).toContain("Tax return 2026");
    // Credential-like ancestor titles still mean no snapshot.
    const keys = store.createItem(owner, { kind: "project", title: "rotate api_key: abcdef123456", parentId: ok.id }, cid);
    store.placeConversation(owner, { sessionId: "api_keys", parentId: keys.id, title: "Keys" }, cid);
    expect(filedChatContext(owner, "api_keys", null)).toBeNull();
  });
});
