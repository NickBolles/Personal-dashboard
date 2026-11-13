import { expect, it } from "vitest";
import { COMPONENTS } from "./catalog";
import { smartLabel } from "./labels";

it("a smart block's tag is never the component's internal name", () => {
  for (const name of Object.keys(COMPONENTS)) {
    const label = smartLabel(name);
    if (label === null) continue;
    // A human label is words, never a PascalCase identifier ("Checklist" and "Form" are already words).
    expect(label).not.toMatch(/[a-z][A-Z]/);
    if (/[a-z][A-Z]/.test(name)) expect(label).not.toBe(name);
  }
  expect(smartLabel("DecisionCard")).toBe("Choice");
  expect(smartLabel("DecisionMatrix")).toBe("Comparison");
  expect(smartLabel("ApprovalQueue")).toBe("Approvals");
});

it("an unknown component gets no tag rather than its raw name", () => {
  expect(smartLabel("SomethingNew")).toBeNull();
  expect(smartLabel(undefined)).toBeNull();
});
