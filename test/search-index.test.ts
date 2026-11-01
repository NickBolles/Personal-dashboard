/**
 * The palette (/api/search) and composer `@` (/api/references) search: one
 * in-memory index over the persisted conversation index + the Areas tree, so
 * no keystroke waits on Hermes' session list (prod: 2.5 s/4 s per query before,
 * and chats were never found because that provider always timed out).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { writeIndex } from "@/server/work/conversation-index";
import { ensureMiscellaneous } from "@/server/work/store";
import * as conversations from "@/server/work/conversations";
import { search } from "@/server/search";
import { referenceOptions, resolveReferences } from "@/server/references";
import { __resetSearchMemo, chatEntries, memo } from "@/server/search-index";
import type { SessionSummary } from "@/lib/hermes";

let owner: string;
const me = () => resolveUser(new Headers(), createSession(owner).token)!;
const iso = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
const sess = (id: string, title: string, at: string, preview?: string): SessionSummary => ({
  id,
  title,
  preview,
  lastActiveAt: at,
  startedAt: at,
  pinned: false,
  archived: false,
});

/** ~2k rows: 1000 work items (10 areas × 10 projects × 9 threads + nodes) and 1000 indexed conversations. */
function seed(n = 1000) {
  const db = getDb();
  const misc = ensureMiscellaneous(owner);
  const items: (typeof schema.workItems.$inferInsert)[] = [];
  let k = 0;
  for (let a = 0; a < 10; a++) {
    const areaId = `wi_area_${a}`;
    items.push({ id: areaId, userId: owner, parentId: null, kind: "area", title: `Area ${a} household`, updatedAt: iso(k++) });
    for (let p = 0; p < 10; p++) {
      const projectId = `wi_p_${a}_${p}`;
      items.push({ id: projectId, userId: owner, parentId: areaId, kind: "project", title: `Project ${a}.${p} renovation`, updatedAt: iso(k++) });
      for (let t = 0; t < 9; t++)
        items.push({
          id: `wi_t_${a}_${p}_${t}`,
          userId: owner,
          parentId: projectId,
          kind: "thread",
          title: `Thread ${a}.${p}.${t} paint samples`,
          summary: "pick colours",
          updatedAt: iso(k++),
        });
    }
  }
  // Finance: an area, a project and a filed chat under it.
  items.push({ id: "wi_fin", userId: owner, parentId: null, kind: "area", title: "Finance", updatedAt: iso(k++) });
  items.push({ id: "wi_fin_p", userId: owner, parentId: "wi_fin", kind: "project", title: "Budget review quarterly", updatedAt: iso(k++) });
  items.push({ id: "wi_fin_c", userId: owner, parentId: "wi_fin", kind: "conversation", title: "Tax planning chat", sessionId: "s_tax", updatedAt: iso(k++) });
  // Filed under Miscellaneous, like prod's "Teaching notes."
  items.push({ id: "wi_teach", userId: owner, parentId: misc.id, kind: "conversation", title: "Teaching notes.", sessionId: "s_teach", updatedAt: iso(k++) });
  db.transaction((tx) => {
    for (const i of items) tx.insert(schema.workItems).values(i).run();
  });
  const sessions: SessionSummary[] = [];
  for (let i = 0; i < n - 3; i++) sessions.push(sess(`s_${i}`, `Chat ${i} about groceries`, iso(i), `recent message ${i} about dinner`));
  sessions.push(sess("s_teach", "Teaching notes.", iso(5000)));
  sessions.push(sess("s_lesson", "Lesson plan", iso(10), "notes from teaching the kids fractions"));
  sessions.push(sess("s_tax", "Tax planning chat", iso(11), "what about the tax return"));
  writeIndex(owner, sessions, true);
  return { items: items.length, sessions: sessions.length };
}

beforeEach(() => {
  __setTestDatabase();
  conversations.__resetConversationCache();
  __resetSearchMemo();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
});

describe("palette search", () => {
  it("finds a conversation filed in Miscellaneous by title, grouped as Chats & notes, without calling Hermes", async () => {
    seed(200);
    const r = await search(me(), "teaching");
    const chats = r.results.filter((x) => x.kind === "conversation");
    expect(chats[0]).toMatchObject({ title: "Teaching notes.", group: "Chats & notes", href: "/chat/s_teach" });
    expect(chats[0]!.subtitle).toContain("Miscellaneous");
    expect(r.partial).toEqual([]);
  });

  it("ranks a title match above a snippet (preview) match", async () => {
    seed(200);
    const titles = (await search(me(), "teaching")).results.filter((x) => x.kind === "conversation").map((x) => x.title);
    expect(titles.indexOf("Teaching notes.")).toBeLessThan(titles.indexOf("Lesson plan"));
    expect(titles).toContain("Lesson plan"); // found by its recent message snippet
  });

  it("groups work items as Areas / Projects / Items", async () => {
    seed(200);
    const groups = new Set((await search(me(), "renovation")).results.map((x) => x.group));
    expect(groups.has("Projects")).toBe(true);
    expect((await search(me(), "household")).results.some((x) => x.group === "Areas")).toBe(true);
    expect((await search(me(), "paint samples")).results.some((x) => x.group === "Items")).toBe(true);
  });

  it("empty query returns recent chats and items for an instant open", async () => {
    seed(200);
    const r = await search(me(), "");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((x) => x.group === "Recent")).toBe(true);
    expect(r.results[0]).toMatchObject({ title: "Teaching notes." });
  });

  it("finance-filed chats stay in navigation only (palette), as before", async () => {
    seed(200);
    expect((await search(me(), "tax planning")).results.some((x) => x.href === "/chat/s_tax")).toBe(true);
  });
});

