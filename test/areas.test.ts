import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { createLocalSession } from "@/server/assistant/local";
import { recentAudit } from "@/server/audit";
import { eq } from "drizzle-orm";
import { DEFAULT_AREA_SETTINGS, areaSettingsSchema, packetSchema, parseAreaSettings, updateItemSchema, createItemSchema } from "@/lib/work";
import { displayRef, encodeMessage, encodeRef, matchCommands, parseRefQuery, parseReferences, splitReferences, triggerAt } from "@/lib/references";
import { DAY_MS, settleDecision, settleSignals, type SettleFacts } from "@/server/work/settle-rules";
import * as store from "@/server/work/store";
import * as conversations from "@/server/work/conversations";
import { today } from "@/server/work/today";
import { startConversation, forkConversation, patchConversation, sharedConversations, conversationAreaContext } from "@/server/areas";
import { areaDefaultsFor, referenceOptions, resolveReferences } from "@/server/references";
import * as sessionsRoute from "@/app/api/hermes/sessions/route";
import * as referencesRoute from "@/app/api/references/route";
import * as ghRefsRoute from "@/app/api/references/github/route";
import * as modelsRoute from "@/app/api/assistant/models/route";
import * as sharedRoute from "@/app/api/hermes/sessions/shared/route";
import * as itemsRoute from "@/app/api/work/items/route";
import * as itemRoute from "@/app/api/work/items/[id]/route";
import * as conversationsRoute from "@/app/api/work/conversations/route";

/** Phase 4 — Areas (docs/work.md "Areas"): conversations in the tree, area settings, settle policy, composer references. */

