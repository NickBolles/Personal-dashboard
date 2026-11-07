import { describe, expect, it } from "vitest";
import { financeSnapshot, sparklinePoints } from "@/lib/finance/snapshot";
import { financeSnapshotFixture } from "../mock-upstreams/finance-snapshot.mjs";

describe("read-only finance snapshot", () => {
  it("matches the deterministic visual fixture using observed balances, never planned totals", () => {
    const fixture = financeSnapshotFixture();
    expect(financeSnapshotFixture()).toEqual(fixture);
    expect(financeSnapshot(fixture.accounts, fixture.transactions, "2026-10-15")).toEqual(fixture.overview.snapshot);
  });
  it("does not invent zero balances or zero cash flow when records are missing", () => {
    expect(financeSnapshot([], [], "2026-10-15")).toEqual({ netWorth: null, accounts: 0, cashFlow: null });
    expect(financeSnapshot([{ id: "a", kind: "checking" }], [], "2026-10-15").netWorth).toBeNull();
  });
  it("excludes archived accounts, card legs, pending, superseded, ambiguous, future and out-of-month transactions", () => {
    const a = { id: "bank", kind: "checking" as const, balance: { balance: 10000 } };
    const t = { accountId: "bank", date: "2026-10-10", amount: 100, pending: false };
    const result = financeSnapshot(
      [a, { ...a, id: "archived", archived: true }, { ...a, id: "card", kind: "credit_card" }],
      [
        t,
        { ...t, amount: -100, date: "2026-10-11" },
        { ...t, accountId: "archived" },
        { ...t, accountId: "card" },
        { ...t, pending: true },
        { ...t, supersededBy: "posted" },
        { ...t, ambiguous: true },
        { ...t, date: "2026-10-16" },
        { ...t, date: "2026-09-30" },
      ],
      "2026-10-15",
    );
    expect(result.accounts).toBe(2);
    expect(result.netWorth).toBe(20000);
    expect(result.cashFlow).toEqual({
      net: 0,
      transactions: 2,
      points: [
        { date: "2026-10-10", value: 100 },
        { date: "2026-10-11", value: 0 },
      ],
    });
  });
  it("builds finite SVG geometry for empty, flat, negative and mixed series", () => {
    expect(sparklinePoints([])).toBe("");
    expect(sparklinePoints([0, 0])).toBe("2,18 158,18");
    for (const values of [
      [-100, -200],
      [-50, 100, 0],
    ]) {
      expect(sparklinePoints(values)).not.toMatch(/NaN|Infinity/);
      expect(sparklinePoints(values).split(" ")).toHaveLength(values.length);
    }
  });
});
