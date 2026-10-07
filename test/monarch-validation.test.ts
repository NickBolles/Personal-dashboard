import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance } from "@/server/auth";
import { saveIntegration } from "@/integrations/store";
import { createAccount, listAccounts, mapAccount } from "@/server/finance/accounts";
import { monarchValidation, refreshFromMonarch } from "@/server/finance/sync";
import * as monarch from "@/integrations/monarch/client";
import { setSetting } from "@/server/settings";
import * as notifications from "@/server/notifications";

let actor: string;
let accountId: string;
const asOf = "2026-10-01T12:00:00.000Z";
const remote: monarch.MonarchAccount = { externalId: "mapped", name: "Synthetic", type: "checking", balance: 12345, asOf, syncing: false };

beforeEach(() => {
  __setTestDatabase();
  actor = claimInstance({ setupCode: "TESTCODE", name: "Test", passcode: "test-passcode" });
  const a = createAccount({ name: "Synthetic", kind: "checking" }, actor, "test");
  accountId = a.id;
  getDb()
    .insert(schema.finExternalAccounts)
    .values([
      { source: "monarch", externalId: "mapped", name: "Synthetic", type: "checking", lastSeenAt: asOf },
      { source: "monarch", externalId: "absent", name: "Missing", type: "savings", lastSeenAt: asOf },
    ])
    .run();
  mapAccount(a.id, { source: "monarch", externalId: "mapped" }, a.version, actor, "test");
  saveIntegration("finance", {
    enabled: true,
    config: { balanceSource: "monarch", monarchUrl: "https://api.monarchmoney.com" },
    secrets: { monarchToken: "synthetic-only" },
  });
  vi.spyOn(monarch, "refreshAndWait").mockResolvedValue({ completed: true, accounts: [{ ...remote }] });
  vi.spyOn(monarch, "listTransactions").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

it("validates only a completed refresh and preserves imported provider timestamp/source/run provenance", async () => {
  const result = await refreshFromMonarch(actor, "test");
  expect(monarchValidation()).toMatchObject({ accounts: 1, runId: result.runId });
  expect(getDb().select().from(schema.finRuns).all().at(-1)?.status).toBe("succeeded");
  expect(listAccounts().find((a) => a.id === accountId)?.balance).toMatchObject({ balance: 12345, asOf, source: "monarch" });
  expect(getDb().select().from(schema.finBalances).all().at(-1)?.runId).toBe(result.runId);
});
it.each([
  { label: "sync timeout", completed: false, accounts: [remote] },
  {
    label: "missing mapped balance",
    completed: true,
    accounts: [
      { ...remote, balance: null },
      { ...remote, externalId: "unmapped" },
    ],
  },
  {
    label: "timestamp only on unmapped account",
    completed: true,
    accounts: [
      { ...remote, asOf: null },
      { ...remote, externalId: "unmapped" },
    ],
  },
  { label: "invalid imported timestamp", completed: true, accounts: [{ ...remote, asOf: "invalid" }] },
])("does not validate $label", async ({ completed, accounts }) => {
  vi.mocked(monarch.refreshAndWait).mockResolvedValue({ completed, accounts });
  await refreshFromMonarch(actor, "test");
  expect(monarchValidation()).toBeNull();
});
it("does not validate when another mapped account is missing", async () => {
  const b = createAccount({ name: "Missing", kind: "savings" }, actor, "test");
  mapAccount(b.id, { source: "monarch", externalId: "absent" }, b.version, actor, "test");
  expect((await refreshFromMonarch(actor, "test")).outcome).toBe("attention");
  expect(monarchValidation()).toBeNull();
});
it("ignores legacy validation flags that have no successful-run provenance", () => {
  setSetting("finance_monarch_validated", { at: asOf, accounts: 1 });
  expect(monarchValidation()).toBeNull();
});
it("does not validate if finishing the run fails", async () => {
  vi.spyOn(notifications, "notifyHolders").mockImplementationOnce(() => {
    throw new Error("synthetic finalization failure");
  });
  await expect(refreshFromMonarch(actor, "test")).rejects.toThrow("synthetic finalization failure");
  expect(monarchValidation()).toBeNull();
});
it("does not validate a failed transaction import", async () => {
  vi.mocked(monarch.listTransactions).mockRejectedValue(new Error("synthetic failure"));
  await expect(refreshFromMonarch(actor, "test")).rejects.toThrow("synthetic failure");
  expect(monarchValidation()).toBeNull();
});
it("never validates the configured mock", async () => {
  vi.stubEnv("JARVIS_MOCK_UPSTREAM_URL", "https://api.monarchmoney.com");
  try {
    await refreshFromMonarch(actor, "test");
    expect(monarchValidation()).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});
