import "server-only";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { shareableWithHermes } from "@/lib/privacy";

/**
 * Server-side backstop for the privacy line: context attached to a Hermes
 * message may not reference home data, whatever the client sent. Refs look
 * like `[source:id]` (actions) or `[alert:id]` (notifications).
 */
export function assertShareableContext(context: string | undefined) {
  if (!context) return;
  const refs = [...context.matchAll(/\[([a-z_]+):([^\]\s]+)\]/g)].map((m) => ({ kind: m[1]!, id: m[2]! }));
  if (refs.some((r) => r.kind !== "alert" && !shareableWithHermes(r.kind))) throw blocked();
  const alertIds = refs.filter((r) => r.kind === "alert").map((r) => r.id);
  if (!alertIds.length) return;
  const rows = getDb().select({ source: schema.notifications.source }).from(schema.notifications).where(inArray(schema.notifications.id, alertIds)).all();
  if (rows.some((r) => !shareableWithHermes(r.source))) throw blocked();
}

function blocked() {
  return new HttpError(400, "private_context", "Home Assistant data stays out of Hermes. Remove it from the attached context.");
}
