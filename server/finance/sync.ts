import "server-only";
import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { getSetting, setSetting } from "@/server/settings";
import { notifyHolders } from "@/server/notifications";
import { addDays, legEffects } from "@/lib/finance/engine";
import { csvObjects, parseDate, parseMoney } from "@/lib/finance/csv";
import type { Cents, Inclusion, LegSide } from "@/lib/finance/types";
import { resolveIntegration } from "@/integrations/store";
import { listTransactions, monarchConn, refreshAndWait } from "@/integrations/monarch/client";
import { accountRows, getAccountRow, recordBalance } from "./accounts";
import { auditFinance, monthName, notFound, thisMonth, today } from "./common";
import { checkinActions, currentResult, getCheckinRow } from "./checkins";
import { startRun } from "./runs";

const db = () => getDb();

/* ------------------------------------------------------------- outcomes */

export type RunOutcome = "ready" | "attention" | "failed";

/**
 * Finish a run and tell people who can see finances. Messages never carry
 * amounts, account names or institutions. One notice per run, recipient and
 * outcome: the dedupe key makes a crash-recovered retry a no-op.
 */
export function finishRun(runId: string, status: "succeeded" | "partial" | "failed", error?: string, detail?: unknown) {
  const res = currentResult();
  const issues = res ? res.result.issues.length : 0;
  const outcome: RunOutcome = status === "failed" ? "failed" : status === "partial" || issues > 0 ? "attention" : "ready";
  db()
    .update(schema.finRuns)
    .set({ status, outcome, error: error ?? null, detail: detail ? JSON.stringify(detail) : null, finishedAt: new Date().toISOString(), leaseUntil: null })
    .where(eq(schema.finRuns.id, runId))
    .run();
  const month = monthName(res?.checkin.month ?? thisMonth());
  const n = issues + (status === "partial" ? 1 : 0);
  const message =
    outcome === "failed"
      ? { title: "Balance refresh failed", body: "Open the app for details." }
      : outcome === "attention"
        ? { title: `${month} check-in needs attention`, body: `${n} item${n === 1 ? "" : "s"} to look at.` }
        : { title: `${month} check-in is ready to review`, body: "Balances are fresh and nothing is blocking." };
  notifyHolders(
    {
      type: `finance.${outcome}`,
      category: "finance",
      severity: outcome === "failed" ? "high" : "normal",
      ...message,
      source: "finance",
      deepLink: res ? `/finance/checkin/${res.checkin.id}` : "/finance",
      dedupeKey: `finance:run:${runId}:${outcome}`,
    },
    "finance.view",
  );
  return outcome;
}

/* -------------------------------------------------------- transactions */

export type TxnInput = { accountId: string; sourceTxnId: string; date: string; amount: Cents; description: string; pending: boolean };

/**
 * Upsert imported transactions. Identity is (source, account, source id). A
 * record that overlaps one from another source (same account, date, amount)
 * is flagged ambiguous for a person, never silently merged.
 */
