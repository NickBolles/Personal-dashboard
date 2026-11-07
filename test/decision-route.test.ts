import { expect, it } from "vitest";
import { validDecisionId, decisionHref, decodeDecisionId } from "@/lib/decision-route";
it("routes the stable decision key rather than a chat or approval request id", () => {
  for (const id of ["item:wk_0123-ab", "approval:run_1", "workflow:wf_2", "stalled:ar_3"]) expect(validDecisionId(id)).toBe(true);
  expect(decisionHref({ key: "item:wk_0123-ab" })).toBe("/decisions/item%3Awk_0123-ab");
});
it("strictly rejects malformed and oversized route params", () => {
  for (const id of [
    "",
    "wk_one",
    "item:",
    "item:../one",
    "approval:a/b",
    "item:a:b",
    "item:a b",
    "item:a%2Fb",
    "ITEM:one",
    "item:a\n",
    `item:${"a".repeat(129)}`,
  ])
    expect(validDecisionId(id), id).toBe(false);
});
it("decodes a still-encoded route segment before validating it", () => {
  expect(decodeDecisionId("item%3Awk_0123-ab")).toBe("item:wk_0123-ab");
  expect(validDecisionId(decodeDecisionId("item%3Awk_0123-ab"))).toBe(true);
  expect(validDecisionId(decodeDecisionId("item%3Aa%2Fb"))).toBe(false);
  expect(decodeDecisionId("item%E0%A4%A")).toBe("item%E0%A4%A");
});
