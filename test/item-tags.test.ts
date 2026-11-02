/** #111 item tags and assignees: normalisation, assignee validation, store edits + undo, rename/merge. */
import { beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as store from "@/server/work/store";
import { listTags, renameTag } from "@/server/work/tags";
import { normalizeWorkEvent } from "@/lib/activity";
import {
  MAX_TAGS,
  assigneeLabel,
  defaultTagColor,
  matchesItemFilter,
  normaliseTag,
  normaliseTags,
  parseAssignee,
  parseTags,
  tagsChangeText,
  validateAssignee,
} from "@/lib/item-tags";

describe("tag normalisation", () => {
  it("slugs, strips #, collapses separators", () => {
    expect(normaliseTag("  #Home Lab!! ")).toBe("home-lab");
    expect(normaliseTag("Q4_Plan/2026")).toBe("q4-plan-2026");
    expect(normaliseTag("--a--b--")).toBe("a-b");
    expect(normaliseTag("Café")).toBe("café");
    expect(normaliseTag("!!!")).toBeNull();
    expect(normaliseTag("x".repeat(80))!.length).toBe(32);
  });
  it("dedupes and sorts; rejects too many", () => {
    expect(normaliseTags(["b", "A", "a", " ", "#b"])).toEqual({ ok: true, value: ["a", "b"] });
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(normaliseTags(many).ok).toBe(false);
  });
  it("parses stored JSON defensively", () => {
    expect(parseTags('["a","b"]')).toEqual(["a", "b"]);
    expect(parseTags("nope")).toEqual([]);
    expect(parseTags('[1,"a"]')).toEqual(["a"]);
    expect(parseTags(null)).toEqual([]);
  });
  it("colours are stable token keys", () => {
    expect(defaultTagColor("home")).toBe(defaultTagColor("home"));
    expect(["ac", "ai", "ok", "wn", "bad", "inf"]).toContain(defaultTagColor("anything"));
  });
  it("describes changes", () => {
    expect(tagsChangeText(["a"], ["a", "b"])).toBe("Tagged #b");
    expect(tagsChangeText(["a", "b"], ["b", "c"])).toBe("Tagged #c; Untagged #a");
  });
});

describe("assignee validation", () => {
  const ctx = { agents: ["devchief", "momentumchief"], people: ["u1"] };
  it("accepts known agents (normalising @ and case) and people", () => {
    expect(validateAssignee("agent:@DevChief", ctx)).toEqual({ ok: true, value: "agent:devchief" });
    expect(validateAssignee("person:u1", ctx)).toEqual({ ok: true, value: "person:u1" });
    expect(validateAssignee(null, ctx)).toEqual({ ok: true, value: null });
  });
  it("rejects unknown agents, people and bad refs", () => {
    expect(validateAssignee("agent:nobody", ctx).ok).toBe(false);
    expect(validateAssignee("agent:../x", ctx).ok).toBe(false);
    expect(validateAssignee("person:u2", ctx).ok).toBe(false);
    expect(validateAssignee("devchief", ctx).ok).toBe(false);
  });
  it("labels and filters", () => {
    expect(parseAssignee("agent:devchief")).toEqual({ kind: "agent", id: "devchief" });
    expect(assigneeLabel("agent:devchief")).toBe("@devchief");
    expect(assigneeLabel("person:u1", [{ id: "u1", name: "Nick" }])).toBe("Nick");
    const item = { tags: ["home"], assignee: "agent:devchief" };
    expect(matchesItemFilter(item, { tag: "#Home" })).toBe(true);
    expect(matchesItemFilter(item, { tag: "work" })).toBe(false);
    expect(matchesItemFilter(item, { assignee: "agent:devchief" })).toBe(true);
    expect(matchesItemFilter(item, { assignee: "none" })).toBe(false);
    expect(matchesItemFilter({ tags: [], assignee: null }, { assignee: "none" })).toBe(true);
  });
});

describe("store: tags + assignee edits", () => {
  let owner: string;
  let other: string;
  beforeEach(() => {
    __setTestDatabase();
    owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
    other = createPerson({ name: "Robin", username: "robin", role: "adult", passcode: "synthetic-pass" }, owner).id;
  });
  const userOf = (id: string) => resolveUser(new Headers(), createSession(id).token)!;
  const cid = "test";

  it("sets tags (normalised, created on the fly) and assignee; undo restores both", () => {
    const u = userOf(owner);
    const item = store.createItem(u, { kind: "thread", title: "Fix the fence" }, cid);
    const out: store.OpOut = {};
    const a = store.updateItem(u, item.id, { tags: ["Garden", "#garden", "Weekend Job"], assignee: "agent:devchief" }, cid, out);
    expect(a.tags).toEqual(["garden", "weekend-job"]);
    expect(a.assignee).toBe("agent:devchief");
    expect(out.op).toBeTruthy();
    expect(listTags(owner).map((t) => t.name)).toEqual(["garden", "weekend-job"]);
    store.undoOp(u, out.op!.id, cid);
    const back = store.getDetail(owner, item.id).item;
    expect(back.tags).toEqual([]);
    expect(back.assignee).toBeNull();
  });

  it("assigns to a person and rejects unknown assignees", () => {
    const u = userOf(owner);
    const item = store.createItem(u, { kind: "thread", title: "Gutter clean" }, cid);
    expect(store.updateItem(u, item.id, { assignee: `person:${other}` }, cid).assignee).toBe(`person:${other}`);
    expect(() => store.updateItem(u, item.id, { assignee: "agent:ghost" }, cid)).toThrow(/agent/);
    expect(() => store.updateItem(u, item.id, { assignee: "person:nobody" }, cid)).toThrow(/People/);
    expect(store.updateItem(u, item.id, { assignee: null }, cid).assignee).toBeNull();
  });

  it("records activity events for assign/tag changes", () => {
    const u = userOf(owner);
    const item = store.createItem(u, { kind: "thread", title: "Paint shed" }, cid);
    store.updateItem(u, item.id, { tags: ["paint"], assignee: "agent:momentumchief" }, cid);
    const reasons = store.getDetail(owner, item.id).events.map((e) => e.reason);
    expect(reasons).toContain("Assigned to @momentumchief");
    expect(reasons).toContain("Tagged #paint");
    const verb = normalizeWorkEvent(
      {
        id: "e",
        itemId: item.id,
        kind: "edit",
        fromStatus: null,
        toStatus: null,
        reason: "Tagged #paint",
        actor: owner,
        source: null,
        at: new Date().toISOString(),
      },
      owner,
      "Paint shed",
    ).verb;
    expect(verb).toBe("tagged #paint");
  });

  it("renames and merges tags across items", () => {
    const u = userOf(owner);
    const a = store.createItem(u, { kind: "thread", title: "Alpha" }, cid);
    const b = store.createItem(u, { kind: "thread", title: "Beta" }, cid);
    store.updateItem(u, a.id, { tags: ["homelab"] }, cid);
    store.updateItem(u, b.id, { tags: ["home-lab", "homelab"] }, cid);
    const r = renameTag(owner, "homelab", "home-lab");
    expect(r).toEqual({ touched: 2, merged: true });
    expect(store.getDetail(owner, a.id).item.tags).toEqual(["home-lab"]);
    expect(store.getDetail(owner, b.id).item.tags).toEqual(["home-lab"]);
    expect(listTags(owner).map((t) => [t.name, t.count])).toEqual([["home-lab", 2]]);
  });
});