export function upsertTransactions(source: string, rows: TxnInput[], runId: string) {
  let added = 0;
  let updated = 0;
  let ambiguous = 0;
  db().transaction((tx) => {
    for (const r of rows) {
      const existing = tx
        .select()
        .from(schema.finTransactions)
        .where(
          and(
            eq(schema.finTransactions.source, source),
            eq(schema.finTransactions.accountId, r.accountId),
            eq(schema.finTransactions.sourceTxnId, r.sourceTxnId),
          ),
        )
        .get();
      if (existing) {
        if (existing.pending !== r.pending || existing.amount !== r.amount || existing.date !== r.date) {
          tx.update(schema.finTransactions)
            .set({ pending: r.pending, amount: r.amount, date: r.date, runId })
            .where(eq(schema.finTransactions.id, existing.id))
            .run();
          updated++;
        }
        continue;
      }
      const overlap = tx
        .select()
        .from(schema.finTransactions)
        .where(
          and(
            eq(schema.finTransactions.accountId, r.accountId),
            ne(schema.finTransactions.source, source),
            eq(schema.finTransactions.date, r.date),
            eq(schema.finTransactions.amount, r.amount),
            isNull(schema.finTransactions.supersededBy),
          ),
        )
        .get();
      const id = newId("ftx");
      tx.insert(schema.finTransactions)
        .values({ id, source, ...r, description: r.description.slice(0, 200), ambiguous: Boolean(overlap), runId })
        .run();
      if (overlap) ambiguous++;
      // A posted CSV row replaces an earlier pending one for the same amount and description.
      if (!r.pending) {
        const pendingTwin = tx
          .select()
          .from(schema.finTransactions)
          .where(
            and(
              eq(schema.finTransactions.accountId, r.accountId),
              eq(schema.finTransactions.source, source),
              eq(schema.finTransactions.pending, true),
              eq(schema.finTransactions.amount, r.amount),
              eq(schema.finTransactions.description, r.description.slice(0, 200)),
              isNull(schema.finTransactions.supersededBy),
              gte(schema.finTransactions.date, addDays(r.date, -7)),
            ),
          )
          .get();
        if (pendingTwin) tx.update(schema.finTransactions).set({ supersededBy: id }).where(eq(schema.finTransactions.id, pendingTwin.id)).run();
      }
      added++;
    }
  });
  return { added, updated, ambiguous };
}

export function recentTransactions(since: string) {
  const rows = db()
    .select()
    .from(schema.finTransactions)
    .where(and(isNull(schema.finTransactions.supersededBy), gte(schema.finTransactions.date, since)))
    .orderBy(desc(schema.finTransactions.date))
    .limit(300)
    .all();
  const legs = rows.length
    ? db()
        .select()
        .from(schema.finActionLegs)
        .where(
          inArray(
            schema.finActionLegs.transactionId,
            rows.map((r) => r.id),
          ),
        )
        .all()
    : [];
  return rows.map((r) => {
    const l = legs.find((x) => x.transactionId === r.id);
    return { ...r, matched: l ? { actionId: l.actionId, side: l.side } : null };
  });
}

export type MatchProposal = { transactionId: string; actionId: string; side: LegSide; proposedInclusion: Inclusion; reason: string };

/**
 * Suggest which open action leg a transaction is. Same account, same signed
 * amount, within a week. Every match still needs a person to confirm.
 */
export function proposeMatches(checkinId: string): MatchProposal[] {
  const c = getCheckinRow(checkinId);
  const actions = checkinActions(checkinId).filter((a) => a.status !== "skipped" && a.status !== "cancelled");
  const bindings = db().select().from(schema.finCheckinBalances).where(eq(schema.finCheckinBalances.checkinId, c.id)).all();
  const asOfBy = new Map<string, string | null>();
  for (const b of bindings) asOfBy.set(b.accountId, db().select().from(schema.finBalances).where(eq(schema.finBalances.id, b.balanceId)).get()?.asOf ?? null);
  const txns = recentTransactions(addDays(today(), -45)).filter((t) => !t.matched && !t.ambiguous);
  const out: MatchProposal[] = [];
  const taken = new Set<string>();
  for (const t of txns) {
    for (const a of actions) {
      const legs = legEffects(a).filter((l) => l.accountId === t.accountId && l.delta === t.amount);
      const leg = legs.find((l) => !a.legDetails.find((d) => d.side === l.side)?.transactionId && !taken.has(`${a.id}:${l.side}`));
      if (!leg) continue;
      if (a.date && Math.abs(Date.parse(a.date) - Date.parse(t.date)) > 7 * 86_400_000) continue;
      const asOf = asOfBy.get(t.accountId) ?? null;
      // A posted date before the as-of suggests inclusion; it doesn't prove it, so a person confirms.
      const proposedInclusion: Inclusion = !t.pending && asOf && t.date < asOf.slice(0, 10) ? "included" : "unknown";
      out.push({
        transactionId: t.id,
        actionId: a.id,
        side: leg.side,
        proposedInclusion,
        reason: t.pending
          ? "Pending: it may or may not already reduce the balance."
          : proposedInclusion === "included"
            ? `Posted ${t.date}, before the balance's as-of ${asOf!.slice(0, 10)}.`
            : "Posted on or after the balance date (or the as-of is unknown): check the balance.",
      });
      taken.add(`${a.id}:${leg.side}`);
      break;
    }
  }
  return out;
}

