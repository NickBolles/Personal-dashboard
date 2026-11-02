import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { describePrefill, mapPaletteArgs, parseSlashCommand } from "@/lib/workflows/palette-args";
import { getWorkflowBySlug } from "./store";

const TZ = () => process.env.TZ || "America/Chicago";

/**
 * W1 start: the chat is filed under the workflow's area and its instructions ride
 * as run context (≤ 4000, same as any composer context). Start forms are W2.
 */
export function prepareStart(userId: string, command: string, now = new Date()) {
  const cmd = parseSlashCommand(command);
  if (!cmd) throw new HttpError(400, "not_a_command", "Type /name to start a workflow");
  const found = getWorkflowBySlug(userId, cmd.slug);
  if (!found || !found.definition) throw new HttpError(404, "not_found", `No workflow called /${cmd.slug}`);
  if (found.workflow.status !== "active") throw new HttpError(409, "not_active", `${found.workflow.name} is a draft. Activate it in Workflows first.`);
  const def = found.definition;
  const savedPlaces = getDb()
    .select({ label: schema.savedPlaces.label })
    .from(schema.savedPlaces)
    .where(eq(schema.savedPlaces.ownerId, userId))
    .all()
    .map((p) => p.label);
  const prefill = mapPaletteArgs(def, cmd.rest, { now, timezone: TZ(), savedPlaces });
  const summary = describePrefill(def, prefill.values);
  const input = summary ? `${def.name} — ${summary}` : `Start ${def.name}`;
  const context = `Workflow: ${def.name} (/${def.slug}, v${found.workflow.currentVersion}).\n${def.instructions}`.slice(0, 4000);
  return { workflow: found.workflow, areaId: found.workflow.areaId, prefill: prefill.values, unmatched: prefill.unmatched, input, context };
}
