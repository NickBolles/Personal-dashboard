import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { todosAdapter } from "@/integrations/todos/adapter";
import { HomeAssistantClient } from "@/integrations/home-assistant/client";
import { selectAttention } from "@/server/ranking/attention";
import { addDays, localDate, startOfLocalDay } from "@/lib/time";

vi.mock("@/integrations/store", () => ({ resolveIntegration: () => ({ config: { provider: "home_assistant", haEntityId: "todo.test" } }) }));
vi.mock("@/server/settings", () => ({ getPreferences: () => ({ timezone: "America/Chicago" }) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn() }));
vi.mock("@/integrations/home-assistant/client", () => ({
  haConn: () => ({ baseUrl: "http://fixture.invalid" }),
  HomeAssistantClient: { todoItems: vi.fn(), callService: vi.fn() },
}));
const item = { uid: "one", summary: "DST task", status: "needs_action" as const };
const opts = { until: "2026-10-20", actor: "test", correlationId: "test" };
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

it.each([
  ["2026-03-08T05:30:00Z", "2026-03-08"], // Mar 7 23:30: +24h skips Mar 8
  ["2026-11-01T05:30:00Z", "2026-11-02"], // Nov 1 00:30: +24h remains Nov 1
])("default snooze advances a household calendar day across DST at %s", async (instant, due) => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(instant));
  vi.mocked(HomeAssistantClient.todoItems).mockResolvedValue([{ ...item, due }]);
  await expect(todosAdapter.act!("one", "snooze", { actor: "test", correlationId: "test" })).resolves.toEqual({ ok: true, message: "Snoozed" });
  expect(HomeAssistantClient.callService).toHaveBeenCalledExactlyOnceWith(expect.anything(), "todo", "update_item", {
    entity_id: "todo.test",
    item: "one",
    due_date: due,
  });
});

it.each([
  ["2026-03-08", "2026-03-09T04:59:00.000Z"],
  ["2026-11-01", "2026-11-02T05:59:00.000Z"],
])("preserves %s through the actual todo adapter and cached attention selector", async (due, expectedInstant) => {
  vi.mocked(HomeAssistantClient.todoItems).mockResolvedValue([{ ...item, due }]);
  const timezone = "America/Chicago";
  const now = new Date(`${due}T18:00:00Z`);
  const { actions } = await todosAdapter.fetch({ now, timezone, today: due, endOfToday: startOfLocalDay(addDays(due, 1), timezone) });
  const sameDay = selectAttention({ actions, now, timezone });
  expect(sameDay.now[0]).toMatchObject({ priorityReason: "today", why: ["Due today"], rank: { tier: "today" } });
  expect(sameDay.totals.overdue).toBe(0);
  expect(actions[0].dueAt).toBe(expectedInstant);
  expect(localDate(new Date(actions[0].dueAt!), timezone)).toBe(due);
  const nextDay = selectAttention({ actions, now: startOfLocalDay(addDays(due, 1), timezone), timezone });
  expect(nextDay.now[0]).toMatchObject({ priorityReason: "overdue", why: ["Due yesterday"], rank: { tier: "overdue_recent" } });
  expect(nextDay.totals.overdue).toBe(1);
  expect(actions[0].priorityReason).toBe("today");
});

it.each(["2026-10-01", undefined, "2026-10-20T12:00:00Z"])("does not verify a HA date-only snooze from readback %s", async (due) => {
  vi.mocked(HomeAssistantClient.todoItems).mockResolvedValue([{ ...item, due }]);
  await expect(todosAdapter.act!("one", "snooze", opts)).rejects.toThrow("Home Assistant did not confirm the new due date");
  expect(HomeAssistantClient.callService).toHaveBeenCalledExactlyOnceWith(expect.anything(), "todo", "update_item", {
    entity_id: "todo.test",
    item: "one",
    due_date: "2026-10-20",
  });
});

it("verifies the exact date and keeps completion readback checks", async () => {
  vi.mocked(HomeAssistantClient.todoItems).mockResolvedValue([{ ...item, due: opts.until }]);
  await expect(todosAdapter.act!("one", "snooze", opts)).resolves.toEqual({ ok: true, message: "Snoozed" });
  await expect(todosAdapter.act!("one", "complete", opts)).rejects.toThrow("Home Assistant did not confirm completion");
  vi.mocked(HomeAssistantClient.todoItems).mockResolvedValue([{ ...item, status: "completed" }]);
  await expect(todosAdapter.act!("one", "complete", opts)).resolves.toEqual({ ok: true, message: "Marked done" });
});

it("does not retry a successful write when readback fails or the item disappears", async () => {
  vi.mocked(HomeAssistantClient.todoItems).mockRejectedValueOnce(new Error("Readback unavailable")).mockResolvedValueOnce([]);
  await expect(todosAdapter.act!("one", "snooze", opts)).rejects.toThrow("Readback unavailable");
  expect(HomeAssistantClient.callService).toHaveBeenCalledTimes(1);
  await expect(todosAdapter.act!("one", "snooze", opts)).rejects.toThrow("Item disappeared");
  expect(HomeAssistantClient.callService).toHaveBeenCalledTimes(2);
});
