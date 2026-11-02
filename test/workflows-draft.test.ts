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