/**
 * A person confirms a transaction is an action's leg, and whether it's in the
 * snapshot. Pending transactions are never treated as posted: they don't move
 * the action's status.
 */
export function confirmMatch(input: { transactionId: string; actionId: string; side: LegSide; inclusion: Inclusion }, actor: string, correlationId: string) {
  const t = db().select().from(schema.finTransactions).where(eq(schema.finTransactions.id, input.transactionId)).get() ?? notFound("Transaction");
  const a = db().select().from(schema.finActions).where(eq(schema.finActions.id, input.actionId)).get() ?? notFound("Action");
  const c = getCheckinRow(a.checkinId);
  if (c.status !== "draft") throw new HttpError(409, "closed", "That check-in is closed.");
  const leg = db()
    .select()
    .from(schema.finActionLegs)
    .where(and(eq(schema.finActionLegs.actionId, a.id), eq(schema.finActionLegs.side, input.side)))
    .get();
  if (!leg) notFound("Leg");
  if (leg.accountId !== t.accountId) throw new HttpError(400, "wrong_account", "That transaction is on a different account.");
  const taken = db().select().from(schema.finActionLegs).where(eq(schema.finActionLegs.transactionId, t.id)).get();
  if (taken && !(taken.actionId === a.id && taken.side === input.side)) {
    throw new HttpError(409, "already_matched", "That transaction is already matched to another action. One transaction can't pay twice.");
  }
  if (t.pending && input.inclusion === "included") {
    const bal = db()
      .select()
      .from(schema.finCheckinBalances)
      .innerJoin(schema.finBalances, eq(schema.finBalances.id, schema.finCheckinBalances.balanceId))
      .where(and(eq(schema.finCheckinBalances.checkinId, c.id), eq(schema.finCheckinBalances.accountId, t.accountId)))
      .get();
    if (bal?.fin_balances.semantics !== "available") {
      throw new HttpError(400, "pending_not_posted", "A pending transaction can only be counted as included in an *available* balance.");
    }
  }
  db().transaction((tx) => {
    tx.update(schema.finActionLegs)
      .set({
        transactionId: t.id,
        inclusion: input.inclusion,
        evidence: `Matched ${t.pending ? "pending " : ""}transaction ${t.date} “${t.description}”`,
        confirmedBy: actor,
        confirmedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.finActionLegs.actionId, a.id), eq(schema.finActionLegs.side, input.side)))
      .run();
    if (!t.pending) {
      const legs = tx.select().from(schema.finActionLegs).where(eq(schema.finActionLegs.actionId, a.id)).all();
      const posted = legs.filter((l) => l.transactionId === t.id || (l.transactionId && !isPendingTxn(l.transactionId)));
      const status = posted.length === legs.length ? "settled" : "initiated";
      if (a.status === "planned" || (a.status === "initiated" && status === "settled")) {
        tx.update(schema.finActions)
          .set({ status, version: sql`${schema.finActions.version} + 1`, updatedAt: new Date().toISOString() })
          .where(eq(schema.finActions.id, a.id))
          .run();
      }
    }
  });
  auditFinance(actor, "finance.match", a.id, leg, input, correlationId);
}

function isPendingTxn(id: string) {
  return Boolean(db().select().from(schema.finTransactions).where(eq(schema.finTransactions.id, id)).get()?.pending);
}

/* --------------------------------------------------------------- inputs */

