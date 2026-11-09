import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { raiseDecision } from "@/server/work/decision-store";
import { registerAgentRun, finishRegisteredRun } from "@/server/work/registered-runs";
import { decisionDigest, DIGEST_EVERY_MS } from "@/server/work/cw-push";
import { coordLink } from "@/lib/coordinator/links";

const cid = "test";
let owner: CurrentUser;
let itemId: string;
const notes = (type: string) =>
  getDb()
    .select()
    .from(schema.notifications)
    .all()
    .filter((n) => n.type === type);

beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
  const area = store.createItem(owner, { parentId: null, kind: "area", title: "Area push" }, cid);
  itemId = store.createItem(owner, { parentId: area.id, kind: "thread", title: "Push things" }, cid).id;
});

describe("CW-5 push", () => {
  it("deep links only carry valid refs", () => {
    expect(coordLink({ coord: "needs", d: "D-48" })).toBe("/home?coord=needs&d=D-48");
    expect(coordLink({ coord: "running", r: "R-7" })).toBe("/home?coord=running&r=R-7");
    expect(coordLink({ coord: "needs", d: "D-1&x=1" })).toBe("/home?coord=needs");
  });

  it("risk-flagged or blocking decisions push at once (deep link to the detail); low-risk ones wait for the digest", () => {
    raiseDecision(
      owner.id,
      itemId,
      { question: "Rotate the key?", choices: ["Rotate", "Keep"], risk: ["credential"] },
      { raisedBy: "agent:x", correlationId: cid },
    );
    raiseDecision(
      owner.id,
      itemId,
      { question: "Merge #252 first?", choices: ["Yes"], pack: { unblocks: ["#252"] } },
      { raisedBy: "agent:x", correlationId: cid },
    );
    raiseDecision(owner.id, itemId, { question: "Rename the board?", choices: ["Yes", "No"] }, { raisedBy: "agent:x", correlationId: cid });
    const urgent = notes("cw.decision");
    expect(urgent.map((n) => n.deepLink).sort()).toEqual(["/home?coord=needs&d=D-1", "/home?coord=needs&d=D-2"]);
    expect(urgent.find((n) => n.deepLink.endsWith("D-1"))).toMatchObject({ severity: "high", title: "D-1 needs you", category: "hermes_input" });
    // Digest: only the non-urgent one, once per 2 h window.
    const now = new Date();
    expect(decisionDigest(now).sent).toBe(1);
    expect(notes("cw.decision_digest")).toHaveLength(1);
    expect(notes("cw.decision_digest")[0]).toMatchObject({ body: "D-3", deepLink: "/home?coord=needs" });
    expect(decisionDigest(new Date(now.getTime() + 60_000)).sent).toBe(0);
    raiseDecision(owner.id, itemId, { question: "Another small one?" }, { raisedBy: "agent:x", correlationId: cid });
    expect(decisionDigest(new Date(Date.now() + DIGEST_EVERY_MS + 1_000)).sent).toBe(1);
  });

  it("credential-flagged questions never leave Jarvis in a push body", () => {
    raiseDecision(owner.id, itemId, { question: "Use password hunter2 for the db?", risk: ["credential"] }, { raisedBy: "agent:x", correlationId: cid });
    expect(notes("cw.decision")[0]?.body).toBe("Open Jarvis to see the question.");
  });

  it("a failed run pushes with an R-n deep link; an interrupted one pushes Resume all; done never pushes", () => {
    const a = registerAgentRun(owner, "devchief", { itemId, title: "Hotfix chat send" }, cid);
    const b = registerAgentRun(owner, "devchief", { itemId, title: "Lane 2" }, cid);
    const c = registerAgentRun(owner, "devchief", { itemId, title: "Lane 3" }, cid);
    finishRegisteredRun(owner, a.runId, "failed", "e2e red", new Date());
    finishRegisteredRun(owner, b.runId, "interrupted", "session ended", new Date());
    finishRegisteredRun(owner, c.runId, "done", "ok", new Date());
    expect(notes("cw.run_failed").map((n) => n.deepLink)).toEqual([`/home?coord=running&r=${a.ref}`]);
    expect(notes("cw.session_ended")[0]).toMatchObject({ deepLink: "/home?coord=running&f=interrupted", body: "Resume all 1 from Running." });
    expect(getDb().select().from(schema.notifications).where(eq(schema.notifications.type, "cw.run_done")).all()).toHaveLength(0);
  });
});
