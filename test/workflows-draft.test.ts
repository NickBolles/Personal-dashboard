import { describe, expect, it } from "vitest";
import { validateProposal, type WorkflowProposal } from "@/lib/workflows/proposal";

const proposal: WorkflowProposal = {
  basics: { name: "Lantern study notes", slug: "lantern", icon: "book-open", description: "Notes", area: null },
  instructions: "Keep each passage separate.",
  capture: { session: { type: "object", fields: { leader: "text?" } }, takeaways: { type: "list", of: "text" } },
  startForm: { title: "Start", fields: [{ id: "leader", bind: "session.leader", type: "person", label: "Leader" }] },
};
const all = { basics: "accept", instructions: "accept", capture: "accept", startForm: "accept" } as const;

describe("save chat as workflow review", () => {
  it("the mock Hermes proposal is valid as-is", () => {
    const mock: WorkflowProposal = {
      basics: { name: "Lantern study notes x1", slug: "desx1", icon: "book-open", description: "Notes from the lantern study group", area: null },
      instructions: "Keep each passage, the questions we asked, and my own takeaways separate. Use my words.",
      capture: { session: { type: "object", fields: { leader: "text?", passage: "scripture_ref?" } }, takeaways: { type: "list", of: "text" } },
      startForm: {
        title: "Start lantern study",
        fields: [
          { id: "leader", bind: "session.leader", type: "person", label: "Leader" },
          { id: "passage", bind: "session.passage", type: "scripture", label: "Passage" },
        ],
      },
      rationale: "You repeat the same three-part structure every week.",
    };
    const r = validateProposal(mock, all);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });
  it("keeping every part yields a valid draft", () => {
    const r = validateProposal(proposal, all);
    expect(r.ok).toBe(true);
  });
  it("dropping capture flags the start form inline (bound to a missing path)", () => {
    const r = validateProposal(proposal, { ...all, capture: "drop" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.part === "startForm" || i.part === "capture")).toBe(true);
  });
  it("dropping the start form is fine", () => {
    expect(validateProposal(proposal, { ...all, startForm: "drop" }).ok).toBe(true);
  });
});