export function enterBalances(
  entries: {
    accountId: string;
    balance: Cents;
    asOf?: string | null;
    semantics?: "current" | "available" | "statement";
    statement?: { balance?: Cents | null; paymentsCredited?: Cents | null; dueDate?: string | null };
  }[],
  actor: string,
  correlationId: string,
) {
  const runId = startRun("manual", actor);
  try {
    for (const e of entries) {
      recordBalance(
        {
          accountId: e.accountId,
          balance: e.balance,
          semantics: e.semantics,
          source: "manual",
          asOf: e.asOf ?? new Date().toISOString(),
          runId,
          statement: e.statement,
        },
        actor,
      );
    }
    auditFinance(actor, "finance.balances.manual", runId, null, { accounts: entries.length }, correlationId);
    db().update(schema.finRuns).set({ status: "succeeded", finishedAt: new Date().toISOString(), leaseUntil: null }).where(eq(schema.finRuns.id, runId)).run();
  } catch (err) {
    db()
      .update(schema.finRuns)
      .set({ status: "failed", error: (err as Error).message, finishedAt: new Date().toISOString(), leaseUntil: null })
      .where(eq(schema.finRuns.id, runId))
      .run();
    throw err;
  }
  return runId;
}

type CsvResult = { runId: string; imported: number; errors: { line: number; message: string }[]; ambiguous?: number; outcome: RunOutcome };

/**
 * CSV import.
 *  - balances: account,balance,as_of[,statement_balance,payments_credited,due_date]
 *  - transactions (for one account): date,amount,description[,pending]
 * Identical rows in one file stay distinct (occurrence number in the identity);
 * re-importing the same file adds nothing.
 */
export function importCsv(kind: "balances" | "transactions", csv: string, accountId: string | undefined, actor: string, correlationId: string): CsvResult {
  const runId = startRun("csv", actor);
  const errors: CsvResult["errors"] = [];
  let imported = 0;
  let ambiguous = 0;
  try {
    const rows = csvObjects(csv);
    if (!rows.length) throw new HttpError(400, "empty", "The file has no rows.");
    if (kind === "balances") {
      const accounts = accountRows();
      for (const r of rows) {
        try {
          const acct = accounts.find((a) => a.name.toLowerCase() === (r.account ?? "").toLowerCase() || a.id === r.account);
          if (!acct) throw new Error(`No account named “${r.account}”`);
          const asOfRaw = r.as_of || r.asof || "";
          recordBalance(
            {
              accountId: acct.id,
              balance: parseMoney(r.balance ?? ""),
              source: "csv",
              asOf: asOfRaw ? (/T/.test(asOfRaw) ? new Date(asOfRaw).toISOString() : `${parseDate(asOfRaw)}T00:00:00.000Z`) : null,
              runId,
              statement:
                r.statement_balance || r.payments_credited || r.due_date
                  ? {
                      balance: r.statement_balance ? parseMoney(r.statement_balance) : null,
                      paymentsCredited: r.payments_credited ? parseMoney(r.payments_credited) : null,
                      dueDate: r.due_date ? parseDate(r.due_date) : null,
                    }
                  : undefined,
            },
            actor,
          );
          imported++;
        } catch (err) {
          errors.push({ line: r.line, message: (err as Error).message });
        }
      }
    } else {
      if (!accountId) throw new HttpError(400, "account_required", "Pick the account these transactions belong to.");
      getAccountRow(accountId);
      const seen = new Map<string, number>();
      const txns: TxnInput[] = [];
      for (const r of rows) {
        try {
          const date = parseDate(r.date ?? "");
          const amount = parseMoney(r.amount ?? "");
          const description = r.description ?? r.name ?? r.merchant ?? "";
          const base = crypto.createHash("sha256").update(`${accountId}|${date}|${amount}|${description}`).digest("hex").slice(0, 24);
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          txns.push({ accountId, sourceTxnId: `${base}#${n}`, date, amount, description, pending: /^(true|yes|1|pending)$/i.test(r.pending ?? "") });
        } catch (err) {
          errors.push({ line: r.line, message: (err as Error).message });
        }
      }
      const res = upsertTransactions("csv", txns, runId);
      imported = res.added;
      ambiguous = res.ambiguous;
    }
    auditFinance(actor, `finance.import.${kind}`, runId, null, { imported, errors: errors.length, ambiguous }, correlationId);
    const outcome = finishRun(runId, errors.length || ambiguous ? "partial" : "succeeded", errors.length ? `${errors.length} row(s) skipped` : undefined, {
      imported,
      errors,
    });
    return { runId, imported, errors, ambiguous, outcome };
  } catch (err) {
    finishRun(runId, "failed", (err as Error).message);
    throw err;
  }
}

