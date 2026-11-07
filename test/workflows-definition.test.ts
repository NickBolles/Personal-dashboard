import { describe, expect, it } from "vitest";
import { parseScriptureRef } from "@/lib/workflows/scripture";
import { resolveSmartDate, parseDateWord } from "@/lib/workflows/smart-dates";
import { canonicalDefinition, validateDefinition } from "@/lib/workflows/definition";
import { mapPaletteArgs, parseSlashCommand } from "@/lib/workflows/palette-args";
import teaching from "@/lib/workflows/fixtures/teaching-notes.json";

const TZ = "America/Chicago";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("parseScriptureRef", () => {
  const d = (s: string) => {
    const r = parseScriptureRef(s);
    return r.ok ? r.ref.display : `ERR:${r.error}`;
  };
  it("normalises common forms", () => {
    expect(d("John 15:5")).toBe("John 15:5");
    expect(d("Jn 15 5")).toBe("John 15:5");
    expect(d("jn15:5")).toBe("John 15:5");
    expect(d("John 15:1-8")).toBe("John 15:1–8");
    expect(d("John 15:1–8")).toBe("John 15:1–8");
    expect(d("John 15–16")).toBe("John 15–16");
    expect(d("John 15:26–16:4")).toBe("John 15:26–16:4");
    expect(d("Gal 5:22,23")).toBe("Galatians 5:22–23");
    expect(d("Ps 23")).toBe("Psalms 23");
    expect(d("1 Cor 13:4")).toBe("1 Corinthians 13:4");
    expect(d("1Co 13")).toBe("1 Corinthians 13");
    expect(d("I Corinthians 13")).toBe("1 Corinthians 13");
    expect(d("SoS 2:4")).toBe("Song of Songs 2:4");
    expect(d("Rev. 21:4")).toBe("Revelation 21:4");
    expect(d("Jude 3")).toBe("Jude 1:3");
  });
  it("checks chapter bounds and ranges", () => {
    const r = parseScriptureRef("John 22");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("John has 21 chapters");
    expect(d("John 15:8-1")).toBe("ERR:bad_range");
    expect(d("Ps 151")).toBe("ERR:chapter_out_of_range");
  });
  it("reports ambiguity instead of guessing", () => {
    const r = parseScriptureRef("Jo 3");
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === "ambiguous") expect(r.candidates).toEqual(expect.arrayContaining(["John", "Job", "Joel", "Jonah", "Joshua"]));
    else throw new Error("expected ambiguous");
  });
  it("rejects garbage", () => {
    expect(d("hello")).toBe("ERR:unparsed");
    expect(d("Hezekiah 3")).toBe("ERR:unknown_book");
    expect(d("")).toBe("ERR:unparsed");
  });
});

describe("smart dates", () => {
  // 2026-11-01 is a Sunday
  const at = (iso: string) => ({ now: new Date(iso), timezone: TZ, serviceTimes: ["09:00", "10:45"] });
  it("today / tomorrow / next Sunday in the owner tz", () => {
    expect(resolveSmartDate("$today", at("2026-11-02T04:30:00Z")).date).toBe("2026-11-01"); // 22:30 CT Sunday
    expect(resolveSmartDate("$tomorrow", at("2026-11-02T04:30:00Z")).date).toBe("2026-11-02");
    expect(resolveSmartDate("$nextSunday", at("2026-11-01T15:00:00Z")).date).toBe("2026-11-01"); // Sunday 09:00
    expect(resolveSmartDate("$nextSunday", at("2026-11-01T20:00:00Z")).date).toBe("2026-11-08"); // Sunday 14:00
    expect(resolveSmartDate("$nextSunday", at("2026-11-04T18:00:00Z")).date).toBe("2026-11-08"); // Wednesday
  });
  it("service time picks the nearby slot, else next Sunday's first", () => {
    expect(resolveSmartDate("$serviceTime", at("2026-11-01T16:30:00Z")).datetime).toBe("2026-11-01T10:45"); // 10:30
    expect(resolveSmartDate("$serviceTime", at("2026-11-01T14:40:00Z")).datetime).toBe("2026-11-01T09:00"); // 08:40
    expect(resolveSmartDate("$serviceTime", at("2026-11-01T22:00:00Z")).datetime).toBe("2026-11-08T09:00"); // 16:00
    expect(resolveSmartDate("$serviceTime", at("2026-11-05T18:00:00Z")).datetime).toBe("2026-11-08T09:00");
  });
  it("date words", () => {
    const o = { now: new Date("2026-11-04T18:00:00Z"), timezone: TZ };
    expect(parseDateWord("sunday", o)).toBe("2026-11-08");
    expect(parseDateWord("11/8", o)).toBe("2026-11-08");
    expect(parseDateWord("2/30", o)).toBeNull();
  });
});

