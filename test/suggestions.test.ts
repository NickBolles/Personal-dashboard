/**
 * Task threads, step 6: suggestions (H1-H7). A coordinator writes a card for its channel with evidence from the
 * owner's own tasks; Finance and channels closed to AI are never read; five open per channel, one shown; Not now
 * hides it a week and lowers its kind; "Don't suggest this" stops the kind; it goes stale when its evidence does;
 * Start and Send are the owner's tap, and Start can be undone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { actOnSuggestion, getSuggestion, listSuggestions, suggestContext, writeSuggestion, type SuggestInput } from "@/server/work/suggestions";
import { applyProposals } from "@/server/agents/proposals";
import type { TaskRunDeps } from "@/server/work/task-runs";
import { NOT_NOW_MS, SUGGESTION_MAX_AGE_MS, SUGGESTIONS_PER_CHANNEL } from "@/lib/suggestions";
import type { WorkItem } from "@/lib/work";

const cid = "test";
let owner: CurrentUser;
let home: WorkItem;
let furnace: WorkItem;
let filter: WorkItem;
let deps: TaskRunDeps;
let sent: { sessionId: string; input: string }[];
let steered: { runId: string; input: string }[];

const viewer = () => owner as never;
const rowOf = (id: string) => getDb().select().from(schema.suggestions).where(eq(schema.suggestions.id, id)).get()!;
const items = () => store.listItems(owner.id);
const suggest = (p: Partial<SuggestInput> = {}, channel = home.id) =>
  writeSuggestion(
    owner,
    channel,
    "homechief",
    { act: "start", title: "Schedule the furnace service visit", why: "Two of three steps are done.", text: "Book the visit.", evidence: [filter.id], ...p },
    null,
  );
const id = (w: ReturnType<typeof writeSuggestion>) => {
  if (!w.ok) throw new Error(w.reason);
  return w.id;
};

beforeEach(() => {
  __setTestDatabase();
  const uid = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(uid).token)!;
  home = store.createItem(owner, { kind: "area", title: "Home" }, cid);
  store.updateItem(owner, home.id, { settings: { agentMode: "homechief" } } as never, cid);
  furnace = store.createItem(owner, { kind: "project", title: "Furnace", parentId: home.id }, cid);
  filter = store.createItem(owner, { kind: "thread", title: "Buy the furnace filter", parentId: furnace.id }, cid);
  sent = [];
  steered = [];
  let n = 0;
  deps = {
    ensureChat: async (_u, itemId) => {
      const sessionId = `sess-${++n}`;
      store.placeConversation(owner, { sessionId, parentId: itemId, title: "Chat" }, cid);
      getDb().update(schema.workItems).set({ primarySessionId: sessionId }).where(eq(schema.workItems.id, itemId)).run();
      return { sessionId, created: true };
    },
    replaceChat: vi.fn() as never,
    startRun: (async (_u: CurrentUser, r: { sessionId: string; input: string }) => {
      sent.push(r);
      return { runId: `hr-${sent.length}`, status: "running" };
    }) as never,
    steerRun: (async (_u: CurrentUser, runId: string, input: string) => {
      steered.push({ runId, input });
      return null;
    }) as never,
    sessionProfile: () => "homechief",
  };
});

describe("writing a suggestion", () => {
  it("needs evidence from the channel's own tasks, a why and what the agent is told", () => {
    expect(suggest({ evidence: [] })).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
    expect(suggest({ why: "" })).toMatchObject({ ok: false });
    const elsewhere = store.createItem(owner, { kind: "area", title: "Garage" }, cid);
    const shelf = store.createItem(owner, { kind: "thread", title: "Shelves", parentId: elsewhere.id }, cid);
    expect(suggest({ evidence: [shelf.id] })).toMatchObject({ ok: false, reason: "evidence must be tasks in this channel" });
    expect(suggest()).toMatchObject({ ok: true });
    // The same idea is not written twice.
    expect(suggest()).toMatchObject({ ok: false, reason: "already suggested" });
  });

  it("never reads Finance or a channel closed to AI, as channel, evidence or target", () => {
    const finance = store.createItem(owner, { kind: "area", title: "Finance" }, cid);
    const bills = store.createItem(owner, { kind: "thread", title: "Pay the card", parentId: finance.id }, cid);
    expect(suggest({ evidence: [bills.id] }, finance.id)).toMatchObject({ ok: false });
    expect(suggest({ evidence: [bills.id] })).toMatchObject({ ok: false });
    expect(suggest({ itemId: bills.id })).toMatchObject({ ok: false });
    const closed = store.createItem(owner, { kind: "area", title: "Private" }, cid);
    const diary = store.createItem(owner, { kind: "thread", title: "Diary", parentId: closed.id }, cid);
    store.updateItem(owner, closed.id, { settings: { aiPolicy: "excluded" } } as never, cid);
    expect(suggest({ evidence: [diary.id] }, closed.id)).toMatchObject({ ok: false });
    // And a scheduled run's suggest proposal is refused there too, with nothing stored.
    const out = applyProposals(owner, finance.id, "Suggest", "finchief", [
      { intent: "suggest", title: "Pay early", why: "It is due.", text: "Pay it.", evidence: [bills.id] },
    ]);
    expect(out.refused).toHaveLength(1);
    expect(getDb().select().from(schema.suggestions).all()).toHaveLength(0);
  });

  it("a scheduled run's suggest proposal becomes a card, never a decision or a change to the work", () => {
    const out = applyProposals(owner, home.id, "Suggest next steps", "homechief", [
      { intent: "suggest", title: "Schedule the visit", why: "The filter arrived.", text: "Book it.", evidence: [filter.id], topic: "next_step" },
    ]);
    expect(out).toMatchObject({ decisions: [], refused: [] });
    expect(out.changes).toEqual([expect.objectContaining({ intent: "suggest", label: "suggested" })]);
    expect(listSuggestions(owner, "all")).toEqual([expect.objectContaining({ title: "Schedule the visit", who: "Home coordinator", act: "start" })]);
    expect(items().some((i) => i.title === "Schedule the visit")).toBe(false);
  });

  it("keeps five open per channel and shows one: the weakest goes first", () => {
    for (let i = 0; i < SUGGESTIONS_PER_CHANNEL + 1; i++) expect(suggest({ title: `Idea ${i}` })).toMatchObject({ ok: true });
    const open = getDb().select().from(schema.suggestions).where(eq(schema.suggestions.state, "open")).all();
    expect(open).toHaveLength(SUGGESTIONS_PER_CHANNEL);
    expect(open.some((r) => r.title === "Idea 0")).toBe(false);
    const shown = listSuggestions(owner, "all");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.more).toBe(SUGGESTIONS_PER_CHANNEL - 1);
    expect(suggestContext(owner, home.id)).toContain("Already suggested");
  });
});

describe("the owner's answer", () => {
  it("Not now hides it a week and lowers its kind; Show again brings it back", async () => {
    const s = id(suggest({ topic: "review" }));
    await actOnSuggestion(viewer(), s, "not_now", cid, deps);
    expect(listSuggestions(owner, "all")).toHaveLength(0);
    expect(listSuggestions(owner, "all", new Date(Date.now() + NOT_NOW_MS + 1000))).toHaveLength(1);
    const topic = getDb().select().from(schema.suggestionTopics).get()!;
    expect(topic).toMatchObject({ topic: "review", weight: -1, blocked: false });
    await actOnSuggestion(viewer(), s, "show_again", cid, deps);
    expect(listSuggestions(owner, "all")).toHaveLength(1);
  });

  it("Don't suggest this stops the kind in this channel, and Allow undoes it", async () => {
    const s = id(suggest({ topic: "review" }));
    await actOnSuggestion(viewer(), s, "stop_topic", cid, deps);
    expect(listSuggestions(owner, "all")).toHaveLength(0);
    expect(suggest({ title: "Another review", topic: "review" })).toMatchObject({ ok: false, reason: "the owner turned this kind of suggestion off" });
    expect(suggestContext(owner, home.id)).toContain("turned off here: review");
    await actOnSuggestion(viewer(), s, "allow_topic", cid, deps);
    expect(listSuggestions(owner, "all")).toHaveLength(1);
  });

  it("Start creates the task in the channel and starts it in its chat; Undo stops it and removes the task", async () => {
    const s = id(suggest());
    const stop = vi.fn(async () => undefined);
    const { suggestion } = await actOnSuggestion(viewer(), s, "start", cid, deps, new Date(), stop);
    const made = items().find((i) => i.title === "Schedule the furnace service visit")!;
    expect(made).toMatchObject({ parentId: home.id });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toContain("Book the visit.");
    expect(suggestion).toMatchObject({ state: "started", result: { itemId: made.id, undoable: true } });
    // The done card stays for a while, then leaves.
    expect(listSuggestions(owner, "all")).toEqual([expect.objectContaining({ id: s, state: "started" })]);
    await actOnSuggestion(viewer(), s, "undo", cid, deps, new Date(), stop);
    expect(rowOf(s).state).toBe("open");
    expect(items().find((i) => i.id === made.id && !i.archived)).toBeUndefined();
    // The agent's turn is asked to stop, not only marked stopped.
    expect(stop).toHaveBeenCalledWith(expect.anything(), "hr-1", cid);
    // The start is the coordinator's, like its create: it keeps the agent Undo window, longer than the done card.
    const startOp = getDb().select().from(schema.workOps).where(eq(schema.workOps.kind, "task_start")).get()!;
    expect(startOp.via).toBe("agent:homechief");
  });

  it("two taps on Start start it once", async () => {
    const s = id(suggest());
    const results = await Promise.allSettled([actOnSuggestion(viewer(), s, "start", cid, deps), actOnSuggestion(viewer(), s, "start", cid, deps)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(sent).toHaveLength(1);
    expect(items().filter((i) => i.title === "Schedule the furnace service visit")).toHaveLength(1);
  });

  it("a failed Start releases the card so it can be tried again", async () => {
    const s = id(suggest());
    const failing = { ...deps, startRun: (async () => Promise.reject(new Error("Hermes is not answering"))) as never };
    await expect(actOnSuggestion(viewer(), s, "start", cid, failing)).rejects.toThrow("Hermes is not answering");
    expect(rowOf(s).state).toBe("open");
  });

  it("a card read back in a chat is hidden by Not now and by Don't suggest this", async () => {
    const s = id(suggest({ topic: "review" }));
    expect(getSuggestion(owner, s)).not.toBeNull();
    await actOnSuggestion(viewer(), s, "not_now", cid, deps);
    expect(getSuggestion(owner, s)).toBeNull();
    await actOnSuggestion(viewer(), s, "show_again", cid, deps);
    await actOnSuggestion(viewer(), s, "stop_topic", cid, deps);
    expect(getSuggestion(owner, s)).toBeNull();
  });

  it("Send posts the steer into the working task's chat; a steer is only for a task that is working", async () => {
    expect(suggest({ act: "steer", itemId: filter.id, title: "Use last month's list" })).toMatchObject({ ok: false });
    await deps.ensureChat(owner as never, filter.id, undefined as never, cid);
    const session = store.listItems(owner.id).find((i) => i.id === filter.id)!.primarySessionId!;
    getDb().insert(schema.runs).values({ runId: "hr-live", userId: owner.id, sessionId: session, status: "running", idempotencyKey: "k-live" }).run();
    const s = id(suggest({ act: "steer", itemId: filter.id, title: "Use last month's list", text: "Use last month's prices." }));
    await actOnSuggestion(viewer(), s, "start", cid, deps);
    expect(steered).toEqual([{ runId: "hr-live", input: "Use last month's prices." }]);
    expect(rowOf(s)).toMatchObject({ state: "started" });
    await expect(actOnSuggestion(viewer(), s, "undo", cid, deps)).rejects.toMatchObject({ code: "not_undoable" });
  });
});

describe("staleness (H6)", () => {
  it("goes when an evidence task is closed", () => {
    const a = id(suggest());
    store.updateItem(owner, filter.id, { status: "abandoned", reason: "Bought another way" } as never, cid);
    expect(listSuggestions(owner, "all")).toHaveLength(0);
    expect(rowOf(a).state).toBe("stale");
  });

  it("goes when its evidence stops being true, or when it gets old", async () => {
    const a = id(suggest());
    store.updateItem(owner, filter.id, { archived: true } as never, cid);
    expect(listSuggestions(owner, "all")).toHaveLength(0);
    expect(rowOf(a).state).toBe("stale");
    const other = store.createItem(owner, { kind: "thread", title: "Clean the vents", parentId: furnace.id }, cid);
    const b = id(suggest({ evidence: [other.id], title: "Vents" }));
    expect(getSuggestion(owner, b)).not.toBeNull();
    expect(listSuggestions(owner, "all", new Date(Date.now() + SUGGESTION_MAX_AGE_MS + 1000))).toHaveLength(0);
    await expect(actOnSuggestion(viewer(), b, "start", cid, deps)).rejects.toMatchObject({ code: "not_open" });
  });
});
