import "server-only";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { userById, type CurrentUser } from "@/server/auth";
import { can } from "@/server/access";
import { processSingleton } from "@/server/singleton";
import * as assistant from "@/server/assistant";
import { liveOfRun } from "@/lib/agent-runs";
import { DELIVERY_CONFIRM_MS, decisionRef, deliveryText } from "@/lib/cw-decisions";
import type { TimelineItem } from "@/lib/hermes";
import { maskSecrets } from "@/server/ai/rules";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { activeRun } from "./task-runs";

/**
 * Answers reach the agent (task threads E3/E4). When the owner answers a question, the answer is recorded at once
 * and marked for delivery to the task's chat (decision-store.ts closeWithAnswer). Once the Undo window has passed,
 * this pass posts it there: guidance for the turn in flight, else the next message. It reads "Delivered" only after
 * the chat confirms it: the message read back in the conversation, or the turn it was given to ending without
 * handing it back unread (then it is posted as the next message).
 *
 * The owner's answer is the go-ahead for this one message. Nothing else is sent: an answer that was undone in time
 * is never posted, and a chat with a turn paused on an approval is waited for, not interrupted.
 */
export const DELIVERY_EVERY_MS = 10_000;
/** Answers handled per pass. */
const PER_PASS = 10;
/** A post that failed is tried again after this long, until the answer is this old. */
const RETRY_MS = 60_000;
const GIVE_UP_MS = 30 * 60_000;
/** Guidance waiting on a turn that is still going is checked again after this long. */
const CHECK_AGAIN_MS = 30_000;

export type DeliveryDeps = {
  startRun: typeof assistant.startRun;
  steerRun: typeof assistant.steerRun;
  /** The run's state as Hermes has it now (its local record can lag when no chat is open). */
  reconcile: (runId: string) => Promise<{ status: string; pendingSteer?: string; forgotten?: true }>;
  sessionDetail: (user: CurrentUser, id: string) => Promise<{ timeline: TimelineItem[] }>;
  user: (id: string) => CurrentUser | null;
};
const defaultDeps: DeliveryDeps = {
  startRun: (...args) => assistant.startRun(...args),
  steerRun: (...args) => assistant.steerRun(...args),
  reconcile: (runId) => assistant.reconcileRun(runId),
  sessionDetail: (user, id) => assistant.getSessionDetail(user, id),
  user: (id) => userById(id),
};

const D = schema.decisions;
const state = () => processSingleton<{ busy: boolean }>("answer_delivery", () => ({ busy: false }));

export async function deliverAnswers(now = new Date(), deps: DeliveryDeps = defaultDeps): Promise<{ sent: number; delivered: number; failed: number }> {
  const s = state();
  if (s.busy) return { sent: 0, delivered: 0, failed: 0 };
  s.busy = true;
  try {
    return await pass(now, deps);
  } finally {
    s.busy = false;
  }
}

