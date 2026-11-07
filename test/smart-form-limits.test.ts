import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createItem, listItems } from "@/server/work/store";
import { applyIntents } from "@/server/smart/apply";
import { INBOX_REF, upsertSurface } from "@/server/smart/store";
import { formIntents } from "@/lib/jarvis-ui/v2";
import { LIMITS, type PropsOf } from "@/lib/jarvis-ui/catalog";

vi.mock("@/server/sources", () => ({
  adapterContext: () => ({ timezone: "America/Chicago" }),
  refreshSource: vi.fn(async () => undefined),
}));
let user: NonNullable<ReturnType<typeof resolveUser>>;
let parent: string;
let other: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T19:00:00Z"));
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  user = resolveUser(new Headers(), createSession(id).token)!;
  parent = `item:${createItem(user, { kind: "area", title: "Workshop" }, "test").id}`;
  other = `item:${createItem(user, { kind: "area", title: "Home" }, "test").id}`;
});
afterEach(() => vi.useRealTimers());
function form(parentRef = parent): PropsOf<"Form"> {
  return {
    title: "Weekly priorities",
    fields: [{ id: "next", label: "Priority", kind: "textarea" }],
    submit: { label: "Submit", creates: [{ parentRef, titleField: "next", splitLines: true, maxItems: 1 }] },
  };
}
function surface(p: PropsOf<"Form">, decisionParent = other) {
  const decision = { kind: "item.create" as const, parentRef: decisionParent, title: "Call supplier" };
  const s = upsertSurface(user, {
    sessionId: "mixed-surface",
    blockIndex: 0,
    spec: {
      root: "r",
      elements: {
        r: { type: "Stack", props: {}, children: ["form", "choice"] },
        form: { type: "Form", props: p },
        choice: {
          type: "DecisionCard",
          props: {
            title: "Next move",
            options: [
              { id: "call", label: "Call supplier", intent: decision },
              { id: "skip", label: "Skip" },
            ],
          },
        },
      },
    },
  });
  return { s, decision };
}
const create = (title: string, parentRef = parent) => ({ kind: "item.create" as const, parentRef, title });
describe("mixed Form and DecisionCard create allowances", () => {
  it.each([false, true])("allows one form item plus an independent DecisionCard create (same parent=%s)", async (same) => {
    const p = form();
    const { s, decision } = surface(p, same ? parent : other);
    const intents = [...formIntents(p, { next: "Build jig" }), decision];
    const result = await applyIntents(user, { surfaceId: s.id, intents, idempotencyKey: "mixed-success" }, "test");
    expect(result.results.map((r) => r.ok)).toEqual([true, true]);
    expect(
      listItems(user.id)
        .filter((i) => i.parentId)
        .map((i) => i.title)
        .sort(),
    ).toEqual(["Build jig", "Call supplier"]);
  });
  it("still refuses two free-text creates from a maxItems=1 form before any write", async () => {
    const { s, decision } = surface(form());
    await expect(
      applyIntents(user, { surfaceId: s.id, intents: [create("One"), create("Two"), decision], idempotencyKey: "too-many-form" }, "test"),
    ).rejects.toMatchObject({ code: "too_many" });
    expect(listItems(user.id).filter((i) => i.parentId)).toEqual([]);
  });
  it("binds field-selected destinations and does not borrow another binding's allowance", async () => {
    const p = form();
    p.fields.push({ id: "parent", label: "Destination", kind: "choice", options: [{ value: parent, label: "Workshop" }] });
    p.submit.creates = [
      { parentField: "parent", parentRefs: [parent], titleField: "next", maxItems: 1 },
      { parentRef: other, titleField: "next", maxItems: 1 },
    ];
    const { s } = surface(p);
    await expect(
      applyIntents(user, { surfaceId: s.id, intents: [create("One"), create("Two")], idempotencyKey: "wrong-allowance" }, "test"),
    ).rejects.toMatchObject({ code: "too_many" });
    const result = await applyIntents(user, { surfaceId: s.id, intents: [create("One"), create("Two", other)], idempotencyKey: "bound-allowance" }, "test");
    expect(result.results.every((r) => r.ok)).toBe(true);
  });
  it("refuses forged parent and non-form fields without loosening intent binding", async () => {
    const { s } = surface(form());
    for (const intent of [create("Forged", other), { ...create("Forged"), targetDate: "2026-11-07" }, { ...create("Forged"), nextAction: "Injected" }]) {
      await expect(applyIntents(user, { surfaceId: s.id, intents: [intent], idempotencyKey: "forged-fields" }, "test")).rejects.toMatchObject({
        code: "not_offered",
      });
    }
  });
  it("allocates overlapping destination allowances without making results order-dependent", async () => {
    const p = form();
    p.fields.push({
      id: "parent",
      label: "Destination",
      kind: "choice",
      options: [
        { value: parent, label: "Workshop" },
        { value: other, label: "Home" },
      ],
    });
    p.submit.creates = [
      { parentField: "parent", parentRefs: [parent, other], titleField: "next", maxItems: 1 },
      { parentRef: parent, titleField: "next", maxItems: 1 },
    ];
    const { s } = surface(p);
    const result = await applyIntents(user, { surfaceId: s.id, intents: [create("One"), create("Two", other)], idempotencyKey: "overlap-bindings" }, "test");
    expect(result.results.every((r) => r.ok)).toBe(true);
  });
  it.each([{ itemKind: "project" }, { nextAction: "" }, { targetDate: "2026-11-07" }])(
    "rejects unsupported Inbox fields even when explicitly offered: %j",
    async (extra) => {
      const intent = { ...create("Capture", INBOX_REF), ...extra };
      const s = upsertSurface(user, {
        sessionId: "inbox-fields",
        blockIndex: 0,
        spec: {
          root: "r",
          elements: {
            r: {
              type: "DecisionCard",
              props: {
                title: "Capture",
                options: [
                  { id: "go", label: "Go", intent },
                  { id: "skip", label: "Skip" },
                ],
              },
            },
          },
        },
      });
      await expect(applyIntents(user, { surfaceId: s.id, intents: [intent], idempotencyKey: "inbox-fields" }, "test")).rejects.toMatchObject({
        code: "not_offered",
      });
    },
  );
  it("keeps the global create cap for independent offered options", async () => {
    const { s, decision } = surface(form());
    await expect(
      applyIntents(
        user,
        { surfaceId: s.id, intents: Array.from({ length: LIMITS.createsPerApply + 1 }, () => decision), idempotencyKey: "global-create-cap" },
        "test",
      ),
    ).rejects.toMatchObject({ code: "too_many" });
  });
  it.each(["item.update", "todo.promote"])("does not make virtual Inbox a general %s target", async (kind) => {
    const intent = kind === "item.update" ? { kind, ref: INBOX_REF, patch: { nextAction: "Forged" } } : { kind, ref: "todo:offered", parentRef: INBOX_REF };
    const s = upsertSurface(user, {
      sessionId: "inbox-safety",
      blockIndex: 0,
      spec: {
        root: "r",
        elements: {
          r: {
            type: "DecisionCard",
            props: {
              title: "Invalid use",
              options: [
                { id: "go", label: "Go", intent },
                { id: "skip", label: "Skip" },
              ],
            },
          },
        },
      },
    });
    await expect(applyIntents(user, { surfaceId: s.id, intents: [intent], idempotencyKey: "inbox-safety" }, "test")).rejects.toMatchObject({
      code: "not_offered",
    });
  });
});
