import { describe, expect, it } from "vitest";
import { INLINE_STATUSES, inlineReducer, inlineStatusOptions, validateInline, withPending, type InlineState } from "@/lib/inline-edit";

describe("inline edit validation", () => {
  it("trims and collapses titles, rejects empty ones", () => {
    expect(validateInline("title", "  Fix   the  roof ")).toEqual({ ok: true, value: "Fix the roof" });
    expect(validateInline("title", "   ").ok).toBe(false);
    expect(validateInline("title", "x".repeat(201)).ok).toBe(false);
  });
  it("requires a next action for ready and in-progress work only", () => {
    expect(validateInline("nextAction", " ", { status: "ready" }).ok).toBe(false);
    expect(validateInline("nextAction", " ", { status: "in_progress" }).ok).toBe(false);
    expect(validateInline("nextAction", " ", { status: "exploring" })).toEqual({ ok: true, value: "" });
  });
  it("keeps summary line breaks but drops trailing space", () => {
    expect(validateInline("summary", "a\n\nb  \n")).toEqual({ ok: true, value: "a\n\nb" });
  });
  it("parses due dates; empty clears", () => {
    expect(validateInline("targetDate", "2026-11-30")).toEqual({ ok: true, value: "2026-11-30" });
    expect(validateInline("targetDate", "")).toEqual({ ok: true, value: null });
    expect(validateInline("targetDate", "Nov 30").ok).toBe(false);
  });
  it("never offers settling inline", () => {
    for (const s of ["settled", "ready_to_settle", "superseded", "abandoned"] as const) {
      expect(INLINE_STATUSES).not.toContain(s);
      expect(validateInline("status", s).ok).toBe(false);
    }
    expect(validateInline("status", "on_hold")).toEqual({ ok: true, value: "on_hold" });
    expect(inlineStatusOptions("ready").map((o) => o.value)).not.toContain("settled");
    // A settled item shows its status, but it can't be picked as a change.
    const settled = inlineStatusOptions("settled");
    expect(settled[0]).toMatchObject({ value: "settled", disabled: true });
    expect(settled.filter((o) => o.value === "settled")).toHaveLength(1);
  });
});

describe("optimistic reducer", () => {
  const item = { id: "w1", title: "Old", nextAction: "", summary: "", status: "ready" as const, targetDate: null };
  it("applies pending values and commits them", () => {
    let s: InlineState = {};
    s = inlineReducer(s, { type: "begin", id: "w1", field: "title", value: "New", prev: "Old" });
    expect(withPending(item, s).title).toBe("New");
    s = inlineReducer(s, { type: "commit", id: "w1", field: "title" });
    expect(s).toEqual({});
    expect(withPending(item, s).title).toBe("Old"); // server value takes over after commit
  });
  it("rolls back one field without touching another pending one", () => {
    let s: InlineState = {};
    s = inlineReducer(s, { type: "begin", id: "w1", field: "title", value: "A", prev: "Old" });
    s = inlineReducer(s, { type: "begin", id: "w1", field: "targetDate", value: "2026-12-01", prev: null });
    s = inlineReducer(s, { type: "rollback", id: "w1", field: "title" });
    expect(withPending(item, s)).toMatchObject({ title: "Old", targetDate: "2026-12-01" });
  });
  it("keeps the first previous value across rapid edits", () => {
    let s: InlineState = {};
    s = inlineReducer(s, { type: "begin", id: "w1", field: "title", value: "A", prev: "Old" });
    s = inlineReducer(s, { type: "begin", id: "w1", field: "title", value: "B", prev: "A" });
    expect(s.w1!.prev.title).toBe("Old");
    expect(withPending(item, s).title).toBe("B");
  });
  it("ignores commit/rollback for fields that aren't pending", () => {
    const s: InlineState = {};
    expect(inlineReducer(s, { type: "rollback", id: "w1", field: "summary" })).toBe(s);
  });
});
