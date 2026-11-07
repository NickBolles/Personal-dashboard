import { describe, expect, it } from "vitest";
import { COMPONENTS, type ComponentName, type JarvisSpec, type PropsOf } from "@/lib/jarvis-ui/catalog";
import { intentInSpec } from "@/lib/jarvis-ui/intents";
import { formIntents, ganttLayout, matrixIntent, matrixTotals, smartUndoKey } from "@/lib/jarvis-ui/v2";
import { specRefs, validateSpec } from "@/lib/jarvis-ui/validator";
import { pickTrayLine, priorityLine } from "@/lib/coordinator/things";
import type { DynamicCard } from "@/lib/jarvis-ui/dynamic";

export const matrix: PropsOf<"DecisionMatrix"> = {
  title: "Iris evaluator",
  ref: "item:iris",
  criteria: [
    { id: "speed", label: "Speed", weight: 1 },
    { id: "quality", label: "Quality", weight: 2 },
  ],
  options: [
    { id: "patch", label: "Patch Iris", scores: { speed: 5, quality: 2 } },
    { id: "replace", label: "Replace Iris", scores: { speed: 1, quality: 5 } },
  ],
};
const form: PropsOf<"Form"> = {
  title: "Iris review",
  fields: [{ id: "next", label: "Next", kind: "textarea", required: true }],
  submit: { label: "Submit", creates: [{ parentRef: "item:iris", titleField: "next", splitLines: true, maxItems: 3 }] },
};
const one = (type: ComponentName, props: object): JarvisSpec => ({
  v: 1,
  catalog: "jarvis-ui@1",
  root: "r",
  elements: { r: { type, props: props as Record<string, unknown> } },
});
const valid = {
  DecisionMatrix: matrix,
  Gantt: { title: "Iris dates", rows: [{ ref: "item:iris" }] },
  BarChart: { metric: "metric:items_done_14d" },
  ApprovalQueue: { title: "Pending" },
  Form: form,
};

