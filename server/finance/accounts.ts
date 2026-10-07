import "server-only";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import type { AccountKind, BalanceSemantics, BalanceSnapshot, BalanceSource, CardBasis, Cents, FinAccount } from "@/lib/finance/types";
import { auditFinance, notFound, updateVersioned } from "./common";
import { saveIntegration } from "@/integrations/store";

type AccountRow = typeof schema.finAccounts.$inferSelect;
type BalanceRow = typeof schema.finBalances.$inferSelect;

export type AccountView = FinAccount & {
  version: number;
  externalSource?: string;
  externalId?: string;
  balance?: BalanceSnapshot & { id: string };
};

export function toAccount(r: AccountRow): FinAccount {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as AccountKind,
    cardBasis: (r.cardBasis as CardBasis | null) ?? null,
    reserveAccount: r.reserveAccount,
    archived: r.archived,
  };
}

export function toSnapshot(b: BalanceRow): BalanceSnapshot & { id: string } {
  return {
    id: b.id,
    accountId: b.accountId,
    balance: b.balance,
    semantics: b.semantics as BalanceSemantics,
    source: b.source as BalanceSource,
    asOf: b.asOf,
    fetchedAt: b.fetchedAt,
    statement:
      b.statementBalance !== null || b.statementPaymentsCredited !== null || b.statementDueDate !== null
        ? { balance: b.statementBalance, paymentsCredited: b.statementPaymentsCredited, dueDate: b.statementDueDate }
        : null,
  };
}

export function accountRows(includeArchived = false) {
  const q = getDb().select().from(schema.finAccounts);
  return (includeArchived ? q : q.where(eq(schema.finAccounts.archived, false)))
    .orderBy(asc(schema.finAccounts.position), asc(schema.finAccounts.createdAt))
    .all();
}

export function latestBalance(accountId: string) {
  return getDb()
    .select()
    .from(schema.finBalances)
    .where(eq(schema.finBalances.accountId, accountId))
    .orderBy(desc(schema.finBalances.createdAt), desc(schema.finBalances.id))
    .limit(1)
    .get();
}

export function listAccounts(includeArchived = false): AccountView[] {
  return accountRows(includeArchived).map((r) => {
    const b = latestBalance(r.id);
    return {
      ...toAccount(r),
      version: r.version,
      externalSource: r.externalSource ?? undefined,
      externalId: r.externalId ?? undefined,
      balance: b ? toSnapshot(b) : undefined,
    };
  });
}

export function getAccountRow(id: string) {
  return getDb().select().from(schema.finAccounts).where(eq(schema.finAccounts.id, id)).get() ?? notFound("Account");
}

export type AccountInput = { name: string; kind: AccountKind; cardBasis?: CardBasis | null; reserveAccount?: boolean };

export function createAccount(input: AccountInput, actor: string, correlationId: string) {
  const id = newId("fac");
  const db = getDb();
  db.transaction((tx) => {
    if (input.reserveAccount) tx.update(schema.finAccounts).set({ reserveAccount: false }).run();
    const position = tx.select().from(schema.finAccounts).all().length;
    tx.insert(schema.finAccounts)
      .values({
        id,
        name: input.name.trim(),
        kind: input.kind,
        cardBasis: input.kind === "credit_card" ? (input.cardBasis ?? null) : null,
        reserveAccount: input.kind === "checking" && Boolean(input.reserveAccount),
        position,
      })
      .run();
  });
  // The first account turns the finance source on (Home cards, alerts); the default is manual balances.
  if (!getDb().select().from(schema.integrations).where(eq(schema.integrations.kind, "finance")).get()) saveIntegration("finance", { enabled: true });
  auditFinance(actor, "finance.account.create", id, null, input, correlationId);
  return listAccounts(true).find((a) => a.id === id)!;
}

export type AccountPatch = Partial<AccountInput> & { archived?: boolean; version: number };

export function updateAccount(id: string, patch: AccountPatch, actor: string, correlationId: string) {
  const before = getAccountRow(id);
  const kind = patch.kind ?? (before.kind as AccountKind);
  const set: Partial<AccountRow> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.cardBasis !== undefined || patch.kind !== undefined) set.cardBasis = kind === "credit_card" ? (patch.cardBasis ?? before.cardBasis) : null;
  if (patch.archived !== undefined) set.archived = patch.archived;
  if (patch.reserveAccount !== undefined) set.reserveAccount = kind === "checking" && patch.reserveAccount;
  getDb().transaction((tx) => {
    if (set.reserveAccount) tx.update(schema.finAccounts).set({ reserveAccount: false }).where(ne(schema.finAccounts.id, id)).run();
    updateVersioned(schema.finAccounts, eq(schema.finAccounts.id, id), patch.version, set, tx as never);
  });
  auditFinance(actor, "finance.account.update", id, before, set, correlationId);
  return listAccounts(true).find((a) => a.id === id)!;
}

