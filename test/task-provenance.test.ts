import { beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { currentVia, withVia } from "@/server/work/actor";
import { createLocalTodo, listTodos, todosAdapter } from "@/integrations/todos/adapter";
import { taskInSegment } from "@/lib/task-segments";

const config = vi.hoisted(() => ({ provider: "jarvis", haEntityId: "todo.fixture" }));
vi.mock("@/integrations/store", () => ({ resolveIntegration: () => ({ config }) }));
vi.mock("@/integrations/home-assistant/client", () => ({
  haConn: () => ({ baseUrl: "http://fixture.invalid" }),
  HomeAssistantClient: { todoItems: async () => [{ uid: "external", summary: "External task", status: "needs_action" }] },
}));

const ctx = { now: new Date("2026-11-07T12:00:00Z"), today: "2026-11-07", timezone: "UTC", endOfToday: new Date("2026-11-08T00:00:00Z") };

beforeEach(() => {
  __setTestDatabase();
  config.provider = "jarvis";
});

it("stamps the current profile at the single local creation path and maps it through the source API", async () => {
  const id = withVia("agent:devchief", () => createLocalTodo({ title: "Agent task" }));
  expect(getDb().select().from(schema.localTodos).where(eq(schema.localTodos.id, id)).get()?.createdVia).toBe("agent:devchief");
  expect(currentVia()).toBeNull();
  expect((await listTodos(ctx))[0].provenance).toEqual({ via: "agent:devchief", agent: "devchief" });
  const { actions } = await todosAdapter.fetch(ctx);
  expect(actions[0].provenance).toEqual({ via: "agent:devchief", agent: "devchief" });
  expect(taskInSegment(actions[0], "ai")).toBe(true);
});

it("keeps legacy and person-created tasks unattributed, even when read by an agent", async () => {
  getDb().insert(schema.localTodos).values({ id: "legacy", title: "Before migration" }).run();
  const id = createLocalTodo({ title: "Person task" });
  expect(getDb().select().from(schema.localTodos).where(eq(schema.localTodos.id, id)).get()?.createdVia).toBeNull();
  const { actions } = await withVia("agent:reader", () => todosAdapter.fetch(ctx));
  expect(actions).toHaveLength(2);
  for (const action of actions) {
    expect(action.provenance).toBeUndefined();
    expect(taskInSegment(action, "ai")).toBe(false);
  }
});

it("does not mix profiles across concurrent creation or infer provenance for external tasks", async () => {
  await Promise.all(
    ["devchief", "homelabchief"].map((profile) =>
      withVia(`agent:${profile}`, async () => {
        await Promise.resolve();
        createLocalTodo({ title: profile });
      }),
    ),
  );
  const items = await listTodos(ctx);
  for (const item of items) expect(item.provenance).toEqual({ via: `agent:${item.title}`, agent: item.title });
  config.provider = "home_assistant";
  const { actions } = await withVia("agent:devchief", () => todosAdapter.fetch(ctx));
  expect(actions[0].provenance).toBeUndefined();
  expect(taskInSegment(actions[0], "ai")).toBe(false);
});
