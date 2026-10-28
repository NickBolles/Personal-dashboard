import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMPONENT_NAMES, LIMITS } from "@/lib/jarvis-ui/catalog";
import { splitBlocks, summaryText } from "@/lib/jarvis-ui/parser";
import { canonicalJson, specRefs, validateBlock, validateSpec } from "@/lib/jarvis-ui/validator";
import { describeIntent, intentInSpec, rowIntent, thisWeekDate, type Intent } from "@/lib/jarvis-ui/intents";
import { formatOverdue } from "@/server/smart/context";
import { smartInstructions } from "@/server/smart/prompt";
import { buildAssists } from "@/server/ranking/assists";
import type { NextAction } from "@/lib/contracts";

const FIX = path.join(import.meta.dirname, "fixtures/jarvis-ui");
const fixture = (n: string) => fs.readFileSync(path.join(FIX, n), "utf8");
const TODAY = "2026-10-27";

describe("jarvis-ui@1 catalog fixtures", () => {
  it.each(["overdue-triage.json", "decision-checklist-gauge.json"])("%s validates with nothing dropped", (n) => {
    const v = validateBlock(fixture(n));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.dropped).toBe(0);
  });

  it("drops unknown components, bad enums and style props but keeps the rest", () => {
    const v = validateBlock(fixture("unknown-and-invalid.json"));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(Object.keys(v.spec.elements).sort()).toEqual(["ok", "r"]);
    expect(v.spec.elements.r!.children).toEqual(["ok"]);
    expect(v.dropped).toBe(3);
  });

  it("fails closed on broken JSON, wrong catalog, oversize, too many elements, depth and missing root", () => {
    expect(validateBlock("{nope")).toEqual({ ok: false, reason: "json" });
    expect(validateSpec({ catalog: "other@1", root: "r", elements: {} })).toEqual({ ok: false, reason: "catalog" });
    expect(validateBlock(" ".repeat(LIMITS.blockBytes + 1))).toEqual({ ok: false, reason: "too_large" });
    const many = Object.fromEntries(Array.from({ length: LIMITS.elements + 1 }, (_, i) => [`e${i}`, { type: "Divider", props: {} }]));
    expect(validateSpec({ root: "e0", elements: many })).toEqual({ ok: false, reason: "too_many" });
    expect(validateSpec({ root: "x", elements: { r: { type: "Divider", props: {} } } })).toEqual({ ok: false, reason: "root" });
    // depth 10 chain: elements below depth 8 are cut
    const chain = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, { type: "Stack", props: {}, children: i < 9 ? [`s${i + 1}`] : [] }]));
    const v = validateSpec({ root: "s0", elements: chain });
    expect(v.ok && Object.keys(v.spec.elements).length).toBe(LIMITS.depth);
    // cycles terminate
    expect(
      validateSpec({ root: "a", elements: { a: { type: "Stack", props: {}, children: ["b"] }, b: { type: "Stack", props: {}, children: ["a"] } } }).ok,
    ).toBe(true);
  });

  it("rejects $state/$computed expressions, URLs-as-props and non-catalog fields", () => {
    const v = validateSpec({ root: "t", elements: { t: { type: "Text", props: { text: { $state: "/secret" } } } } });
    expect(v.ok).toBe(false);
    const w = validateSpec({ root: "t", elements: { t: { type: "Text", props: { text: "x" }, on: { press: { action: "x" } }, visible: true } } });
    expect(w.ok && w.spec.elements.t).toEqual({ type: "Text", props: { text: "x" } });
  });

  it("canonical JSON is key-order independent; refs are collected", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    const v = validateBlock(fixture("overdue-triage.json"));
    expect(v.ok && specRefs(v.spec).sort()).toEqual(["todo:gt-1", "todo:gt-2", "todo:gt-3"]);
  });
});

describe("fenced block parser", () => {
  const block = fixture("overdue-triage.json").replace(/\n\s*/g, "");
  const text = `Here's a pass.\n\`\`\`jarvis-ui\n${block}\n\`\`\`\nApply when ready.`;

  it("splits text and blocks; summary text never shows JSON", () => {
    const segs = splitBlocks(text);
    expect(segs.map((s) => s.kind)).toEqual(["text", "block", "text"]);
    expect(summaryText(text)).toBe("Here's a pass.\n\nApply when ready.\n\n_Structured reply (open in Jarvis)_");
  });

  it("never throws on a stream cut at any byte; open blocks are reported unclosed", () => {
    for (let i = 0; i <= text.length; i++) {
      const segs = splitBlocks(text.slice(0, i));
      for (const s of segs) if (s.kind === "block" && !s.closed) expect(s.raw.length).toBeLessThanOrEqual(block.length + 4);
    }
    const cut = splitBlocks(text.slice(0, text.indexOf("Apply") - 5));
    expect(cut.find((s) => s.kind === "block")).toMatchObject({ closed: false });
  });

  it("caps blocks per message", () => {
    const many = Array.from({ length: 5 }, () => "```jarvis-ui\n{}\n```").join("\n");
    expect(splitBlocks(many).filter((s) => s.kind === "block")).toHaveLength(LIMITS.blocksPerMessage);
  });
});