/**
 * Map an account to one provider record. A provider record maps to at most
 * one account (unique index), and records marked as duplicates can't be
 * mapped: two copies of one card never both feed one account.
 */
export function mapAccount(id: string, external: { source: string; externalId: string } | null, version: number, actor: string, correlationId: string) {
  const before = getAccountRow(id);
  if (external) {
    const ext = getDb()
      .select()
      .from(schema.finExternalAccounts)
      .where(and(eq(schema.finExternalAccounts.source, external.source), eq(schema.finExternalAccounts.externalId, external.externalId)))
      .get();
    if (!ext) throw new HttpError(404, "not_found", "That provider account wasn't seen in the last refresh.");
    if (ext.ignored) throw new HttpError(409, "duplicate_record", "That record is marked as a duplicate. Un-mark it first if it's the one to keep.");
    const taken = getDb()
      .select()
      .from(schema.finAccounts)
      .where(and(eq(schema.finAccounts.externalSource, external.source), eq(schema.finAccounts.externalId, external.externalId)))
      .get();
    if (taken && taken.id !== id) throw new HttpError(409, "already_mapped", `That provider record already feeds “${taken.name}”.`);
  }
  updateVersioned(schema.finAccounts, eq(schema.finAccounts.id, id), version, {
    externalSource: external?.source ?? null,
    externalId: external?.externalId ?? null,
    updatedAt: new Date().toISOString(),
  });
  auditFinance(actor, "finance.account.map", id, { source: before.externalSource, externalId: before.externalId }, external, correlationId);
}

export function listExternalAccounts() {
  const mapped = new Map(
    getDb()
      .select()
      .from(schema.finAccounts)
      .all()
      .filter((a) => a.externalId)
      .map((a) => [`${a.externalSource}|${a.externalId}`, a.id]),
  );
  return getDb()
    .select()
    .from(schema.finExternalAccounts)
    .orderBy(asc(schema.finExternalAccounts.name))
    .all()
    .map((e) => ({ ...e, mappedTo: mapped.get(`${e.source}|${e.externalId}`) ?? null }));
}

/** Mark a provider record as a duplicate (or not). A mapped record must be unmapped first. */
export function setExternalIgnored(source: string, externalId: string, ignored: boolean, actor: string, correlationId: string) {
  const mapped = getDb()
    .select()
    .from(schema.finAccounts)
    .where(and(eq(schema.finAccounts.externalSource, source), eq(schema.finAccounts.externalId, externalId)))
    .get();
  if (ignored && mapped) throw new HttpError(409, "mapped", `Unmap it from “${mapped.name}” first.`);
  getDb()
    .update(schema.finExternalAccounts)
    .set({ ignored })
    .where(and(eq(schema.finExternalAccounts.source, source), eq(schema.finExternalAccounts.externalId, externalId)))
    .run();
  auditFinance(actor, "finance.external.ignore", externalId, null, { source, ignored }, correlationId);
}

export type BalanceInput = {
  accountId: string;
  balance: Cents;
  semantics?: BalanceSemantics;
  source: BalanceSource;
  /** when it was true; null = unknown. Manual entry defaults to "now" only because a person typed it now. */
  asOf: string | null;
  runId?: string;
  statement?: { balance?: Cents | null; paymentsCredited?: Cents | null; dueDate?: string | null } | null;
};

export function recordBalance(input: BalanceInput, actor: string) {
  getAccountRow(input.accountId);
  const id = newId("fbl");
  // Statement figures are entered by hand; keep the last ones unless new ones are given.
  const prev = input.statement === undefined ? latestBalance(input.accountId) : undefined;
  getDb()
    .insert(schema.finBalances)
    .values({
      id,
      accountId: input.accountId,
      balance: input.balance,
      semantics: input.semantics ?? "current",
      source: input.source,
      asOf: input.asOf,
      fetchedAt: new Date().toISOString(),
      runId: input.runId,
      statementBalance: input.statement ? (input.statement.balance ?? null) : (prev?.statementBalance ?? null),
      statementPaymentsCredited: input.statement ? (input.statement.paymentsCredited ?? null) : (prev?.statementPaymentsCredited ?? null),
      statementDueDate: input.statement ? (input.statement.dueDate ?? null) : (prev?.statementDueDate ?? null),
      enteredBy: actor,
    })
    .run();
  return id;
}

export function unmappedExternalCount() {
  return listExternalAccounts().filter((e) => !e.mappedTo && !e.ignored).length;
}
