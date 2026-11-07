import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  dueSlot,
  effectiveAutonomy,
  inQuietHours,
  isSilentReport,
  nextRunAt,
  parseProposals,
  policyFor,
  PROPOSAL_INTENTS,
  quietEnd,
  scheduleSpecSchema,
  slotKey,
  type ProposalIntent,
} from "@/lib/away";
import { parseAreaSettings } from "@/lib/work";

const TZ = "America/Chicago";
const daily = (time: string) => scheduleSpecSchema.parse({ freq: "daily", time });

describe("schedule maths (America/Chicago)", () => {
  it("next run on an ordinary day", () => {
    expect(nextRunAt(daily("05:30"), new Date("2026-11-10T12:00:00Z"), TZ)?.toISOString()).toBe("2026-11-11T11:30:00.000Z");
  });
  it("fall-back day keeps the wall time (CST after 2026-11-01 02:00)", () => {
    // Before the change 05:30 CDT = 10:30Z; on Nov 1 05:30 CST = 11:30Z
    expect(nextRunAt(daily("05:30"), new Date("2026-10-31T12:00:00Z"), TZ)?.toISOString()).toBe("2026-11-01T11:30:00.000Z");
    expect(nextRunAt(daily("05:30"), new Date("2026-10-30T12:00:00Z"), TZ)?.toISOString()).toBe("2026-10-31T10:30:00.000Z");
  });
  it("spring-forward gap moves forward (02:30 → 03:30 CDT on 2027-03-14)", () => {
    expect(nextRunAt(daily("02:30"), new Date("2027-03-13T12:00:00Z"), TZ)?.toISOString()).toBe("2027-03-14T08:30:00.000Z");
  });
  it("weekdays skip the weekend; weekly picks the day", () => {
    // Fri 2026-11-13 18:00 CST → next weekday 07:30 is Mon 16th
    const wd = scheduleSpecSchema.parse({ freq: "weekdays", time: "07:30" });
    expect(nextRunAt(wd, new Date("2026-11-14T00:00:00Z"), TZ)?.toISOString()).toBe("2026-11-16T13:30:00.000Z");
    const fri = scheduleSpecSchema.parse({ freq: "weekly", time: "15:00", days: [5] });
    expect(nextRunAt(fri, new Date("2026-11-09T00:00:00Z"), TZ)?.toISOString()).toBe("2026-11-13T21:00:00.000Z");
    expect(describeSchedule(fri)).toBe("Fri 15:00");
  });
  it("weekly needs a day", () => {
    expect(scheduleSpecSchema.safeParse({ freq: "weekly", time: "10:00", days: [] }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ freq: "daily", time: "25:00" }).success).toBe(false);
  });
  it("due slot inside the grace window only; missed windows are skipped", () => {
    const s = daily("05:30");
    expect(dueSlot(s, new Date("2026-11-11T11:40:00Z"), TZ)?.toISOString()).toBe("2026-11-11T11:30:00.000Z");
    expect(dueSlot(s, new Date("2026-11-11T12:30:00Z"), TZ)).toBeNull();
    expect(dueSlot(s, new Date("2026-11-11T11:29:00Z"), TZ)).toBeNull();
    // just after local midnight: yesterday's 23:50 slot is still due
    expect(dueSlot(daily("23:50"), new Date("2026-11-11T06:05:00Z"), TZ)?.toISOString()).toBe("2026-11-11T05:50:00.000Z");
  });
  it("slot keys are stable per minute", () => {
    expect(slotKey(new Date("2026-11-11T11:30:00.000Z"))).toBe("2026-11-11T11:30Z");
  });
  it("quiet hours cross midnight and defer to their end", () => {
    const q = { enabled: true, start: "22:00", end: "07:00" };
    expect(inQuietHours(new Date("2026-11-11T11:30:00Z"), q, TZ)).toBe(true); // 05:30
    expect(inQuietHours(new Date("2026-11-11T14:00:00Z"), q, TZ)).toBe(false); // 08:00
    expect(quietEnd(new Date("2026-11-11T11:30:00Z"), q, TZ).toISOString()).toBe("2026-11-11T13:00:00.000Z");
    expect(quietEnd(new Date("2026-11-12T05:00:00Z"), q, TZ).toISOString()).toBe("2026-11-12T13:00:00.000Z"); // 23:00 → next 07:00
  });
});

describe("autonomy policy (#217)", () => {
  const area = (title: string, settings: Record<string, unknown> = {}) => ({ title, settings });
  it("defaults to propose; Finance and AI-excluded are forced off", () => {
    expect(parseAreaSettings(null).autonomy).toBe("propose");
    expect(effectiveAutonomy(area("Home"))).toBe("propose");
    expect(effectiveAutonomy(area("Home", { autonomy: "low_risk" }))).toBe("low_risk");
    expect(effectiveAutonomy(area("Finance", { autonomy: "low_risk" }))).toBe("off");
    expect(effectiveAutonomy(area("Financial planning", { autonomy: "low_risk" }))).toBe("off");
    expect(effectiveAutonomy({ title: "Money", systemKey: "finance", settings: { autonomy: "low_risk" } })).toBe("off");
    expect(effectiveAutonomy(area("Dev", { autonomy: "low_risk", aiPolicy: "excluded" }))).toBe("off");
    expect(effectiveAutonomy(area("Dev", { autonomy: "low_risk", aiPolicy: "triage_only" }))).toBe("propose");
  });
  it("matrix", () => {
    const low: ProposalIntent[] = ["create_note", "create_thread", "update_next_action", "file_to_inbox"];
    const never: ProposalIntent[] = ["merge", "deploy", "spend", "send_external"];
    for (const i of PROPOSAL_INTENTS) {
      expect(policyFor("off", i)).toBe("refuse");
      expect(policyFor("propose", i)).toBe(never.includes(i) ? "refuse" : "decision");
      expect(policyFor("low_risk", i)).toBe(never.includes(i) ? "refuse" : low.includes(i) ? "apply" : "decision");
    }
    for (const i of ["settle", "abandon", "supersede", "archive", "move"] as const) expect(policyFor("low_risk", i)).toBe("decision");
  });
});

describe("report parsing", () => {
  it("reads the last proposals block and drops invalid entries", () => {
    const out = [
      "Brief: 2 things.",
      "```jarvis-proposals",
      '[{"intent":"create_note","title":"a"},{"intent":"rm_rf"},{"intent":"settle","itemId":"wk_1","why":"quiet"}]',
      "```",
    ].join("\n");
    const r = parseProposals(out);
    expect(r.proposals.map((p) => p.intent)).toEqual(["create_note", "settle"]);
    expect(r.dropped).toBe(1);
    expect(r.report).toBe("Brief: 2 things.");
  });
  it("bad JSON never throws; NOTHING_NEW is silent", () => {
    expect(parseProposals("```jarvis-proposals\n{nope\n```").dropped).toBe(1);
    expect(parseProposals(null).proposals).toEqual([]);
    expect(isSilentReport("NOTHING_NEW", [])).toBe(true);
    expect(isSilentReport("NOTHING_NEW.", [{ intent: "create_note" }])).toBe(false);
  });
});