describe("composer @ references", () => {
  it("offers 'Teaching notes.' as a chat reference and resolves it with where it's filed", async () => {
    seed(200);
    const r = await referenceOptions(me(), "teaching");
    const chat = r.sections.find((s) => s.type === "chat");
    expect(chat?.options[0]).toMatchObject({ type: "chat", id: "s_teach", label: "Teaching notes." });
    expect(r.partial).toEqual([]);
    const ctx = await resolveReferences(me(), [{ type: "chat", id: "s_teach", label: "Teaching notes." }]);
    expect(ctx).toContain("Conversation “Teaching notes.” (session id s_teach)");
    expect(ctx).toContain("Filed under: Miscellaneous");
  });

  it("never offers or resolves Finance content as AI context", async () => {
    seed(200);
    const all = (await referenceOptions(me(), "tax")).sections.flatMap((s) => s.options);
    expect(all.some((o) => o.id === "s_tax")).toBe(false);
    expect((await referenceOptions(me(), "budget review")).sections.flatMap((s) => s.options)).toEqual([]);
    expect((await referenceOptions(me(), "finance")).sections.flatMap((s) => s.options).some((o) => o.id === "wi_fin")).toBe(false);
    expect(await resolveReferences(me(), [{ type: "chat", id: "s_tax", label: "Tax planning chat" }])).toBe("");
    expect(await resolveReferences(me(), [{ type: "item", id: "wi_fin_p", label: "Budget review quarterly" }])).toBe("");
    expect(chatEntries(me()).find((c) => c.sessionId === "s_tax")?.finance).toBe(true);
  });

  it("lists filed conversations even before the Hermes index has loaded", async () => {
    const misc = ensureMiscellaneous(owner);
    getDb()
      .insert(schema.workItems)
      .values({ id: "wi_cold", userId: owner, parentId: misc.id, kind: "conversation", title: "Teaching notes.", sessionId: "s_cold" })
      .run();
    // mark a failed attempt so the background refresh backs off (no Hermes in tests)
    getDb().insert(schema.conversationIndex).values({ userId: owner, attemptedAt: new Date().toISOString(), lastError: "error" }).run();
    const r = await referenceOptions(me(), "teach");
    expect(r.sections.find((s) => s.type === "chat")?.options.map((o) => o.id)).toEqual(["s_cold"]);
  });
});

describe("archived conversations (#100)", () => {
  it("a filed chat archived in session_meta stays out of @ and Recent even when the index lacks it", async () => {
    const misc = ensureMiscellaneous(owner);
    const db = getDb();
    db.insert(schema.workItems)
      .values({ id: "wi_arch", userId: owner, parentId: misc.id, kind: "conversation", title: "Gutter quotes archived", sessionId: "s_arch" })
      .run();
    // archived through updateSession/updateLocalSession: only session_meta changes, the node stays unarchived
    db.insert(schema.sessionMeta).values({ sessionId: "s_arch", userId: owner, archived: true }).run();
    db.insert(schema.conversationIndex).values({ userId: owner, attemptedAt: new Date().toISOString(), lastError: "error" }).run();
    expect(chatEntries(me()).find((c) => c.sessionId === "s_arch")?.archived).toBe(true);
    const at = (await referenceOptions(me(), "gutter")).sections.flatMap((s) => s.options);
    expect(at.some((o) => o.id === "s_arch")).toBe(false);
    expect((await search(me(), "")).results.map((x) => x.title)).not.toContain("Gutter quotes archived");
    // unarchiving brings it back
    db.update(schema.sessionMeta).set({ archived: false }).run();
    __resetSearchMemo();
    expect((await referenceOptions(me(), "gutter")).sections.flatMap((s) => s.options).map((o) => o.id)).toContain("s_arch");
    expect((await search(me(), "")).results.map((x) => x.title)).toContain("Gutter quotes archived");
  });
});

describe("performance on ~2k seeded rows", () => {
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
  it("palette and @ answer in < 100 ms p95", async () => {
    const n = seed(1000);
    expect(n.items + n.sessions).toBeGreaterThanOrEqual(2000);
    const u = me();
    await search(u, "warm");
    await referenceOptions(u, "warm");
    const queries = ["t", "te", "tea", "teach", "teaching", "teaching notes", "chat 5", "renovation", "paint", "groceries", "dinner", "x"];
    const ps: number[] = [];
    const rs: number[] = [];
    for (let round = 0; round < 3; round++)
      for (const q of queries) {
        let t = performance.now();
        await search(u, q);
        ps.push(performance.now() - t);
        t = performance.now();
        await referenceOptions(u, q);
        rs.push(performance.now() - t);
      }
    console.info(`[perf] 2k rows: palette p95 ${p95(ps).toFixed(1)} ms, @ p95 ${p95(rs).toFixed(1)} ms`);
    expect(p95(ps)).toBeLessThan(100);
    expect(p95(rs)).toBeLessThan(100);
  });
});

describe("memo (stale-while-revalidate)", () => {
  it("answers from cache, refreshes stale values in the background, shares the first load", async () => {
    let calls = 0;
    const load = () => new Promise<number>((r) => setTimeout(() => r(++calls), 5));
    const [a, b] = await Promise.all([memo("k", 0, load), memo("k", 0, load)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await memo("k", 0, load)).toBe(1); // stale → served, refresh started
    await new Promise((r) => setTimeout(r, 20));
    expect(await memo("k", 60_000, load)).toBe(2);
  });
});
