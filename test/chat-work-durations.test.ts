import { describe, expect, it } from "vitest";
import { groupTimeline } from "@/components/chat/Conversation";
import { messagesToTimeline } from "@/integrations/hermes/normalize";
import type { TimelineItem } from "@/lib/hermes";
import type { HermesMessage } from "@/integrations/hermes/types";

const t = (sec: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, sec)).toISOString();
const tsec = (sec: number) => Date.UTC(2026, 9, 29, 12, 0, sec) / 1000;

describe("chat work summary durations (#67)", () => {
  it("normalize keeps the tool-call time as startedAt and the result time as at", () => {
    const messages = [
      { id: 1, role: "user", content: "go", timestamp: tsec(0) },
      { id: 2, role: "assistant", content: "", timestamp: tsec(1), tool_calls: [{ id: "c1", function: { name: "terminal", arguments: '{"command":"ls"}' } }] },
      { id: 3, role: "tool", content: "ok", timestamp: tsec(4), tool_call_id: "c1" },
    ] as unknown as HermesMessage[];
    const tool = messagesToTimeline(messages).find((x) => x.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", startedAt: t(1), at: t(4) });
  });

  it("measures each step from its call to its result, not from the previous step", () => {
    const items: TimelineItem[] = [
      { kind: "user", id: "u", text: "go", at: t(0) },
      { kind: "tool", id: "a", tool: "terminal", summary: "", startedAt: t(1), at: t(2) },
      { kind: "tool", id: "b", tool: "terminal", summary: "", startedAt: t(2), at: t(10) },
      { kind: "assistant", id: "r", text: "done", at: t(12) },
    ];
    const g = groupTimeline(items)[1] as { durations: (number | undefined)[]; seconds?: number };
    expect(g.durations).toEqual([1, 8]);
    expect(g.seconds).toBe(11);
  });

  it("a stopped turn ends at the last tool result, not at the next user message", () => {
    const items: TimelineItem[] = [
      { kind: "tool", id: "a", tool: "terminal", summary: "", startedAt: t(1), at: t(3) },
      { kind: "user", id: "u2", text: "later", at: t(50) },
    ];
    const g = groupTimeline(items)[0] as { durations: (number | undefined)[]; seconds?: number };
    expect(g.durations).toEqual([2]);
    expect(g.seconds).toBe(2);
  });

  it("rows without a call time get no per-step duration", () => {
    const g = groupTimeline([{ kind: "tool", id: "a", tool: "terminal", summary: "", at: t(3) }])[0] as { durations: (number | undefined)[] };
    expect(g.durations).toEqual([undefined]);
  });
});