describe("Smart UI v2 strict catalog", () => {
  it.each(Object.entries(valid))("%s accepts valid props, rejects URLs/HTML and unknown keys", (name, props) => {
    const schema = COMPONENTS[name as ComponentName];
    expect(schema.safeParse(props).success).toBe(true);
    expect(schema.safeParse({ ...props, style: "red" }).success).toBe(false);
    expect(schema.safeParse({ ...props, [name === "BarChart" ? "label" : "title"]: "https://bad.test" }).success).toBe(false);
    expect(schema.safeParse({ ...props, [name === "BarChart" ? "label" : "title"]: "<img src=x>" }).success).toBe(false);
  });
  it("rejects bad refs, weights, scores, duplicate ids and missing/extra criteria", () => {
    expect(COMPONENTS.DecisionMatrix.safeParse({ ...matrix, ref: "https://bad.test" }).success).toBe(false);
    for (const weight of [0, 4, 1.5])
      expect(COMPONENTS.DecisionMatrix.safeParse({ ...matrix, criteria: [{ ...matrix.criteria[0], weight }, matrix.criteria[1]] }).success).toBe(false);
    for (const scores of [{ speed: 0, quality: 2 }, { speed: 6, quality: 2 }, { speed: 5 }, { speed: 5, quality: 2, extra: 3 }])
      expect(COMPONENTS.DecisionMatrix.safeParse({ ...matrix, options: [{ ...matrix.options[0], scores }, matrix.options[1]] }).success).toBe(false);
    expect(COMPONENTS.DecisionMatrix.safeParse({ ...matrix, criteria: [matrix.criteria[0], matrix.criteria[0]] }).success).toBe(false);
    expect(COMPONENTS.Gantt.safeParse({ title: "x", rows: [{ ref: "todo:x" }] }).success).toBe(false);
    expect(COMPONENTS.Gantt.safeParse({ title: "x", rows: Array.from({ length: 31 }, () => ({ ref: "item:x" })) }).success).toBe(false);
    expect(COMPONENTS.Gantt.safeParse({ title: "x", rows: [{ ref: "item:x", start: "2026-02-30" }] }).success).toBe(false);
    // Unknown series survive validation so the hydrator can report Unavailable;
    // it still has no path to invent values or resolve Finance.
    expect(COMPONENTS.BarChart.safeParse({ metric: "metric:unknown_series" }).success).toBe(true);
    expect(COMPONENTS.BarChart.safeParse({ metric: "https://bad.test" }).success).toBe(false);
    expect(COMPONENTS.BarChart.safeParse({ metric: "metric:items_done_14d", series: [123] }).success).toBe(false);
    expect(COMPONENTS.ApprovalQueue.safeParse({ rows: [] }).success).toBe(false);
    expect(COMPONENTS.Form.safeParse({ ...form, fields: Array.from({ length: 13 }, () => form.fields[0]) }).success).toBe(false);
    expect(COMPONENTS.Form.safeParse({ ...form, submit: { label: "Go", creates: [{ parentRef: "url:x", titleField: "next" }] } }).success).toBe(false);
  });
  it("drops unknown components, collects only real refs", () => {
    const v = validateSpec({
      root: "r",
      elements: {
        r: { type: "Stack", props: {}, children: ["mx", "bad", "form", "queue"] },
        mx: { type: "DecisionMatrix", props: matrix },
        bad: { type: "Script", props: {} },
        form: { type: "Form", props: form },
        queue: { type: "ApprovalQueue", props: {} },
      },
    });
    expect(v.ok && v.dropped).toBe(1);
    if (v.ok) expect(specRefs(v.spec).sort()).toEqual(["approvals:pending", "item:iris"]);
  });
});
describe("pure v2 calculations and intent binding", () => {
  it("recomputes totals and all tied recommendations locally", () => {
    expect(matrixTotals(matrix)).toEqual([
      { id: "patch", total: 9, recommended: false },
      { id: "replace", total: 11, recommended: true },
    ]);
    expect(matrixTotals(matrix, { speed: 3, quality: 1 })[0]).toEqual({ id: "patch", total: 17, recommended: true });
    expect(matrix.criteria[0]!.weight).toBe(1);
  });
  it("binds exactly the offered decision, not forged patches or refs", () => {
    const spec = one("DecisionMatrix", matrix);
    expect(intentInSpec(spec, matrixIntent(matrix, matrix.options[0]!), "2026-11-06")).toBe(true);
    expect(intentInSpec(spec, { kind: "item.update", ref: "item:iris", patch: { nextAction: "Decided: Forged" } }, "2026-11-06")).toBe(false);
    expect(intentInSpec(spec, { kind: "item.update", ref: "item:other", patch: { nextAction: "Decided: Patch Iris" } }, "2026-11-06")).toBe(false);
    expect(intentInSpec(spec, { kind: "item.update", ref: "item:iris", patch: { nextAction: "Decided: Patch Iris", status: "abandoned" } }, "2026-11-06")).toBe(
      false,
    );
  });
  it("lays out hydrated late/done/milestone bars and created-date fallback", () => {
    const task = { ref: "item:iris", kind: "item" as const, title: "Iris", due: "2026-11-05", status: "in_progress" };
    expect(ganttLayout(task, { ref: task.ref }, "2026-11-01", "2026-11-11", "2026-11-06")).toMatchObject({
      start: "2026-10-29",
      end: "2026-11-05",
      left: 0,
      tone: "danger",
      milestone: false,
    });
    expect(
      ganttLayout({ ...task, done: true, createdDate: "2026-11-02" }, { ref: task.ref, milestone: true }, "2026-11-01", "2026-11-11", "2026-11-06"),
    ).toMatchObject({ start: "2026-11-02", tone: "ok", milestone: true });
    expect(ganttLayout({ ...task, due: undefined }, { ref: task.ref }, "2026-11-01", "2026-11-11", "2026-11-06")).toBeUndefined();
    const spec = one("Gantt", { title: "Dates", rows: [{ ref: task.ref }], from: "2026-11-01", to: "2026-11-10" });
    expect(intentInSpec(spec, { kind: "item.update", ref: task.ref, patch: { targetDate: "2026-11-07" } }, "2026-11-06")).toBe(true);
    for (const targetDate of ["2026-11-05", "2026-11-11", "2028-01-01"])
      expect(intentInSpec(spec, { kind: "item.update", ref: task.ref, patch: { targetDate } }, "2026-11-06")).toBe(false);
  });
  it("forms stage at most three typed creates and do not widen parent/patch scope", () => {
    const intents = formIntents(form, { next: "1. Iris alpha\n2. Iris beta\n3. Iris gamma\n4. Iris delta" });
    expect(intents).toHaveLength(3);
    for (const i of intents) expect(intentInSpec(one("Form", form), i, "2026-11-06")).toBe(true);
    expect(intentInSpec(one("Form", form), { kind: "item.create", parentRef: "item:foreign", title: "Iris" }, "2026-11-06")).toBe(false);
    expect(intentInSpec(one("Form", form), { kind: "item.create", parentRef: "item:iris", title: "Iris", targetDate: "2026-11-07" }, "2026-11-06")).toBe(false);
    expect(formIntents(form, { next: "https://bad.test" })).toEqual([]);
  });
});
describe("dynamic tray arbitration", () => {
  const card: DynamicCard = {
    id: "iris-week",
    kind: "weekly-review",
    line: { tone: "warn", dot: "yellow", icon: "≡", label: "Weekly review", text: "Fill in" },
    spec: one("Form", form),
    sessionId: "dynamic:iris-week",
    blockIndex: 0,
    action: "Fill in",
  };
  const base = { needsYou: 0, doneUnseen: 0, running: 0, failing: 0 };
  it("failing and needs-you win; dynamic beats idle/running/done", () => {
    for (const p of [
      { ...base, failing: 1 },
      { ...base, needsYou: 1 },
    ])
      expect(pickTrayLine(priorityLine(p), [card]).card).toBeUndefined();
    for (const p of [base, { ...base, running: 1 }, { ...base, doneUnseen: 1 }]) expect(pickTrayLine(priorityLine(p), [card]).card?.id).toBe(card.id);
  });
  it("skips snoozes and falls back with no cards", () => {
    const priority = priorityLine(base);
    expect(pickTrayLine(priority, [card], [card.id])).toEqual(priority);
    expect(pickTrayLine(priority, [{ ...card, snoozed: true }])).toEqual(priority);
    expect(pickTrayLine(priority, [])).toEqual(priority);
  });
});
it("Ctrl/Cmd Z respects native text undo and key modifiers", () => {
  const e = { key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: null };
  expect(smartUndoKey(e)).toBe(true);
  expect(smartUndoKey({ ...e, ctrlKey: false, metaKey: true })).toBe(true);
  for (const change of [{ ctrlKey: false }, { shiftKey: true }, { altKey: true }, { key: "x" }, { defaultPrevented: true }])
    expect(smartUndoKey({ ...e, ...change })).toBe(false);
  const target = { closest: () => ({}) } as unknown as EventTarget;
  expect(smartUndoKey({ ...e, target })).toBe(false);
});