describe("intent allowlist and binding", () => {
  const v = validateBlock(fixture("overdue-triage.json"));
  if (!v.ok) throw new Error("fixture");
  const spec = v.spec;

  it("accepts offered intents within bounds", () => {
    const ok: Intent[] = [
      { kind: "todo.snooze", ref: "todo:gt-1", date: "2026-10-30" },
      { kind: "todo.complete", ref: "todo:gt-2" },
      { kind: "todo.snooze", ref: "todo:gt-2", date: "2026-11-06" },
      { kind: "todo.drop", ref: "todo:gt-3", note: "No longer relevant" },
    ];
    for (const i of ok) expect(intentInSpec(spec, i, TODAY), JSON.stringify(i)).toBe(true);
  });

  it("refuses intents the surface never offered, out-of-window dates and foreign refs", () => {
    const bad: Intent[] = [
      { kind: "todo.snooze", ref: "todo:gt-1", date: "2026-10-01" },
      { kind: "todo.snooze", ref: "todo:gt-1", date: "2028-01-01" },
      { kind: "todo.complete", ref: "todo:not-in-spec" },
      { kind: "todo.promote", ref: "todo:gt-1", parentRef: "item:x" },
      { kind: "item.update", ref: "item:x", patch: { status: "abandoned" } },
      { kind: "item.create", parentRef: "item:x", title: "Sneaky" },
    ];
    for (const i of bad) expect(intentInSpec(spec, i, TODAY), JSON.stringify(i)).toBe(false);
  });

  it("can never express settle, delete or merge", async () => {
    const { intentSchema } = await import("@/lib/jarvis-ui/intents");
    expect(intentSchema.safeParse({ kind: "item.update", ref: "item:x", patch: { status: "settled" } }).success).toBe(false);
    expect(intentSchema.safeParse({ kind: "item.update", ref: "item:x", patch: { status: "ready_to_settle" } }).success).toBe(false);
    expect(intentSchema.safeParse({ kind: "todo.delete", ref: "todo:x" }).success).toBe(false);
    expect(intentSchema.safeParse({ kind: "pr.merge", ref: "pr:x" }).success).toBe(false);
  });

  it("decision options bind exactly, and date bounds apply to them too", () => {
    const past = validateSpec({
      root: "d",
      elements: {
        d: {
          type: "DecisionCard",
          props: {
            title: "When",
            options: [
              { id: "a", label: "Past", intent: { kind: "todo.snooze", ref: "todo:x", date: "2020-01-01" } },
              { id: "b", label: "Far", intent: { kind: "todo.snooze", ref: "todo:x", date: "2030-01-01" } },
            ],
          },
        },
      },
    });
    if (!past.ok) throw new Error("spec");
    expect(intentInSpec(past.spec, { kind: "todo.snooze", ref: "todo:x", date: "2020-01-01" }, TODAY)).toBe(false);
    expect(intentInSpec(past.spec, { kind: "todo.snooze", ref: "todo:x", date: "2030-01-01" }, TODAY)).toBe(false);
    const d = validateBlock(fixture("decision-checklist-gauge.json"));
    if (!d.ok) throw new Error("fixture");
    expect(intentInSpec(d.spec, { kind: "item.update", ref: "item:ITEM", patch: { nextAction: "Patch the V4 grader push rule" } }, TODAY)).toBe(true);
    expect(intentInSpec(d.spec, { kind: "item.update", ref: "item:ITEM", patch: { nextAction: "Something else" } }, TODAY)).toBe(false);
  });

  it("row actions build the right intents and read plainly", () => {
    const list = spec.elements.week!.props as never;
    const row = (spec.elements.week!.props as { rows: never[] }).rows[0]!;
    expect(rowIntent(list, row, "week", TODAY)).toEqual({ kind: "todo.snooze", ref: "todo:gt-1", date: thisWeekDate(TODAY) });
    expect(thisWeekDate("2026-10-27")).toBe("2026-10-30");
    expect(thisWeekDate("2026-10-31")).toBe("2026-10-31");
    expect(describeIntent({ kind: "todo.drop", ref: "todo:gt-1" }, () => "Return ladder")).toBe("Drop “Return ladder” (marked done with a dropped note)");
  });
});

describe("prompt + overdue context", () => {
  it("catalog prompt names every component and stays ≤ 2.5 KB", () => {
    const p = smartInstructions();
    for (const n of COMPONENT_NAMES) expect(p).toContain(n);
    expect(p.length).toBeLessThanOrEqual(2560);
    expect(p).toMatchSnapshot();
  });

  it("lists every overdue todo up to 100 and shortens titles before dropping rows", () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({ ref: `todo:t${i}`, title: `Task number ${i} `.repeat(6), due: "2026-10-01", source: "Todos" }));
    const text = formatOverdue(rows);
    expect(text.split("\n")).toHaveLength(33);
    expect(text).not.toMatch(/more not shown|…and/);
    const big = Array.from({ length: 150 }, (_, i) => ({ ref: `todo:t${i}`, title: "x".repeat(200), due: "2026-10-01", source: "Todos" }));
    const t2 = formatOverdue(big);
    expect(t2.length).toBeLessThanOrEqual(8000);
    expect(t2).toContain("150 total, first 100");
  });

  it("the triage assist attaches @ctx:overdue_todos instead of a truncated list", () => {
    const overdue = Array.from(
      { length: 32 },
      (_, i) =>
        ({
          id: `todos:t${i}`,
          source: "todos",
          sourceId: `t${i}`,
          title: `Task ${i}`,
          dueAt: "2026-10-01T05:00:00.000Z",
          status: "open",
          secondaryActions: ["snooze"],
        }) as unknown as NextAction,
    );
    const [card] = buildAssists({
      now: new Date("2026-10-27T15:00:00Z"),
      timezone: "America/Chicago",
      overdue,
      events: [],
      milestones: [],
      canChat: true,
      canReschedule: true,
    });
    expect(card!.chat!.context).toBe("@ctx:overdue_todos");
    expect(card!.chat!.context).not.toMatch(/more/);
  });
});
