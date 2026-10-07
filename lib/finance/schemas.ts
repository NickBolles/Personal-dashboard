import { z } from "zod";
import { ACCOUNT_KINDS, ACTION_KINDS } from "./types";

/** Request shapes shared by the finance API routes. Money is integer cents. */
export const cents = z.number().int().min(-1e13).max(1e13);
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const version = z.number().int().min(1);

export const accountInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(ACCOUNT_KINDS),
  cardBasis: z.enum(["statement", "current"]).nullable().optional(),
  reserveAccount: z.boolean().optional(),
});

export const statementInput = z.object({
  balance: cents.nullable().optional(),
  paymentsCredited: cents.nullable().optional(),
  dueDate: ymd.nullable().optional(),
});

export const actionInput = z.object({
  kind: z.enum(ACTION_KINDS),
  label: z.string().trim().min(1).max(120),
  amount: cents,
  fromAccountId: z.string().max(40).nullable().optional(),
  toAccountId: z.string().max(40).nullable().optional(),
  date: ymd.nullable().optional(),
  fundId: z.string().max(40).nullable().optional(),
  fundDecision: z.boolean().optional(),
  flowId: z.string().max(80).nullable().optional(),
  cardBasis: z.enum(["statement", "current"]).nullable().optional(),
  planEventId: z.string().max(40).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const allocations = z.record(z.string().max(40), cents);
