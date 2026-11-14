/** PR A: the pinned Chief of staff thread (selection, smoke exclusion, pin persistence), paging, live decisions, questionnaires. */
import { beforeEach, describe, expect, it } from "vitest";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { coordinatorFor, coordinatorPin, pinCoordinatorThread } from "@/server/work/coordinator";
import { isOpsConversation, pickCoordinatorThread, visibleGroupCount, type ThreadCandidate } from "@/lib/coordinator/thread";
import { decisionRefOf, isQuestionnaire, questionnaireReply, smartDecisionRefs } from "@/lib/jarvis-ui/live";

const cid = "test-coord-thread";
const conv = (id: string, title: string, updatedAt: string, extra: Partial<ThreadCandidate> = {}): ThreadCandidate => ({
  id: `wk_${id}`,
  parentId: "area",
  kind: "conversation",
  sessionId: id,
  archived: false,
  title,
  updatedAt,
  ...extra,
});

describe("coordinator thread selection (pure)", () => {
  const owner = conv("api_owner", "Chief of staff", "2026-11-13T10:00:00Z");
  const smoke = conv("api_smoke", "zz-smoke 15:42 api_smoke", "2026-11-14T10:00:00Z");
  const later = conv("api_later", "What needs me?", "2026-11-14T09:00:00Z");

  it("never picks an ops/smoke chat, even when it is the newest", () => {
    expect(isOpsConversation(smoke)).toBe(true);
    expect(isOpsConversation({ title: "  ZZ-SMOKE x" })).toBe(true);
    expect(isOpsConversation(owner)).toBe(false);
    expect(pickCoordinatorThread([owner, smoke], "area", null)).toEqual({ item: owner, pinned: false });
    expect(pickCoordinatorThread([smoke], "area", null)).toEqual({ item: null, pinned: false });
  });

  it("the pin wins over newer chats; an archived or moved pin falls back to the rule", () => {
    expect(pickCoordinatorThread([owner, later, smoke], "area", "api_owner")).toEqual({ item: owner, pinned: true });
    expect(pickCoordinatorThread([owner, later, smoke], "area", null).item?.sessionId).toBe("api_later");
    expect(pickCoordinatorThread([{ ...owner, archived: true }, later], "area", "api_owner")).toEqual({ item: later, pinned: false });
    expect(pickCoordinatorThread([{ ...owner, parentId: "other" }, later], "area", "api_owner").item?.sessionId).toBe("api_later");
    // A pinned smoke chat is still honoured: the pin is the owner's explicit choice.
    expect(pickCoordinatorThread([owner, smoke], "area", "api_smoke")).toEqual({ item: smoke, pinned: true });
  });

  it("load earlier: first page, pages, and never pages the Since divider away", () => {
    expect(visibleGroupCount(5, 12)).toBe(5);
    expect(visibleGroupCount(40, 12)).toBe(12);
    expect(visibleGroupCount(40, 32)).toBe(32);
    expect(visibleGroupCount(40, 12, 10)).toBe(31);
    expect(visibleGroupCount(40, 12, 35)).toBe(12);
  });
});

describe("smart blocks that act through the conversation (pure)", () => {
  const card = (title: string) =>
    `Let's do it.\n\n\`\`\`jarvis-ui\n${JSON.stringify({
      v: 1,
      catalog: "jarvis-ui@1",
      root: "r",
      elements: {
        r: {
          type: "DecisionCard",
          props: {
            title,
            options: title.includes("Too few")
              ? []
              : [
                  { id: "a", label: "A" },
                  { id: "b", label: "B" },
                ],
          },
        },
      },
    })}\n\`\`\``;
  it("finds the D-n a decision card draws", () => {
    expect(decisionRefOf("D-33 · Schedule dentist appointment")).toBe("D-33");
    expect(decisionRefOf("Pick a colour")).toBeNull();
    expect(smartDecisionRefs(card("D-33 · Dentist"))).toEqual(["D-33"]);
    expect(smartDecisionRefs(card("Pick one"))).toEqual([]);
    // An invalid card (fewer than two options) isn't drawn, so it doesn't count.
    expect(smartDecisionRefs(card("D-34 · Too few"))).toEqual([]);
    expect(smartDecisionRefs("D-33 in prose only")).toEqual([]);
    expect(smartDecisionRefs("```jarvis-ui\n{not json\n```")).toEqual([]);
    // Nested cards are only drawn live by the smart renderer; with Smart replies off only a root card counts.
    const nested = `\`\`\`jarvis-ui\n${JSON.stringify({
      v: 1,
      catalog: "jarvis-ui@1",
      root: "s",
      elements: {
        s: { type: "Stack", props: {}, children: ["c"] },
        c: {
          type: "DecisionCard",
          props: {
            title: "D-9 · x",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        },
      },
    })}\n\`\`\``;
    expect(smartDecisionRefs(nested)).toEqual(["D-9"]);
    expect(smartDecisionRefs(nested, { rootOnly: true })).toEqual([]);
    expect(smartDecisionRefs(card("D-33 · Dentist"), { rootOnly: true })).toEqual(["D-33"]);
  });

  it("a form that writes nothing is a questionnaire, answered as one reply", () => {
    const form = {
      title: "Daily Compass check-in",
      fields: [
        { id: "today", label: "How did today go?", kind: "textarea" as const, required: true },
        { id: "energy", label: "How's your energy?", kind: "choice" as const, options: [{ value: "medium", label: "Medium" }] },
        { id: "walk", label: "Walked?", kind: "toggle" as const },
        { id: "skip", label: "Optional", kind: "text" as const },
      ],
      submit: { label: "Submit check-in" },
    };
    expect(isQuestionnaire(form)).toBe(true);
    expect(isQuestionnaire({ submit: { label: "x", creates: [{ titleField: "today" } as never] } })).toBe(false);
    // Never cut: the form refuses an over-long reply instead (QUESTIONNAIRE_MAX).
    expect(questionnaireReply(form, { today: "x".repeat(9000) }).length).toBeGreaterThan(9000);
    expect(questionnaireReply(form, { today: "Good day", energy: "medium", walk: true, skip: "" })).toBe(
      "**Daily Compass check-in**\n\n**How did today go?**\nGood day\n\n**How's your energy?**\nMedium\n\n**Walked?**\nYes",
    );
  });
});

