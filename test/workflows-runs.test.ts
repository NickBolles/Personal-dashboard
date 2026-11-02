import { describe, expect, it } from "vitest";
import teaching from "@/lib/workflows/fixtures/teaching-notes.json";
import { validateDefinition, type WorkflowDefinition } from "@/lib/workflows/definition";
import { mapPaletteArgs } from "@/lib/workflows/palette-args";
import {
  applyOps,
  emptyCapture,
  extractCaptureBlocks,
  hideCaptureBlocks,
  formToOps,
  matchSavedPlace,
  renderTemplate,
  resolveFormDefaults,
  splitProposals,
  undoEntries,
  validateForm,
  validateOps,
} from "@/lib/workflows/runs";

const r = validateDefinition(teaching);
if (!r.ok) throw new Error("fixture invalid");
const def: WorkflowDefinition = r.definition;
const TZ = "America/Chicago";
// Sunday Nov 1 2026, 08:30 CST (14:30Z)
const sundayMorning = new Date("2026-11-01T14:30:00Z");
// Wednesday Nov 4 2026, 12:00 CST
const wednesday = new Date("2026-11-04T18:00:00Z");
let seq = 0;
const meta = (by: "user" | "agent" = "agent") => ({ by, at: "2026-11-01T15:00:00Z", id: () => `e${seq++}` });

describe("start form defaults", () => {
  it("resolves service time (D12), workflow place and empty last-values", () => {
    const v = resolveFormDefaults(def, "start", { now: sundayMorning, timezone: TZ });
    expect(v.when).toMatchObject({ value: "2026-11-01T09:00", provenance: "smart" });
    expect(v.place).toMatchObject({ value: { label: "Heartland Sun Prairie", kind: "saved" }, provenance: "workflowPlace" });
    expect(v.speaker.provenance).toBe("none");
  });
  it("mid-week picks next Sunday's first service", () => {
    expect(resolveFormDefaults(def, "start", { now: wednesday, timezone: TZ }).when.value).toBe("2026-11-08T09:00");
  });
  it("uses remembered values (D11) and lets palette args win", () => {
    const remembered = { speaker: [{ name: "Jake Fry" }], series: ["Abide"] };
    const v = resolveFormDefaults(def, "start", { now: wednesday, timezone: TZ, remembered });
    expect(v.speaker).toMatchObject({ value: { name: "Jake Fry" }, provenance: "last" });
    expect(v.series.value).toBe("Abide");
    const prefill = mapPaletteArgs(def, "Ann Lee John 15", { now: wednesday, timezone: TZ }).values;
    const p = resolveFormDefaults(def, "start", { now: wednesday, timezone: TZ, remembered, prefill });
    expect(p.speaker).toMatchObject({ value: { name: "Ann Lee" }, provenance: "palette", note: "From /teaching" });
    expect((p.ref.value as { display: string }).display).toBe("John 15");
  });
  it("validates required fields and scripture", () => {
    const errs = validateForm(def, "start", { speaker: null, place: { label: "X" }, when: "2026-11-01T09:00", ref: "Hezekiah 3" });
    expect(errs.map((e) => e.field).sort()).toEqual(["ref", "speaker"]);
  });
  it("turns a form into capture ops + title", () => {
    const ops = formToOps(def, "start", {
      speaker: "Jake Fry",
      place: { label: "Heartland Sun Prairie", kind: "saved" },
      when: "2026-11-01T09:00",
      ref: "Jn 15 1-8",
    });
    const { capture } = applyOps(def, emptyCapture(def), validateOps(def, emptyCapture(def), ops).ops, meta("user"));
    expect((capture.scripture as { ref: { display: string } }[])[0].ref.display).toBe("John 15:1–8");
    expect(renderTemplate(def.start!.prompt!, capture)).toBe("Session: Heartland Sun Prairie – Jake Fry");
  });
});

