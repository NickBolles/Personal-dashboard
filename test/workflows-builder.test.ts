import { describe, expect, it } from "vitest";
import fixture from "@/lib/workflows/fixtures/teaching-notes.json";
import { validateDefinition, type WorkflowDefinition } from "@/lib/workflows/definition";
import { blankDefinition, builderReducer, definingSlot, initBuilder, issuesBySection, sourceOfDefault, tokenCount } from "@/lib/workflows/builder";
import { remembers, resolveFormDefaults } from "@/lib/workflows/runs";
import { diffDefinitions, restoreDefinition, summarizeDiff } from "@/lib/workflows/versions";
import { applyProposal, refuseFinanceChat, validateProposal } from "@/lib/workflows/proposal";

const teaching = fixture as unknown as WorkflowDefinition;

describe("builder reducer", () => {
  it("starts from a blank definition that passes the validator", () => {
    expect(validateDefinition(blankDefinition()).ok).toBe(true);
  });

  it("adds a form field with an auto capture slot, keeps it valid, and undoes", () => {
    let s = initBuilder();
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "person" });
    expect(s.dirty).toBe(true);
    expect(s.selectedField).toBe("person");
    const r = validateDefinition(s.draft);
    expect(r.ok).toBe(true);
    expect(s.draft.capture.session).toEqual({ type: "object", fields: { person: "person?" } });
    s = builderReducer(s, { type: "undo" });
    expect(s.draft.forms).toBeUndefined();
  });

  it("sets per-field settings and default sources (literal | smart | last)", () => {
    let s = initBuilder();
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "date" });
    s = builderReducer(s, { type: "fieldUpdate", slot: "start", id: "date", patch: { label: "Service date", required: true, help: "Sunday by default" } });
    s = builderReducer(s, { type: "fieldDefault", slot: "start", id: "date", source: { kind: "smart", source: "$nextSunday" } });
    const f = s.draft.forms!.start!.fields[0] as Exclude<(typeof s.draft.forms & object)["start"], undefined>["fields"][number] & object;
    expect(typeof f).toBe("object");
    if (typeof f === "string") throw new Error("expected field");
    expect(f).toMatchObject({ label: "Service date", required: true, default: { source: "$nextSunday" } });
    expect(sourceOfDefault(f.default)).toEqual({ kind: "smart", source: "$nextSunday" });
    s = builderReducer(s, { type: "fieldDefault", slot: "start", id: "date", source: { kind: "last" } });
    const g = s.draft.forms!.start!.fields[0];
    if (typeof g === "string") throw new Error("expected field");
    expect(g.rememberLast).toBe(true);
    expect(validateDefinition(s.draft).ok).toBe(true);
  });

  it("removing a field drops palette args and string refs to it", () => {
    let s = initBuilder();
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "text" });
    s = builderReducer(s, { type: "argsSet", ids: ["text"] });
    expect(validateDefinition(s.draft).ok).toBe(true);
    s = builderReducer(s, { type: "fieldRemove", slot: "start", id: "text" });
    expect(s.draft.start?.args).toEqual([]);
    expect(validateDefinition(s.draft).ok).toBe(true);
  });

  it("moves fields and keeps the palette trigger in step with the slug", () => {
    let s = initBuilder({ ...blankDefinition(), triggers: [{ kind: "palette", command: "/new-workflow" }] });
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "text" });
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "place" });
    s = builderReducer(s, { type: "fieldMove", slot: "start", id: "place", delta: -1 });
    expect(s.draft.forms!.start!.fields.map((f) => (typeof f === "string" ? f : f.id))).toEqual(["place", "text"]);
    s = builderReducer(s, { type: "basics", patch: { slug: "sermons", name: "Sermons" } });
    expect(s.draft.triggers).toEqual([{ kind: "palette", command: "/sermons" }]);
    expect(validateDefinition(s.draft).ok).toBe(true);
  });

  it("groups validator issues by builder section", () => {
    const bad = { ...blankDefinition(), instructions: "", routing: { area: "Finance", agentProfile: null, modelTier: "fast" as const } };
    const by = issuesBySection(bad);
    expect(by.instructions.length + by.basics.length).toBeGreaterThan(0);
    const fin = issuesBySection({ ...blankDefinition(), routing: { area: "Finance/Budget", agentProfile: null, modelTier: "fast" } });
    expect(fin.basics.map((i) => i.code)).toContain("finance_excluded");
  });

  it("counts instruction tokens", () => {
    expect(tokenCount("")).toBe(0);
    expect(tokenCount("Keep Scripture, points and reflections distinct.")).toBeGreaterThan(5);
  });
});

describe("version diff + restore", () => {
  it("diffs instructions and form fields by id", () => {
    const v2: WorkflowDefinition = JSON.parse(JSON.stringify(teaching));
    v2.instructions = "Shorter.";
    const changes = diffDefinitions(teaching, v2);
    expect(changes).toEqual([{ path: "instructions", kind: "changed", before: teaching.instructions, after: "Shorter." }]);
    expect(summarizeDiff(changes)).toBe("1 change: instructions");
    expect(diffDefinitions(teaching, teaching)).toEqual([]);
  });

  it("reports added/removed fields by id rather than by index", () => {
    let s = initBuilder();
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "text" });
    const a = s.draft;
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "date" });
    const kinds = diffDefinitions(a, s.draft).map((c) => `${c.kind}:${c.path}`);
    expect(kinds).toContain("added:forms.start.fields[date]");
    expect(kinds).toContain("added:capture.session.fields.date");
  });

  it("restore keeps the locked slug and validates", () => {
    const old = { ...teaching, slug: "old-slug", triggers: [{ kind: "palette" as const, command: "/old-slug" }] };
    const r = restoreDefinition(old, teaching);
    expect(r.slug).toBe(teaching.slug);
    expect(r.triggers).toEqual([{ kind: "palette", command: `/${teaching.slug}` }]);
  });
});

