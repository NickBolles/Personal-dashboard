import { expect, it } from "vitest";
import { validDecisionId, decisionHref } from "@/lib/decision-route";
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
