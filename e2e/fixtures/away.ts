import type { AwayDigest, AwayRun, ScheduledJob } from "../../lib/away";
import { SUGGESTED_TEMPLATES } from "../../lib/away";
import { localTimeToInstant } from "../../lib/time";
import type { SchedulesResponse } from "../../lib/client/away";

export function schedulesFixture(date = "2026-11-07"): SchedulesResponse {
  const at = (time: string) => localTimeToInstant(date, time, "America/Chicago").toISOString();
  const base: ScheduledJob = {
    id: "job_lantern",
    title: "Lantern morning check",
    areaId: "area_lantern",
    areaTitle: "Lantern workshop",
    kind: "brief",
    prompt: "Overnight check SCHEDULED_PROPOSALS",
    schedule: { freq: "daily", time: "08:30", days: [] },
    overnight: false,
    enabled: true,
    templateKey: null,
    tz: "America/Chicago",
    nextRunAt: at("08:30"),
    lastRunAt: at("07:30"),
    lastStatus: "ok",
    lastError: null,
    consecutiveFailures: 0,
    autonomy: "low_risk",
    createdAt: at("06:00"),
    updatedAt: at("07:30"),
  };
  return {
    jobs: [
      ...SUGGESTED_TEMPLATES.map((template, i) => ({
        ...base,
        ...template,
        id: `template_${i}`,
        templateKey: template.key,
        areaId: null,
        areaTitle: null,
        enabled: false,
        autonomy: "propose" as const,
        lastStatus: "never" as const,
        lastRunAt: null,
        nextRunAt: null,
      })),
      base,
    ],
    tz: "America/Chicago",
    caps: { maxJobs: 12, maxRunsPerDay: 6, runsToday: 3 },
    areas: [
      { id: "area_lantern", title: "Lantern workshop", autonomy: "low_risk" },
      { id: "area_finance", title: "Finance", autonomy: "off" },
    ],
  };
}

export function awayFixture(date = "2026-11-07"): AwayDigest {
  const at = (time: string) => localTimeToInstant(date, time, "America/Chicago").toISOString();
  const run: AwayRun = {
    id: "run_lantern",
    jobId: "job_lantern",
    jobTitle: "Lantern morning check",
    areaId: "area_lantern",
    areaTitle: "Lantern workshop",
    slot: "manual:fixture",
    manual: true,
    status: "done",
    silent: false,
    waiting: false,
    startedAt: at("08:00"),
    finishedAt: at("08:02"),
    summary: "Prepared the workshop notes. One next step needs your decision.",
    error: null,
    sessionId: "sess_lantern",
    agentRunId: "agent_lantern",
    profile: "devchief",
    changes: [{ intent: "create_note", label: "Added workshop notes", itemId: "note_lantern", itemTitle: "Workshop notes" }],
    decisions: [{ itemId: "area_lantern", itemTitle: "Lantern workshop", question: "Ready to settle the workshop?", open: true }],
    refused: [{ intent: "deploy", label: "Jarvis never deploys" }],
  };
  return {
    runs: [
      run,
      { ...run, id: "run_silent", jobTitle: "Inbox watch", startedAt: at("07:00"), silent: true, summary: null, changes: [], decisions: [], refused: [] },
      {
        ...run,
        id: "run_failed",
        jobTitle: "Weekly review prep",
        startedAt: at("06:00"),
        status: "failed",
        error: "Hermes couldn't finish. Try again later.",
        changes: [],
        decisions: [],
        refused: [],
      },
    ],
    since: null,
    counts: { ran: 3, failed: 1, changes: 1, needsYou: 1, running: 0, waiting: 0 },
    line: "While you were away: 3 ran · 1 change · 1 needs you",
  };
}