describe("AI proposals", () => {
  const proposal = {
    basics: { name: "Teaching notes", slug: "teachnotes", icon: "book-open", area: null },
    instructions: "Keep Scripture, teaching points, and my reflections distinct without adding outside commentary.",
    capture: { session: { type: "object", fields: { speaker: "text?" } }, points: { type: "list", of: "text" } },
    startForm: { fields: [{ id: "speaker", bind: "session.speaker", type: "person", label: "Speaker" }] },
  };

  it("assembles only accepted parts and passes the validator", () => {
    const r = validateProposal(proposal, { basics: "accept", instructions: "accept", capture: "accept", startForm: "accept" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.definition.slug).toBe("teachnotes");
    const partial = applyProposal(proposal, { instructions: "accept" });
    expect(partial.slug).toBe(blankDefinition().slug);
    expect(partial.forms).toBeUndefined();
  });

  it("flags the offending part when the draft is invalid", () => {
    const r = validateProposal(proposal, { basics: "accept", startForm: "accept" }); // form binds a capture path that was dropped
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.part === "startForm" && i.code === "bind_unknown_path")).toBe(true);
    const shape = validateProposal({ ...proposal, code: "alert(1)" }, {});
    expect(shape.ok).toBe(false);
    const html = validateProposal({ ...proposal, basics: { ...proposal.basics, name: "<b>x</b>" } }, { basics: "accept" });
    expect(html.ok).toBe(false);
  });

  it("never drafts into Finance", () => {
    const r = validateProposal(
      { ...proposal, basics: { ...proposal.basics, area: "Finance" } },
      { basics: "accept", instructions: "accept", capture: "accept", startForm: "accept" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("finance_excluded");
  });

  it("refuses Finance chats before any transcript is sent", () => {
    expect(refuseFinanceChat({ areaPath: "Finance/Budget" }).refused).toBe(true);
    expect(refuseFinanceChat({ areaPath: "Finance › Bills" }).refused).toBe(true);
    expect(refuseFinanceChat({ areaPath: "Health › Private", excludedAreas: ["Health"] }).refused).toBe(true);
    expect(refuseFinanceChat({ areaPath: "Miscellaneous", refs: [{ type: "finance", id: "acct_1", label: "Checking" }] }).refused).toBe(true);
    expect(refuseFinanceChat({ areaPath: "Miscellaneous", title: "Teaching notes." }).refused).toBe(false);
  });
});

describe("builder follow-ups (#138, #139, #140)", () => {
  const field = (d: WorkflowDefinition, slot: "start" | "mid" | "end", id: string) => {
    const f = d.forms?.[slot]?.fields.find((x) => typeof x !== "string" && x.id === id);
    if (!f || typeof f === "string") throw new Error(`no ${id} in ${slot}`);
    return f;
  };

  it("edits a referenced Mid-run field in the form that defines it (#138)", () => {
    let s = initBuilder(JSON.parse(JSON.stringify(teaching)) as WorkflowDefinition, 1);
    expect(definingSlot(s.draft, "mid", "speaker")).toBe("start");
    s = builderReducer(s, { type: "fieldUpdate", slot: "mid", id: "speaker", patch: { label: "Preacher" } });
    expect(field(s.draft, "start", "speaker").label).toBe("Preacher");
    expect(s.draft.forms?.mid?.fields).toContain("speaker");
    s = builderReducer(s, { type: "fieldDefault", slot: "mid", id: "speaker", source: { kind: "literal", value: "Jake" } });
    expect(field(s.draft, "start", "speaker").default).toEqual({ value: "Jake" });
    expect(validateDefinition(s.draft).ok).toBe(true);
  });

  it("stores fixed number/toggle defaults with the field's type and normalises old string defaults (#139)", () => {
    let s = initBuilder();
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "number" });
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "toggle" });
    s = builderReducer(s, { type: "fieldDefault", slot: "start", id: "number", source: { kind: "literal", value: "4" } });
    s = builderReducer(s, { type: "fieldDefault", slot: "start", id: "toggle", source: { kind: "literal", value: "false" } });
    expect(field(s.draft, "start", "number").default).toEqual({ value: 4 });
    expect(field(s.draft, "start", "toggle").default).toEqual({ value: false });
    expect(sourceOfDefault(field(s.draft, "start", "toggle").default)).toEqual({ kind: "literal", value: "false" });
    expect(validateDefinition(s.draft).ok).toBe(true);
    // a definition saved before the fix still resolves to typed values
    const legacy = JSON.parse(JSON.stringify(s.draft)) as WorkflowDefinition;
    field(legacy, "start", "number").default = { value: "4" };
    field(legacy, "start", "toggle").default = { value: "false" };
    const v = resolveFormDefaults(legacy, "start", { now: new Date("2026-11-02T18:00:00Z"), timezone: "America/Chicago" });
    expect(v.number.value).toBe(4);
    expect(v.toggle.value).toBe(false);
  });

  it("unchecking Remember last value stores false so person/place/select stop remembering (#140)", () => {
    let s = initBuilder();
    s = builderReducer(s, { type: "fieldAdd", slot: "start", fieldType: "person" });
    expect(remembers(field(s.draft, "start", "person"))).toBe(true);
    s = builderReducer(s, { type: "fieldUpdate", slot: "start", id: "person", patch: { rememberLast: false } });
    expect(field(s.draft, "start", "person").rememberLast).toBe(false);
    expect(remembers(field(s.draft, "start", "person"))).toBe(false);
    expect(validateDefinition(s.draft).ok).toBe(true);
  });
});
