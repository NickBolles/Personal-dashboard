import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getOwner, type CurrentUser } from "@/server/auth";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { getPreferences, getSetting, setSetting } from "@/server/settings";
import { listItems } from "@/server/work/store";
import { globalCoordinatorArea } from "@/server/work/coordinator";
import { localDate } from "@/lib/time";
import {
  DEFAULT_MAX_RUNS_PER_DAY,
  MAX_JOBS,
  SUGGESTED_TEMPLATES,
  effectiveAutonomy,
  nextRunAt,
  jobInputSchema,
  jobPatchSchema,
  jobsExportSchema,
  type ScheduledJob,
  type JobInput,
  type JobPatch,
  type JobsExport,
} from "@/lib/away";
import { audit } from "@/server/audit";
import { FEEDBACK_TRIAGE_TEMPLATE } from "@/lib/feedback";

export const J = schema.scheduledJobs;
export const R = schema.scheduledJobRuns;
export type JobRow = typeof J.$inferSelect;
export type RunRow = typeof R.$inferSelect;

export function assertAwayOwner(user: CurrentUser) {
  if (getOwner()?.id !== user.id) throw new HttpError(403, "owner_only", "Only the owner can manage scheduled jobs.");
}
export function scheduleId(raw: string) {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "bad_id", "Invalid schedule id");
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, "bad_id", "Invalid schedule id");
  return id;
}
export const scheduleTimezone = () => getPreferences().timezone || "America/Chicago";
export function jobRow(user: CurrentUser, id: string): JobRow {
  assertAwayOwner(user);
  const r = getDb()
    .select()
    .from(J)
    .where(and(eq(J.userId, user.id), eq(J.id, id)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "That scheduled job isn't here");
  return r;
}
export function jobView(user: CurrentUser, r: JobRow, now = new Date()): ScheduledJob {
  const area = listItems(user.id).find((i) => i.id === r.areaId && !i.archived);
  const schedule = jobInputSchema.shape.schedule.parse(JSON.parse(r.scheduleJson));
  return {
    id: r.id,
    title: r.title,
    areaId: area?.id ?? null,
    areaTitle: area?.title ?? null,
    kind: r.kind as ScheduledJob["kind"],
    prompt: r.prompt,
    schedule,
    overnight: r.overnight,
    enabled: r.enabled,
    templateKey: r.templateKey,
    tz: r.tz,
    nextRunAt: r.enabled ? (nextRunAt(schedule, now, r.tz)?.toISOString() ?? null) : null,
    lastRunAt: r.lastRunAt,
    lastStatus: r.lastStatus as ScheduledJob["lastStatus"],
    lastError: r.lastError,
    consecutiveFailures: r.consecutiveFailures,
    autonomy: area ? effectiveAutonomy(area) : "off",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
export function jobRows(user: CurrentUser) {
  assertAwayOwner(user);
  return getDb().select().from(J).where(eq(J.userId, user.id)).all();
}
export function runCaps(user: CurrentUser, now = new Date(), tz = scheduleTimezone()) {
  const setting = getSetting<unknown>("away_max_runs_per_day");
  const maxRunsPerDay = typeof setting === "number" && Number.isSafeInteger(setting) && setting >= 1 ? setting : DEFAULT_MAX_RUNS_PER_DAY;
  const today = localDate(now, tz);
  const runsToday = getDb()
    .select({ startedAt: R.startedAt })
    .from(R)
    .where(and(eq(R.userId, user.id), ne(R.status, "skipped")))
    .all()
    .filter((r) => localDate(new Date(r.startedAt), tz) === today).length;
  return { maxJobs: MAX_JOBS, maxRunsPerDay, runsToday };
}
function mutation(user: CurrentUser, action: string, id: string, correlationId: string) {
  audit({ actor: user.id, action: `agents.schedules.${action}`, source: "agents", sourceRecord: id, result: "ok", correlationId });
}
function validateArea(user: CurrentUser, areaId: string | null) {
  if (!areaId) return;
  if (!listItems(user.id).some((i) => i.id === areaId && i.kind === "area" && i.parentId === null && !i.archived))
    throw new HttpError(400, "area", "Pick an area");
}
export function createJob(user: CurrentUser, input: JobInput, correlationId: string, now = new Date(), templateKey: string | null = null) {
  assertAwayOwner(user);
  const body = jobInputSchema.parse(input);
  validateArea(user, body.areaId);
  return getDb().transaction(() => {
    if (jobRows(user).length >= MAX_JOBS) throw new HttpError(409, "too_many_jobs", "The scheduled job limit is reached");
    const id = newId("sched");
    getDb()
      .insert(J)
      .values({
        id,
        userId: user.id,
        areaId: body.areaId,
        title: body.title,
        kind: body.kind,
        prompt: body.prompt,
        scheduleJson: JSON.stringify(body.schedule),
        tz: scheduleTimezone(),
        overnight: body.overnight,
        enabled: false,
        templateKey,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .run();
    mutation(user, "create", id, correlationId);
    return jobView(user, jobRow(user, id), now);
  });
}
export function seedJobs(user: CurrentUser, now = new Date()) {
  assertAwayOwner(user);
  getDb().transaction(() => {
    const key = `away_templates_seeded:${user.id}`;
    if (getSetting(key)) return;
    const areaId = globalCoordinatorArea(user)?.id ?? null;
    for (const { key: templateKey, ...t } of SUGGESTED_TEMPLATES) {
      if (jobRows(user).length < MAX_JOBS) createJob(user, { ...t, areaId, enabled: false }, "away-templates", now, templateKey);
    }
    setSetting(key, true);
  });
}
/** "Daily feedback triage" (feedback loop): seeded disabled once, also on installs seeded before it existed. */
export function seedFeedbackTemplate(user: CurrentUser, now = new Date()) {
  assertAwayOwner(user);
  getDb().transaction(() => {
    const key = `feedback_template_seeded:${user.id}`;
    if (getSetting(key)) return;
    const { key: templateKey, ...t } = FEEDBACK_TRIAGE_TEMPLATE;
    const exists = jobRows(user).some((r) => r.templateKey === templateKey);
    if (!exists && jobRows(user).length < MAX_JOBS)
      createJob(user, { ...t, areaId: globalCoordinatorArea(user)?.id ?? null, enabled: false }, "feedback-template", now, templateKey);
    setSetting(key, true);
  });
}
export function listSchedules(user: CurrentUser, now = new Date()) {
  assertAwayOwner(user);
  seedJobs(user, now);
  seedFeedbackTemplate(user, now);
  return {
    jobs: jobRows(user).map((r) => jobView(user, r, now)),
    tz: scheduleTimezone(),
    caps: runCaps(user, now),
    areas: listItems(user.id)
      .filter((i) => i.kind === "area" && !i.parentId && !i.archived)
      .map((i) => ({ id: i.id, title: i.title, autonomy: effectiveAutonomy(i) })),
  };
}
export function patchJob(user: CurrentUser, id: string, input: JobPatch, correlationId: string, now = new Date()) {
  const r = jobRow(user, id);
  const { schedule, ...patch } = jobPatchSchema.parse(input);
  if (patch.areaId !== undefined) validateArea(user, patch.areaId);
  const areaChanged = patch.areaId !== undefined && patch.areaId !== r.areaId;
  if (
    areaChanged &&
    getDb()
      .select()
      .from(R)
      .where(and(eq(R.jobId, id), eq(R.status, "running")))
      .get()
  )
    throw new HttpError(409, "already_running", "Wait for this job to finish before changing its area");
  getDb()
    .update(J)
    .set({
      ...patch,
      ...(schedule ? { scheduleJson: JSON.stringify(schedule) } : {}),
      ...(areaChanged ? { sessionId: null } : {}),
      updatedAt: now.toISOString(),
    })
    .where(and(eq(J.id, id), eq(J.userId, user.id)))
    .run();
  mutation(user, "update", id, correlationId);
  return jobView(user, jobRow(user, id), now);
}
export function deleteJob(user: CurrentUser, id: string, correlationId: string) {
  jobRow(user, id);
  if (
    getDb()
      .select()
      .from(R)
      .where(and(eq(R.jobId, id), eq(R.status, "running")))
      .get()
  )
    throw new HttpError(409, "already_running", "Wait for this job to finish before deleting it");
  getDb()
    .delete(J)
    .where(and(eq(J.id, id), eq(J.userId, user.id)))
    .run();
  mutation(user, "delete", id, correlationId);
  return { ok: true };
}
export function exportJobs(user: CurrentUser, now = new Date()): JobsExport {
  return {
    version: 1,
    exportedAt: now.toISOString(),
    jobs: jobRows(user).map((r) => {
      const j = jobView(user, r, now);
      return { title: j.title, areaTitle: j.areaTitle, kind: j.kind, prompt: j.prompt, schedule: j.schedule, overnight: j.overnight };
    }),
  };
}
export function importJobs(user: CurrentUser, input: JobsExport, correlationId: string, now = new Date()) {
  assertAwayOwner(user);
  const body = jobsExportSchema.parse(input);
  const areas = listItems(user.id).filter((i) => i.kind === "area" && !i.parentId && !i.archived);
  const skipped: { title: string; reason: string }[] = [];
  let created = 0;
  getDb().transaction(() => {
    for (const { areaTitle, ...j } of body.jobs) {
      const match = areas.find((a) => a.title.toLowerCase() === areaTitle?.toLowerCase());
      const areaId = match && effectiveAutonomy(match) !== "off" ? match.id : null;
      if (jobRows(user).some((r) => r.title === j.title && r.areaId === areaId)) {
        skipped.push({ title: j.title, reason: "duplicate" });
        continue;
      }
      if (jobRows(user).length >= MAX_JOBS) {
        skipped.push({ title: j.title, reason: "too_many_jobs" });
        continue;
      }
      createJob(user, { ...j, areaId, enabled: false }, correlationId, now);
      created++;
      if (areaTitle && !match) skipped.push({ title: j.title, reason: "area not found" });
    }
    mutation(user, "import", user.id, correlationId);
  });
  return { created, skipped };
}