describe("place matching (on device, saved places only)", () => {
  const places = [
    { id: "a", label: "Heartland Sun Prairie", lat: 43.1836, lng: -89.2137, radiusM: 300 },
    { id: "b", label: "Home", lat: 43.07, lng: -89.4, radiusM: 300 },
    { id: "c", label: "No coords", lat: null, lng: null, radiusM: 300 },
  ];
  it("matches the nearest saved place within its radius", () => {
    const m = matchSavedPlace({ lat: 43.1845, lng: -89.2137 }, places);
    expect(m?.place.id).toBe("a");
    expect(m!.distanceM).toBeLessThan(150);
  });
  it("returns null when nothing is near", () => {
    expect(matchSavedPlace({ lat: 44, lng: -88 }, places)).toBeNull();
  });
});

describe("jarvis-capture proposals", () => {
  it("accepts declared paths and drops everything else", () => {
    const v = validateOps(def, emptyCapture(def), [
      { op: "add", path: "/quotes/-", value: { text: "Remain in me", who: "Jesus" } },
      { op: "add", path: "/scripture/-", value: { ref: "John 15:5" } },
      { op: "replace", path: "/session/series", value: "Abide" },
      { op: "add", path: "/secrets/-", value: "x" },
      { op: "add", path: "/quotes/-", value: { text: "x", evil: 1 } },
      { op: "move", path: "/quotes/0" },
      { op: "replace", path: "/session/place", value: { label: "X", lat: 1, lng: 2 } },
      { op: "remove", path: "/points/3" },
    ]);
    expect(v.ops).toHaveLength(3);
    expect(v.dropped.map((d) => d.reason)).toEqual(["undeclared_path", "unknown_field", "bad_op", "wrong_type", "out_of_range"]);
  });
  it("extracts fenced blocks and splits form proposals", () => {
    const text =
      'Noted.\n```jarvis-capture\n{"propose":true,"ops":[{"op":"replace","path":"/session/speaker","value":"Jake Fry"},{"op":"add","path":"/points/-","value":{"text":"Abide"}}]}\n```\n```jarvis-capture\nnot json\n```';
    const x = extractCaptureBlocks(text);
    expect(x).toMatchObject({ propose: true, errors: 1 });
    const v = validateOps(def, emptyCapture(def), x.ops);
    const s = splitProposals(def, v.ops, x.propose);
    expect(s.apply.map((o) => o.path)).toEqual(["/points/-"]);
    expect(s.proposed.map((o) => o.path)).toEqual(["/session/speaker"]);
  });
});

describe("undo", () => {
  it("undoes each change, newest first", () => {
    let c = emptyCapture(def);
    const a = applyOps(def, c, validateOps(def, c, [{ op: "replace", path: "/session/series", value: "Abide" }]).ops, meta());
    c = a.capture;
    const b = applyOps(
      def,
      c,
      validateOps(def, c, [
        { op: "add", path: "/points/-", value: { text: "One" } },
        { op: "add", path: "/points/-", value: { text: "Two" } },
      ]).ops,
      meta(),
    );
    c = b.capture;
    const log = [...a.entries, ...b.entries];
    // undoing the older point while the newer one is live is refused (index would shift)
    const blocked = undoEntries(def, c, log, [b.entries[0].id]);
    expect(blocked.failed).toEqual([b.entries[0].id]);
    const u = undoEntries(def, c, log, [b.entries[1].id, b.entries[0].id]);
    expect(u.capture.points).toEqual([]);
    const u2 = undoEntries(def, u.capture, u.log, [a.entries[0].id]);
    expect((u2.capture.session as Record<string, unknown>).series).toBeUndefined();
    expect(u2.log.every((e) => e.undone)).toBe(true);
  });
});

describe("hideCaptureBlocks", () => {
  it("removes closed and still-streaming capture fences, keeps other text and code", () => {
    const op = '[{"op":"add","path":"/quotes/-","value":"x"}]';
    expect(hideCaptureBlocks("Got it.\n\n```jarvis-capture\n" + op + "\n```\n")).toBe("Got it.");
    expect(hideCaptureBlocks('Saved.\n```jarvis-capture\n[{"op"')).toBe("Saved.");
    expect(hideCaptureBlocks("```ts\nconst a = 1;\n```")).toBe("```ts\nconst a = 1;\n```");
  });
});