describe("coordinator pin (server)", () => {
  let owner: string;
  beforeEach(() => {
    __setTestDatabase();
    owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  });
  const userOf = (id: string) => resolveUser(new Headers(), createSession(id).token)!;
  const addConv = (userId: string, parentId: string, sessionId: string, title: string, updatedAt: string) =>
    getDb()
      .insert(schema.workItems)
      .values({ id: `wk_${sessionId}`, userId, parentId, kind: "conversation", title, sessionId, status: "in_progress", updatedAt, createdAt: updatedAt })
      .run();

  it("a pinned thread persists; new chats and smoke chats under the area don't take over; unpin falls back", () => {
    const u = userOf(owner);
    const area = store.createItem(u, { kind: "area", title: "Portfolio" }, cid);
    addConv(owner, area.id, "api_owner", "Chief of staff", "2026-11-13T10:00:00.000Z");
    expect(coordinatorFor(u, area.id)).toMatchObject({ sessionId: "api_owner", pinned: false });
    // A smoke chat is never picked by the rule.
    addConv(owner, area.id, "api_smoke", "zz-smoke 15:42 api_smoke", "2026-11-14T10:00:00.000Z");
    expect(coordinatorFor(u, area.id).sessionId).toBe("api_owner");

    const r = pinCoordinatorThread(u, area.id, "api_owner", cid);
    expect(r).toMatchObject({ sessionId: "api_owner", pinned: true, previous: null });
    expect(coordinatorPin(area.id)).toBe("api_owner");
    // A newer ordinary chat filed under the area doesn't change the pinned thread.
    addConv(owner, area.id, "api_new", "Something else", "2026-11-14T11:00:00.000Z");
    expect(coordinatorFor(u, area.id)).toMatchObject({ sessionId: "api_owner", pinned: true });

    // Switching returns the previous pin (Undo pins it again).
    expect(pinCoordinatorThread(u, area.id, "api_new", cid).previous).toBe("api_owner");
    expect(coordinatorFor(u, area.id).sessionId).toBe("api_new");
    pinCoordinatorThread(u, area.id, "api_owner", cid);
    expect(coordinatorFor(u, area.id).sessionId).toBe("api_owner");

    // Unpinned: back to the rule (newest non-smoke).
    pinCoordinatorThread(u, area.id, null, cid);
    expect(coordinatorFor(u, area.id)).toMatchObject({ sessionId: "api_new", pinned: false });
    const audits = getDb()
      .select()
      .from(schema.auditLog)
      .all()
      .filter((a) => a.action === "coordinator.pin");
    expect(audits.length).toBe(4);
  });

  it("refuses conversations outside the area and AI-excluded areas", () => {
    const u = userOf(owner);
    const area = store.createItem(u, { kind: "area", title: "Portfolio" }, cid);
    const other = store.createItem(u, { kind: "area", title: "Finance" }, cid);
    addConv(owner, other.id, "api_fin", "Budget", "2026-11-13T10:00:00.000Z");
    expect(() => pinCoordinatorThread(u, area.id, "api_fin", cid)).toThrow(/isn't filed in this area/);
    store.updateItem(u, other.id, { settings: { aiPolicy: "excluded" } }, cid);
    expect(() => pinCoordinatorThread(u, other.id, "api_fin", cid)).toThrow(/excluded/);
    expect(() => pinCoordinatorThread(u, "wk_nope", null, cid)).toThrow(/isn't here/);
  });
});