/* -------------------------------------------------------------- Monarch */

const VALIDATED_KEY = "finance_monarch_validated";

/** Has a refresh ever worked against a real (non-mock) Monarch account? Until then it's a release blocker. */
export function monarchValidation() {
  return getSetting<{ at: string; accounts: number }>(VALIDATED_KEY) ?? null;
}

function isMockUrl(url: string) {
  const mock = process.env.JARVIS_MOCK_UPSTREAM_URL;
  return Boolean(mock && url.startsWith(mock.replace(/\/$/, "")));
}

/**
 * Refresh-and-read: ask Monarch to sync, wait (bounded), then store each
 * mapped account's balance with Monarch's own as-of time (or unknown), and
 * import recent transactions for matching.
 */
export async function refreshFromMonarch(actor: string, correlationId: string) {
  const runId = startRun("monarch", actor);
  try {
    const conn = monarchConn();
    const waitMs = Math.max(0, Number(resolveIntegration("finance").config.refreshWaitSeconds || 60)) * 1000;
    const { accounts: remote, completed } = await refreshAndWait(conn, { waitMs, pollMs: Math.min(3000, Math.max(100, waitMs / 10)) });
    const now = new Date().toISOString();
    for (const r of remote) {
      db()
        .insert(schema.finExternalAccounts)
        .values({ source: "monarch", externalId: r.externalId, name: r.name, type: r.type, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [schema.finExternalAccounts.source, schema.finExternalAccounts.externalId],
          set: { name: r.name, type: r.type, lastSeenAt: now },
        })
        .run();
    }
    const mapped = accountRows().filter((a) => a.externalSource === "monarch" && a.externalId);
    const missing: string[] = [];
    let stored = 0;
    for (const a of mapped) {
      const r = remote.find((x) => x.externalId === a.externalId);
      if (!r || r.balance === null) {
        missing.push(a.id);
        continue;
      }
      recordBalance({ accountId: a.id, balance: r.balance, semantics: "current", source: "monarch", asOf: r.asOf, runId }, actor);
      stored++;
    }
    const since = addDays(today(), -45);
    const byExternal = new Map(mapped.map((a) => [a.externalId!, a.id]));
    const txns = (await listTransactions(conn, since))
      .filter((t) => byExternal.has(t.accountExternalId))
      .map((t) => ({
        accountId: byExternal.get(t.accountExternalId)!,
        sourceTxnId: t.externalId,
        date: t.date,
        amount: t.amount,
        description: t.description,
        pending: t.pending,
      }));
    const imported = upsertTransactions("monarch", txns, runId);
    if (stored > 0 && !isMockUrl(conn.baseUrl) && remote.some((r) => r.asOf)) setSetting(VALIDATED_KEY, { at: now, accounts: stored });
    const partial = !completed || missing.length > 0 || mapped.length === 0;
    const detail = { stored, missing: missing.length, unmapped: remote.length - mapped.length, syncCompleted: completed, transactions: imported };
    auditFinance(actor, "finance.refresh.monarch", runId, null, detail, correlationId);
    const outcome = finishRun(
      runId,
      partial ? "partial" : "succeeded",
      mapped.length === 0
        ? "No accounts are mapped to Monarch yet"
        : !completed
          ? "Monarch was still syncing; some balances may be older"
          : missing.length
            ? `${missing.length} account(s) had no balance`
            : undefined,
      detail,
    );
    return { runId, outcome, ...detail };
  } catch (err) {
    const message = err instanceof UpstreamError || err instanceof HttpError ? err.message : `Unexpected error: ${(err as Error).message}`;
    finishRun(runId, "failed", message);
    auditFinance(actor, "finance.refresh.monarch", runId, null, { error: message }, correlationId);
    throw err;
  }
}

export function runsList(limit = 20) {
  return db().select().from(schema.finRuns).orderBy(desc(schema.finRuns.startedAt)).limit(limit).all();
}