async function pass(now: Date, deps: DeliveryDeps) {
  const db = getDb();
  const at = now.toISOString();
  const due = db
    .select()
    .from(D)
    .where(and(inArray(D.deliveryState, ["pending", "sent"]), lte(D.deliverAfter, at), inArray(D.state, ["answered", "defaulted"])))
    // Longest-waiting first; an answer still waiting on its turn is pushed back, so it never holds up the rest.
    .orderBy(asc(D.deliverAfter))
    .limit(PER_PASS)
    .all();
  let sent = 0;
  let delivered = 0;
  let failed = 0;
  const set = (id: string, values: Partial<typeof D.$inferInsert>, from: string) =>
    db
      .update(D)
      .set({ ...values, updatedAt: at })
      .where(and(eq(D.id, id), eq(D.deliveryState, from)))
      .run();
  for (const row of due) {
    const session = row.deliverySession;
    const answer = row.answeredChoice ?? "";
    const user = deps.user(row.userId);
    if (!session || !answer || !user || !can(user, "hermes.chat")) {
      set(row.id, { deliveryState: "failed", deliveryError: "No chat to post the answer in" }, row.deliveryState!);
      failed++;
      continue;
    }
    const text = deliveryText(decisionRef(row.seq), row.question, answer);
    // What the chat will show: the assistant masks secrets and account numbers before anything is sent.
    const outbound = maskAccountNumbers(maskSecrets(text).text);
    const answeredAt = Date.parse(row.answeredAt ?? at);
    if (row.deliveryState === "pending") {
      let running = activeRun(row.userId, session);
      try {
        if (running) {
          // Jarvis's record of the turn can lag (no chat open, worker off): ask Hermes before steering or waiting.
          const fresh = await deps.reconcile(running.runId).catch(() => null);
          const live = liveOfRun(fresh?.status ?? running.status);
          if (live !== "running" && live !== "waiting") running = null;
          else if (fresh) running = { ...running, status: fresh.status };
        }
        if (running && liveOfRun(running.status) === "waiting") {
          // A turn paused on an approval: wait for it rather than interrupt it.
          set(row.id, { deliverAfter: new Date(now.getTime() + RETRY_MS).toISOString() }, "pending");
          continue;
        }
        if (running) {
          // The turn in flight takes it as guidance. Accepted means queued, not read: it counts as delivered once
          // that turn ends without handing it back (pending_steer).
          await deps.steerRun(user, running.runId, text, `answer:${row.id}`);
          set(row.id, { deliveryState: "sent", deliveryRun: running.runId, deliverAfter: at, deliveryError: null }, "pending");
          sent++;
        } else {
          await deps.startRun(user, { sessionId: session, input: text, idempotencyKey: `answer:${row.id}` }, `answer:${row.id}`);
          // Read back on a later pass: the message has to be in the conversation.
          set(row.id, { deliveryState: "sent", deliveryRun: null, deliverAfter: at, deliveryError: null }, "pending");
          sent++;
        }
        audit({
          actor: row.userId,
          action: "work.decision_delivered",
          source: "work",
          sourceRecord: row.itemId,
          result: "ok",
          correlationId: `answer:${row.id}`,
          detail: { ref: decisionRef(row.seq), how: running ? "guidance" : "message" },
        });
      } catch (err) {
        const message = (err as Error).message.slice(0, 200);
        if (now.getTime() - answeredAt > GIVE_UP_MS) {
          set(row.id, { deliveryState: "failed", deliveryError: message }, "pending");
          failed++;
        } else set(row.id, { deliverAfter: new Date(now.getTime() + RETRY_MS).toISOString(), deliveryError: message }, "pending");
      }
      continue;
    }
    // Sent as guidance: wait for that turn to end, then see whether it used it.
    if (row.deliveryRun) {
      try {
        const run = await deps.reconcile(row.deliveryRun);
        const live = liveOfRun(run.status);
        if (live === "running" || live === "waiting") {
          set(row.id, { deliverAfter: new Date(now.getTime() + CHECK_AGAIN_MS).toISOString() }, "sent");
          continue;
        }
        if (run.forgotten) {
          // Hermes no longer has the turn, so whether it read the guidance can't be known: say so, never "delivered".
          set(row.id, { deliveryState: "failed", deliveryError: "Couldn't confirm the agent read it" }, "sent");
          failed++;
          continue;
        }
        const handedBack = !!run.pendingSteer && (run.pendingSteer.includes(outbound) || run.pendingSteer.includes(answer));
        if (handedBack) {
          // The turn ended before reading it: post it as the next message instead.
          set(row.id, { deliveryState: "pending", deliveryRun: null, deliverAfter: at }, "sent");
        } else {
          set(row.id, { deliveryState: "delivered", deliveredAt: at }, "sent");
          delivered++;
        }
      } catch {
        // The turn could not be read: try again shortly, behind the rest of the queue.
        set(row.id, { deliverAfter: new Date(now.getTime() + CHECK_AGAIN_MS).toISOString() }, "sent");
      }
      continue;
    }
    // Sent as a message: read it back.
    try {
      const detail = await deps.sessionDetail(user, session);
      const there = detail.timeline.some((m) => m.kind === "user" && (m.text.includes(outbound) || m.text.includes(text)));
      if (there) {
        set(row.id, { deliveryState: "delivered", deliveredAt: at }, "sent");
        delivered++;
      } else if (now.getTime() - Date.parse(row.deliverAfter ?? at) > DELIVERY_CONFIRM_MS) {
        set(row.id, { deliveryState: "failed", deliveryError: "Not seen in the chat" }, "sent");
        failed++;
      }
    } catch {
      /* the chat could not be read: try again next pass */
    }
  }
  return { sent, delivered, failed };
}
