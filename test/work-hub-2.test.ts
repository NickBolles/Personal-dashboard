import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { createLocalSession } from "@/server/assistant/local";
import { filingTokens, suggestFiling } from "@/lib/work";
import * as store from "@/server/work/store";
import * as conversations from "@/server/work/conversations";
import * as conversationsRoute from "@/app/api/work/conversations/route";
import * as unfiledRoute from "@/app/api/work/conversations/unfiled/route";
import * as fileRoute from "@/app/api/work/conversations/file/route";

/** Work hub phase 2 (docs/work.md): pure rules, store behaviour and API boundaries. */

let owner: string, other: string, kid: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const them = () => resolveUser(new Headers(), createSession(other).token)!;

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  kid = createPerson({ name: "Child", username: "child", role: "kid", passcode: "synthetic-pass" }, owner).id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function flagship() {
  const u = me();
  const area = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
  const project = store.createItem(u, { kind: "project", title: "Criteria evaluator", parentId: area.id }, cid);
  const items = ["V2 baseline", "V3 parity", "V4 lessons", "V5 evaluator contract"].map((title) =>
    store.createItem(u, { kind: "thread", title, parentId: project.id }, cid),
  );
  return { u, area, project, v2: items[0]!, v3: items[1]!, v4: items[2]!, v5: items[3]! };
}

async function call(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  opts: { user?: string | null; method?: string; body?: unknown; csrf?: boolean; params?: Record<string, string>; query?: string } = {},
) {
  const { user = owner, method = "GET", body, csrf = true, params = {}, query = "" } = opts;
  return handler(
    new NextRequest(`http://jarvis.test/api/work${query}`, {
      method,
      headers: {
        ...(user ? { cookie: `jarvis_session=${createSession(user).token}` } : {}),
        ...(csrf ? { "x-jarvis-csrf": "1" } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}
type H = Parameters<typeof call>[0];

describe("filing suggestions (pure)", () => {
  it("tokenizes significant words, keeping short words with digits", () => {
    expect(filingTokens("Enable the V5 rollout, please!")).toEqual(["enable", "v5", "rollout"]);
    expect(filingTokens("a an of to")).toEqual([]);
    expect(filingTokens("Café Q3 plan")).toEqual(["cafe", "q3", "plan"]);
  });

  it("matches exact title words deterministically and skips closed and built-in items", () => {
    const c = (id: string, title: string, status = "captured", builtIn = false) => ({ id, title, path: `A › ${title}`, status: status as "captured", builtIn });
    const items = [
      c("1", "V5 evaluator contract"),
      c("2", "V5"),
      c("3", "Evaluator rollout plan"),
      c("4", "V5 rollout", "settled"),
      c("5", "Miscellaneous", "captured", true),
      c("6", "Hydration perf bug"),
    ];
    const s = suggestFiling("Enable v5 rollout", items);
    expect(s.map((x) => x.id)).toEqual(["2", "3", "1"]);
    expect(s[0]!.matched).toEqual(["v5"]);
    // Same input in another order gives the same answer.
    expect(suggestFiling("Enable v5 rollout", [...items].reverse()).map((x) => x.id)).toEqual(["2", "3", "1"]);
    expect(suggestFiling("Morning planning", items)).toEqual([]);
    expect(suggestFiling("", items)).toEqual([]);
  });
});

describe("conversations (picker, unfiled, filing)", () => {
  it("lists your conversations, finds unfiled ones with suggestions, and files them", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
    const { u, v5 } = flagship();
    const a = createLocalSession(u, "Enable v5 rollout");
    const b = createLocalSession(u, "Morning planning");
    const theirs = createLocalSession(them(), "Their v5 notes");

    const list = await conversations.listConversations(u);
    expect(list.conversations.map((c) => c.title).sort()).toEqual(["Enable v5 rollout", "Morning planning"]);
    expect(list.conversations.every((c) => c.backend === "claude")).toBe(true);
    expect((await conversations.listConversations(u, "morning")).conversations.map((c) => c.id)).toEqual([b.id]);

    let unfiled = await conversations.unfiledConversations(u);
    expect(unfiled.total).toBe(2);
    expect(unfiled.conversations.find((c) => c.id === a.id)!.suggestions[0]).toMatchObject({ id: v5.id, matched: ["v5"] });
    expect(unfiled.conversations.find((c) => c.id === b.id)!.suggestions).toEqual([]);

    const filed = await conversations.fileConversation(u, { sessionId: a.id, itemId: v5.id }, cid);
    expect(filed.link).toMatchObject({ kind: "chat_session", targetId: a.id, role: "source", title: "Enable v5 rollout" });
    const misc = await conversations.fileConversation(u, { sessionId: b.id, itemId: null }, cid);
    expect(store.getDetail(owner, misc.itemId).item.builtIn).toBe(true);
    unfiled = await conversations.unfiledConversations(u);
    expect(unfiled.total).toBe(0);
    const linked = (await conversations.listConversations(u)).conversations.find((c) => c.id === a.id)!;
    expect(linked.linkedItems).toEqual([{ id: v5.id, title: "V5 evaluator contract" }]);

    // The same conversation can't be linked twice to one item; others' private chats can't be linked at all.
    await expect(conversations.fileConversation(u, { sessionId: a.id, itemId: v5.id }, cid)).rejects.toThrow(/already linked/);
    await expect(conversations.fileConversation(u, { sessionId: theirs.id, itemId: v5.id }, cid)).rejects.toThrow(/not found/);
    // Other people's items are not found.
    await expect(conversations.fileConversation(them(), { sessionId: theirs.id, itemId: v5.id }, cid)).rejects.toThrow(/not found/);
  });

  it("enforces work.use and hermes.chat at the API", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
    expect((await call(conversationsRoute.GET as H, { user: null })).status).toBe(401);
    expect((await call(conversationsRoute.GET as H, { user: kid })).status).toBe(403);
    const ok = await call(unfiledRoute.GET as H);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ total: 0, conversations: [] });
    expect((await call(fileRoute.POST as H, { method: "POST", body: { sessionId: "x", itemId: null }, csrf: false })).status).toBe(403);
    expect((await call(fileRoute.POST as H, { method: "POST", body: { sessionId: "x" } })).status).toBe(400);
    expect((await call(conversationsRoute.GET as H, { query: "?q=v5" })).status).toBe(200);
  });
});
