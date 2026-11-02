import { describe, expect, it } from "vitest";
import teaching from "@/lib/workflows/fixtures/teaching-notes.json";
import { validateDefinition, type WorkflowDefinition } from "@/lib/workflows/definition";
import {
  driveFolder,
  editSessionOps,
  editableMidFields,
  filterHistory,
  filterOptions,
  historyRow,
  markdownFileName,
  promotePlan,
  reminderDue,
  reminderFromDefinition,
  runMarkdown,
  runStats,
} from "@/lib/workflows/outputs";

const r = validateDefinition(teaching);
if (!r.ok) throw new Error(JSON.stringify(r.issues));
const def: WorkflowDefinition = r.definition;

const capture = {
  session: { speaker: { name: "Jake Fry" }, place: { label: "Heartland Sun Prairie", kind: "saved" }, when: "2026-11-01T09:00", series: "Abide" },
  scripture: [{ ref: { book: "John", chapter: 15, verseStart: 1, verseEnd: 8, display: "John 15:1–8" } }],
  points: [{ text: "Remain in the vine" }],
  quotes: [{ text: "Fruit is the overflow.", who: "Jake Fry" }],
  reflections: ["Stay put when it's dry"],
  actions: [{ text: "Call Sam" }, { text: "Read John 16" }, { text: "" }],
};

describe("runMarkdown", () => {
  it("renders session facts, accepted summary and lists without inventing content", () => {
    const md = runMarkdown(def, {
      title: "Session: Heartland Sun Prairie – Jake Fry",
      startedAt: "2026-11-01T15:00:00Z",
      capture,
      summary: "Abide in Christ.",
    });
    expect(md).toContain("# Session: Heartland Sun Prairie – Jake Fry");
    expect(md).toContain("- **Speaker:** Jake Fry");
    expect(md).toContain("## Summary\n\nAbide in Christ.");
    expect(md).toContain("- John 15:1–8");
    expect(md).toContain("> Fruit is the overflow. — Jake Fry");
    expect(md).toContain("## Actions\n\n- Call Sam");
    expect(md).not.toContain("undefined");
    expect(markdownFileName(def, "2026-11-01T15:00:00Z")).toBe("teaching-2026-11-01.md");
  });
  it("omits the summary until one is accepted", () => {
    expect(runMarkdown(def, { title: "x", startedAt: "2026-11-01", capture })).not.toContain("## Summary");
  });
  it("resolves the Drive folder year only when the definition declares one", () => {
    const withDrive = { ...def, outputs: { exports: [{ kind: "drive" as const, folder: "Teaching notes/{yyyy}" }] } };
    expect(driveFolder(withDrive, "2026-11-01")).toBe("Teaching notes/2026");
    expect(driveFolder({ ...def, outputs: {} }, "2026-11-01")).toBeNull();
  });
});

describe("promotePlan", () => {
  it("lists exact titles, skips blanks/duplicates/out-of-range and caps at 20", () => {
    const plan = promotePlan(def, capture, [1, 0, 1, 2, 9, -1], { parent: "Faith / Follow-ups", due: "2026-11-08" });
    expect(plan.map((p) => p.title)).toEqual(["Read John 16", "Call Sam"]);
    expect(plan[0]).toMatchObject({ index: 1, parent: "Faith / Follow-ups", due: "2026-11-08" });
    const many = { actions: Array.from({ length: 30 }, (_, i) => ({ text: `a${i}` })) };
    expect(promotePlan(def, many, [...Array(30).keys()], { parent: "", due: null })).toHaveLength(20);
  });
});

describe("history + stats", () => {
  const runs = [
    { id: "1", title: "a", status: "ended", startedAt: "2026-11-01T15:00:00Z", conversationId: "c1", capture },
    {
      id: "2",
      title: "b",
      status: "ended",
      startedAt: "2026-10-04T15:00:00Z",
      conversationId: null,
      capture: { session: { speaker: { name: "Ann Lyle" }, place: { label: "Heartland Sun Prairie" }, when: "2026-10-04T09:00" }, scripture: ["Ps 23"] },
    },
    {
      id: "3",
      title: "c",
      status: "ended",
      startedAt: "2026-10-11T15:00:00Z",
      conversationId: null,
      capture: { session: { speaker: { name: "Jake Fry" } }, scripture: [{ ref: "Jn 1" }] },
    },
  ].map((x) => historyRow(def, x));
  it("builds rows with counts and books (parses plain refs)", () => {
    expect(runs[0]).toMatchObject({
      date: "2026-11-01",
      speaker: "Jake Fry",
      place: "Heartland Sun Prairie",
      series: "Abide",
      scripture: "John 15:1–8",
      books: ["John"],
    });
    expect(runs[0].counts).toMatchObject({ points: 1, quotes: 1, actions: 3 });
    expect(runs[1].books).toEqual(["Psalms"]);
  });
  it("filters by speaker/place/series/book and lists options by frequency", () => {
    expect(filterHistory(runs, { speaker: "Jake Fry" }).map((r) => r.id)).toEqual(["1", "3"]);
    expect(filterHistory(runs, { book: "John", series: "Abide" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterOptions(runs).speaker).toEqual(["Jake Fry", "Ann Lyle"]);
  });
  it("counts sessions per month (zero-filled, oldest first) and top books/speakers", () => {
    const s = runStats(runs, "2026-11-02", 3);
    expect(s.perMonth).toEqual([
      { month: "2026-09", count: 0 },
      { month: "2026-10", count: 2 },
      { month: "2026-11", count: 1 },
    ]);
    expect(s.topSpeakers[0]).toEqual({ label: "Jake Fry", count: 2 });
    expect(s.topBooks[0]).toEqual({ label: "John", count: 2 });
    expect(Object.keys(s)).not.toContain("streak");
  });
});

describe("editSessionOps (#132)", () => {
  it("only offers scalar mid fields and emits REPLACE ops for changes", () => {
    expect(editableMidFields(def).map((f) => f.id)).toEqual(["speaker", "place", "when", "series"]);
    const ops = editSessionOps(def, capture, { speaker: "Ann Lyle", series: "Abide", when: "2026-11-01T09:00" });
    expect(ops).toEqual([{ op: "replace", path: "/session/speaker", value: { name: "Ann Lyle" } }]);
    expect(ops.every((o) => o.op === "replace")).toBe(true);
  });
});

describe("reminder schedule (D6)", () => {
  const s = { enabled: true, day: 0, time: "09:45" };
  it("reads the definition's remind trigger, default off", () => {
    const d = { ...def, triggers: [{ kind: "schedule" as const, cron: "45 9 * * 0", action: "remind" as const }] };
    expect(reminderFromDefinition(d)).toEqual({ enabled: false, day: 0, time: "09:45" });
  });
  it("is due once per Sunday in the hour after 09:45, never early or when off", () => {
    expect(reminderDue(s, { date: "2026-11-08", weekday: 0, minutes: 9 * 60 + 44 }, null)).toBe(false);
    expect(reminderDue(s, { date: "2026-11-08", weekday: 0, minutes: 9 * 60 + 46 }, null)).toBe(true);
    expect(reminderDue(s, { date: "2026-11-08", weekday: 0, minutes: 9 * 60 + 50 }, "2026-11-08")).toBe(false);
    expect(reminderDue(s, { date: "2026-11-09", weekday: 1, minutes: 9 * 60 + 50 }, null)).toBe(false);
    expect(reminderDue({ ...s, enabled: false }, { date: "2026-11-08", weekday: 0, minutes: 590 }, null)).toBe(false);
  });
});