let owner: string, other: string, kid: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const them = () => resolveUser(new Headers(), createSession(other).token)!;

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  kid = createPerson({ name: "Child", username: "child", role: "kid", passcode: "synthetic-pass" }, owner).id;
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function call(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  opts: { user?: string | null; method?: string; body?: unknown; params?: Record<string, string>; query?: string } = {},
) {
  const { user = owner, method = "GET", body, params = {}, query = "" } = opts;
  return handler(
    new NextRequest(`http://jarvis.test/api/x${query}`, {
      method,
      headers: {
        ...(user ? { cookie: `jarvis_session=${createSession(user).token}` } : {}),
        "x-jarvis-csrf": "1",
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}
type H = Parameters<typeof call>[0];

function tree() {
  const u = me();
  const area = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
  const project = store.createItem(u, { kind: "project", title: "Criteria evaluator", parentId: area.id }, cid);
  const v5 = store.createItem(u, { kind: "thread", title: "V5 evaluator contract", parentId: project.id }, cid);
  const note = store.createItem(u, { kind: "note", title: "Notes", parentId: project.id }, cid);
  return { u, area, project, v5, note };
}

describe("composer references (pure)", () => {
  it("encodes, parses and splits reference tokens", () => {
    const r = { type: "item" as const, id: "wk_1", label: "V5 [contract]" };
    expect(encodeRef(r)).toBe("@[V5 contract](item:wk_1)");
    expect(encodeRef({ type: "gh", id: "nick/jarvis#88", label: "jarvis#88 Timeline" })).toBe("#[jarvis#88 Timeline](gh:nick/jarvis#88)");
    const text = `See ${encodeRef(r)} and #[jarvis#88 Timeline](gh:nick/jarvis#88) and @[x](item:wk_1)`;
    expect(parseReferences(text)).toEqual([
      { type: "item", id: "wk_1", label: "V5 contract" },
      { type: "gh", id: "nick/jarvis#88", label: "jarvis#88 Timeline" },
    ]);
    // A sigil that doesn't match the type is ignored; unknown types aren't tokens.
    expect(parseReferences("#[x](item:wk_1) @[y](gh:a/b#1) @[z](finance:acct)")).toEqual([]);
    const parts = splitReferences("Hi @[Ann](person:p1)!");
    expect(parts).toEqual([{ text: "Hi " }, { ref: { type: "person", id: "p1", label: "Ann" } }, { text: "!" }]);
  });

  it("swaps the typed @Label for its token on send and drops deleted ones", () => {
    const a = { type: "area" as const, id: "a1", label: "Home" };
    const b = { type: "chat" as const, id: "s1", label: "Standup" };
    expect(displayRef(a)).toBe("@Home");
    const out = encodeMessage("Compare @Home with this", [a, b]);
    expect(out.text).toBe("Compare @[Home](area:a1) with this");
    expect(out.refs).toEqual([a]);
  });

  it("finds the trigger at the caret: @ and # after a space, / only at the start", () => {
    expect(triggerAt("hello @v5", 9)).toEqual({ sigil: "@", query: "v5", start: 6, end: 9 });
    expect(triggerAt("@chat:stand", 11)).toEqual({ sigil: "@", query: "chat:stand", start: 0, end: 11 });
    expect(triggerAt("fix #41", 7)).toEqual({ sigil: "#", query: "41", start: 4, end: 7 });
    expect(triggerAt("/mo", 3)).toEqual({ sigil: "/", query: "mo", start: 0, end: 3 });
    expect(triggerAt("a/mo", 4)).toBeNull();
    expect(triggerAt("mail@example", 12)).toBeNull();
    expect(triggerAt("hello @v5 done", 14)).toBeNull();
    expect(triggerAt("no bang !cmd", 12)).toBeNull();
  });

  it("parses typed filters and matches commands", () => {
    expect(parseRefQuery("chat:stand")).toEqual({ type: "chat", q: "stand" });
    expect(parseRefQuery("people:")).toEqual({ type: "person", q: "" });
    expect(parseRefQuery("http://x")).toEqual({ q: "http://x" });
    expect(matchCommands("mo").map((c) => c.id)).toEqual(["model", "mode"]);
    expect(matchCommands("").length).toBeGreaterThan(5);
  });
});

describe("area settings and settle rules (pure)", () => {
  it("parses stored settings forgivingly and validates updates", () => {
    expect(parseAreaSettings(null)).toEqual(DEFAULT_AREA_SETTINGS);
    expect(parseAreaSettings("not json")).toEqual(DEFAULT_AREA_SETTINGS);
    expect(parseAreaSettings(JSON.stringify({ settlePolicy: "auto_after_quiet", quietDays: 999, defaultRepo: "nick/jarvis", bogus: 1 }))).toMatchObject({
      settlePolicy: "auto_after_quiet",
      quietDays: DEFAULT_AREA_SETTINGS.quietDays,
      defaultRepo: "nick/jarvis",
    });
    expect(areaSettingsSchema.safeParse({ defaultRepo: "not a repo" }).success).toBe(false);
    expect(areaSettingsSchema.safeParse({ contextSources: ["finance"] }).success).toBe(false);
    expect(areaSettingsSchema.parse({ agentMode: "  " })).toEqual({ agentMode: null });
    // Conversation nodes are never created through the item form.
    expect(createItemSchema.safeParse({ kind: "conversation", title: "x" }).success).toBe(false);
    expect(updateItemSchema.safeParse({ kind: "conversation" }).success).toBe(false);
  });

  it("suggests or settles only when merged, passing and quiet, per policy", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const facts = (over: Partial<SettleFacts> = {}): SettleFacts => ({
      status: "awaiting_validation",
      kind: "thread",
      archived: false,
      merged: true,
      gateAllowed: true,
      lastActivityAt: new Date(now.getTime() - 4 * DAY_MS).toISOString(),
      ...over,
    });
    const s = settleSignals(facts(), 3, now);
    expect(s).toMatchObject({ ready: true, quiet: true, quietForDays: 4 });
    expect(s.reasons).toEqual(["PR merged", "validations pass", "quiet for 4 days"]);
    expect(settleDecision("suggest", s, facts())).toBe("suggest");
    expect(settleDecision("auto_after_quiet", s, facts())).toBe("auto");
    expect(settleDecision("manual", s, facts())).toBe("none");
    expect(settleDecision("suggest", settleSignals(facts({ lastActivityAt: now.toISOString() }), 3, now), facts())).toBe("none");
    expect(settleDecision("auto_after_quiet", settleSignals(facts({ gateAllowed: false }), 3, now), facts())).toBe("none");
    expect(settleDecision("auto_after_quiet", settleSignals(facts({ merged: false }), 3, now), facts())).toBe("none");
    expect(settleSignals(facts({ status: "settled" }), 3, now).ready).toBe(false);
    expect(settleSignals(facts({ kind: "area" }), 3, now).ready).toBe(false);
  });
});

describe("conversations in the Areas tree", () => {
  it("new chats land in Miscellaneous with zero filing, or under the area they were started from", async () => {
    const { u, area, v5, note } = tree();
    const misc = await startConversation(u, { title: "Quick question", backend: "claude" }, cid);
    expect(misc.id).toMatch(/^loc_/);
    const items = store.listItems(owner);
    const node = items.find((i) => i.sessionId === misc.id)!;
    expect(node).toMatchObject({ kind: "conversation", title: "Quick question", status: "exploring" });
    expect(items.find((i) => i.id === node.parentId)!.builtIn).toBe(true);
    expect(misc.placedIn).toBe(node.parentId);

    const here = await startConversation(u, { title: "Lock the rubric", backend: "claude", areaId: v5.id }, cid);
    expect(store.listItems(owner).find((i) => i.sessionId === here.id)!.parentId).toBe(v5.id);
    // Not someone else's area, never inside a note.
    await expect(startConversation(them(), { backend: "claude", areaId: area.id }, cid)).rejects.toThrow(/not found/i);
    await expect(startConversation(u, { backend: "claude", areaId: note.id }, cid)).rejects.toThrow(/Notes can't/);
    expect(recentAudit(50).some((a) => a.action === "work.conversation_place")).toBe(true);

    // The conversations view: Unfiled = not in the tree, or only in Miscellaneous.
    const loose = createLocalSession(u, "Loose v5 thoughts");
    const view = await conversations.conversationList(u, "unfiled");
    expect(view.conversations.map((c) => c.id).sort()).toEqual([misc.id, loose.id].sort());
    expect(view.conversations.find((c) => c.id === loose.id)!.suggestions[0]).toMatchObject({ id: v5.id });
    const all = await conversations.conversationList(u, "all");
    expect(all.conversations.find((c) => c.id === here.id)!.placement).toMatchObject({ parentId: v5.id, inMisc: false, path: expect.stringContaining("V5") });
    // The Inbox only nags about conversations that aren't in the tree at all.
    expect((await conversations.unfiledConversations(u)).conversations.map((c) => c.id)).toEqual([loose.id]);
  });

  it("conversation nodes nest, move with undo, can't be forked as items, and forks land next to their parent", async () => {
    const { u, project, v5 } = tree();
    const s = await startConversation(u, { title: "Rubric chat", backend: "claude", areaId: v5.id }, cid);
    const node = store.listItems(owner).find((i) => i.sessionId === s.id)!;
    const out: store.OpOut = {};
    store.moveItem(u, node.id, project.id, cid, out);
    expect(out.op?.kind).toBe("move");
    const child = store.createItem(u, { kind: "thread", title: "Follow-up", parentId: node.id }, cid);
    expect(child.parentId).toBe(node.id);
    expect(() => store.forkItem(u, node.id, undefined, cid)).toThrow(/Fork the conversation itself/);
    expect(() => store.updateItem(u, node.id, { kind: "thread" }, cid)).toThrow(/stays a conversation/);
    // Lifecycle applies: a conversation can be settled.
    expect(store.updateItem(u, node.id, { status: "settled" }, cid).status).toBe("settled");

    const fork = await forkConversation(u, s.id, { title: "Rubric chat (fork)" }, cid);
    const forkNode = store.listItems(owner).find((i) => i.sessionId === fork.session.id)!;
    expect(forkNode.parentId).toBe(project.id);
    const lin = store.getDetail(owner, forkNode.id).lineage;
    expect(lin.some((l) => l.relation === "forked_from" && l.parentId === node.id)).toBe(true);
  });

  it("shows item-linked conversations as child rows and keeps node titles in step", async () => {
    const { u, v5 } = tree();
    const a = createLocalSession(u, "Linked one");
    await store.addLink(u, v5.id, { kind: "chat_session", targetId: a.id }, cid);
    const res = await call(itemsRoute.GET as H);
    const body = (await res.json()) as { items: unknown[]; linkedConversations: unknown[] };
    expect(body.linkedConversations).toEqual([{ itemId: v5.id, sessionId: a.id, title: "Linked one" }]);
    const s = await startConversation(u, { title: "Old title", backend: "claude" }, cid);
    expect(store.syncConversationTitles(owner, [{ id: s.id, title: "New title" }])).toBe(1);
    expect(store.listItems(owner).find((i) => i.sessionId === s.id)!.title).toBe("New title");
  });

  it("header context: placement, suggestions and the area's defaults", async () => {
    const { u, area, v5 } = tree();
    store.updateItem(u, area.id, { settings: { defaultModel: "claude-sonnet-5-5", defaultRepo: "momentumbets/odds" } }, cid);
    const s = await startConversation(u, { title: "Ask about v5", backend: "claude" }, cid);
    let ctx = conversationAreaContext(u, s.id, "Ask about v5");
    expect(ctx.enabled && ctx.placement?.inMisc).toBe(true);
    expect(ctx.enabled && ctx.suggestions[0]?.id).toBe(v5.id);
    await conversations.fileConversation(u, { sessionId: s.id, itemId: v5.id }, cid);
    ctx = conversationAreaContext(u, s.id, "Ask about v5");
    expect(ctx.enabled && ctx.area?.id).toBe(area.id);
    expect(ctx.enabled && ctx.settings?.defaultRepo).toBe("momentumbets/odds");
    expect(areaDefaultsFor(u, s.id)?.settings.defaultModel).toBe("claude-sonnet-5-5");
  });
});

describe("area settings and settle policy (store)", () => {
  it("stores settings on areas only and audits them", () => {
    const { u, area, v5 } = tree();
    const a = store.updateItem(u, area.id, { settings: { agentMode: "momentumchief", settlePolicy: "manual", contextSources: ["overview"] } }, cid);
    expect(a.settings).toMatchObject({ agentMode: "momentumchief", settlePolicy: "manual", contextSources: ["overview"], quietDays: 3 });
    // Partial updates merge.
    expect(store.updateItem(u, area.id, { settings: { quietDays: 5 } }, cid).settings).toMatchObject({ agentMode: "momentumchief", quietDays: 5 });
    expect(() => store.updateItem(u, v5.id, { settings: { quietDays: 5 } }, cid)).toThrow(/belong to an area/);
    expect(store.getDetail(owner, v5.id).area).toMatchObject({ id: area.id, settings: { agentMode: "momentumchief" } });
    expect(recentAudit(20).some((x) => x.action === "work.area_settings")).toBe(true);
  });

  it("suggests settling merged, passing, quiet work and auto-settles (undoably) where the area opted in", async () => {
    const { u, area, v5, project } = tree();
    const other = store.createItem(u, { kind: "area", title: "General Dev" }, cid);
    const gd = store.createItem(u, { kind: "thread", title: "Cron cleanup", parentId: other.id }, cid);
    for (const id of [v5.id, gd.id]) {
      store.createPacket(u, id, packetSchema.parse({ objective: "Ship", nextAction: "Merge", validationRequired: false, noValidationReason: "trivial" }), cid);
      const link = await store.addLink(u, id, { kind: "github_pr", url: `https://github.com/nick/jarvis/pull/${id === v5.id ? 1 : 2}` }, cid);
      store.setLinkState(u, link.id, "merged", cid);
    }
    expect(store.getDetail(owner, v5.id).item.status).toBe("ready_to_settle");
    store.updateItem(u, other.id, { settings: { settlePolicy: "auto_after_quiet", quietDays: 2 } }, cid);
    // Not quiet yet: nothing happens.
    let t = today(owner);
    expect(t.settleSuggestions).toEqual([]);
    expect(t.autoSettled).toEqual([]);
    // Four days later: General Dev settles itself; Momentum Bets (default "suggest") is already prompting as ready_to_settle.
    const later = new Date(Date.now() + 4 * 86_400_000);
    t = today(owner, later);
    expect(store.getDetail(owner, gd.id).item).toMatchObject({ status: "settled", settledKind: "auto" });
    expect(t.autoSettled.map((c) => c.id)).toEqual([gd.id]);
    expect(t.readyToSettle.map((c) => c.id)).toContain(v5.id);
    const opId = t.autoSettled[0]!.opId!;
    expect(opId).toBeTruthy();
    // Undo reopens it to where it was.
    store.undoOp(u, opId, cid, new Date(later.getTime() + 60_000));
    expect(store.getDetail(owner, gd.id).item.status).toBe("ready_to_settle");
    expect(store.getDetail(owner, gd.id).events.some((e) => e.reason === "Undid automatic settle")).toBe(true);
    // Suggest: an awaiting-validation item whose validations now pass.
    const aw = store.createItem(u, { kind: "thread", title: "Hydration", parentId: project.id }, cid);
    const link = await store.addLink(u, aw.id, { kind: "github_pr", url: "https://github.com/nick/jarvis/pull/3" }, cid);
    store.setLinkState(u, link.id, "merged", cid);
    const v = store.addValidation(u, aw.id, { metric: "p95", comparator: "<=", threshold: 1, unit: "s" }, cid);
    store.updateValidation(u, v.id, { observed: 0.8 }, cid);
    expect(store.getDetail(owner, aw.id).item.status).toBe("awaiting_validation");
    t = today(owner, new Date(Date.now() + 5 * 86_400_000));
    expect(t.settleSuggestions.map((c) => c.id)).toEqual([aw.id]);
    // A manual area never suggests.
    store.updateItem(u, area.id, { settings: { settlePolicy: "manual" } }, cid);
    expect(today(owner, new Date(Date.now() + 5 * 86_400_000)).settleSuggestions).toEqual([]);
  });
});

describe("references: options and server-side resolution", () => {
  it("offers typed sections and resolves only what the person may see (never finance)", async () => {
    const { u, area, v5 } = tree();
    createLocalSession(u, "Standup notes");
    const opts = await referenceOptions(u, "");
    expect(opts.sections.map((s) => s.type)).toEqual(expect.arrayContaining(["area", "item", "chat", "person"]));
    const typed = await referenceOptions(u, "area:momentum");
    expect(typed.sections.map((s) => s.type)).toEqual(["area"]);
    expect(typed.sections[0]!.options[0]).toMatchObject({ type: "area", id: area.id });

    const text = await resolveReferences(u, [
      { type: "item", id: v5.id, label: "V5" },
      { type: "person", id: other, label: "Other" },
    ]);
    expect(text).toContain("V5 evaluator contract");
    expect(text).toContain("Person: Other");
    // Someone else's item resolves to nothing; so does an unknown type.
    expect(await resolveReferences(them(), [{ type: "item", id: v5.id, label: "V5" }])).toBe("");
    expect(await resolveReferences(u, [{ type: "finance" as never, id: "acct", label: "Checking" }])).toBe("");
  });

  it("guards the routes by capability", async () => {
    expect((await call(referencesRoute.GET as H, { user: null })).status).toBe(401);
    expect((await call(referencesRoute.GET as H, { query: "?q=" })).status).toBe(200);
    expect((await call(ghRefsRoute.GET as H, { query: "?repo=nick/jarvis&q=1" })).status).toBe(200);
    const claude = await call(modelsRoute.GET as H, { query: "?backend=claude" });
    expect(((await claude.json()) as { models: { id: string }[] }).models.map((m) => m.id)).toContain("claude-opus-5-5");
    expect((await call(sharedRoute.GET as H, { user: null })).status).toBe(401);
    // Kids don't get work.use: the conversations view is refused.
    expect((await call(conversationsRoute.GET as H, { user: kid, query: "?view=all" })).status).toBe(403);
  });
});

describe("routes: new chat, area settings, sharing", () => {
  it("POST /api/hermes/sessions places the chat; PATCH settings refuses non-areas", async () => {
    const { area, v5 } = tree();
    const res = await call(sessionsRoute.POST as H, { method: "POST", body: { backend: "claude", areaId: v5.id, title: "From the item" } });
    expect(res.status).toBe(200);
    const s = (await res.json()) as { id: string; placedIn: string };
    expect(s.placedIn).toBe(v5.id);
    const bad = await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: v5.id }, body: { settings: { quietDays: 2 } } });
    expect(bad.status).toBe(400);
    const ok = await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: area.id }, body: { settings: { defaultRepo: "nope" } } });
    expect(ok.status).toBe(400);
  });

  it("share/unshare is audited and listed in Settings", async () => {
    const u = me();
    const s = createLocalSession(u, "Dinner plans");
    await patchConversation(u, s.id, { shared: true }, cid);
    expect((await sharedConversations(u)).conversations).toEqual([{ id: s.id, title: "Dinner plans", lastActiveAt: expect.any(String) }]);
    await patchConversation(u, s.id, { shared: false }, cid);
    expect((await sharedConversations(u)).conversations).toEqual([]);
    const actions = recentAudit(30).map((a) => a.action);
    expect(actions).toContain("conversation.share");
    expect(actions).toContain("conversation.unshare");
    const meta = getDb().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, s.id)).get();
    expect(meta?.shared).toBe(false);
  });
});