describe("validateDefinition", () => {
  it("accepts the Teaching notes fixture", () => {
    const r = validateDefinition(teaching);
    expect(r.ok ? "ok" : JSON.stringify(r.issues)).toBe("ok");
  });
  it("rejects unknown binds, duplicate ids, bad refs", () => {
    const d = clone(teaching) as typeof teaching;
    d.forms.start.fields[0].bind = "session.nope";
    (d.forms.start.fields as unknown[]).push({ ...d.forms.start.fields[1] });
    d.forms.mid.fields.push("ghost");
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["bind_unknown_path", "duplicate_field", "unknown_field"]));
  });
  it("allows Finance; blocks AI-excluded paths, HTML, unknown keys, code and oversize", () => {
    const fin = clone(teaching);
    fin.routing.area = "Finance/Budget";
    expect(validateDefinition(fin).ok).toBe(true);
    const r = validateDefinition(fin, { excludedAreas: ["Finance"] });
    expect(!r.ok && r.issues[0].code).toBe("finance_excluded");
    const excluded = validateDefinition(teaching, { excludedAreas: ["faith"] });
    expect(!excluded.ok && excluded.issues[0].code).toBe("finance_excluded");
    expect(validateDefinition({ ...clone(teaching), name: "<script>x</script>" }).ok).toBe(false);
    expect(validateDefinition({ ...clone(teaching), onLoad: "fetch()" }).ok).toBe(false);
    expect(validateDefinition({ ...clone(teaching), instructions: "x".repeat(40000) }).ok).toBe(false);
    expect(validateDefinition({ ...clone(teaching), layout: { root: "a", elements: { a: { type: "Iframe", props: {} } } } }).ok).toBe(false);
    expect(validateDefinition({ ...clone(teaching), icon: "skull" }).ok).toBe(false);
  });
  it("round-trips through JSON export/import", () => {
    const r = validateDefinition(teaching);
    if (!r.ok) throw new Error("fixture invalid");
    const exported = JSON.stringify(r.definition);
    const back = validateDefinition(JSON.parse(exported));
    expect(back.ok && canonicalDefinition(back.definition)).toBe(canonicalDefinition(r.definition));
  });
});

describe("palette args", () => {
  const r = validateDefinition(teaching);
  if (!r.ok) throw new Error("fixture invalid");
  const def = r.definition;
  const opts = { now: new Date("2026-11-01T15:00:00Z"), timezone: TZ, savedPlaces: ["Heartland Sun Prairie"] };
  it("parses the slash command", () => {
    expect(parseSlashCommand("/teaching Jake Fry")).toEqual({ slug: "teaching", rest: "Jake Fry" });
    expect(parseSlashCommand("/Teaching")).toEqual({ slug: "teaching", rest: "" });
    expect(parseSlashCommand("teaching")).toBeNull();
  });
  it("maps free text to speaker", () => {
    expect(mapPaletteArgs(def, "Jake Fry", opts).values).toEqual({ speaker: { name: "Jake Fry" } });
  });
  it("typed matching: scripture, date, place, then speaker", () => {
    const v = mapPaletteArgs(def, "Heartland Sun Prairie today - Jake Fry John 15", opts).values;
    expect(v.speaker).toEqual({ name: "Jake Fry" });
    expect(v.place).toEqual({ label: "Heartland Sun Prairie", kind: "saved" });
    expect(v.when).toBe("2026-11-01");
    expect((v.ref as { display: string }).display).toBe("John 15");
  });
  it("empty args → nothing", () => {
    expect(mapPaletteArgs(def, "  ", opts)).toEqual({ values: {}, unmatched: "" });
  });
});
