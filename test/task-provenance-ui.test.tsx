// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TodosView } from "@/app/(shell)/todos/TodosView";
import { ToastProvider } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { NextAction } from "@/lib/contracts";

vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => false }) }));
vi.mock("@/components/skylight/useSkylightWrite", () => ({ useSkylightWrite: () => ({ node: null }) }));
vi.mock("@/components/actions/ActionCard", () => ({ ActionCard: ({ action }: { action: NextAction }) => <div>{action.title}</div> }));
vi.mock("@/components/useSource", () => ({
  useSource: (source: string) => ({
    data: { status: { source, state: "ok" }, data: { actions: source === "todos" ? actions : [], extra: { provider: "jarvis" } } },
    isLoading: false,
  }),
}));
const action = (id: string, provenance?: NextAction["provenance"]): NextAction => ({
  id,
  sourceId: id,
  source: "todos",
  title: id,
  status: "open",
  priorityReason: "upcoming",
  href: "/todos",
  updatedAt: "",
  fetchedAt: "",
  staleAfter: "",
  provenance,
});
const actions = [
  action("Agent-created task", { via: "agent:devchief", agent: "devchief" }),
  action("Person-created task"),
  action("Untrusted display hint", { via: "user", agent: "devchief" }),
];
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

it("shows the AI segment and recorded creator chip, filters and persists the segment in the URL", async () => {
  vi.spyOn(api, "get").mockResolvedValue({ timezone: "UTC" });
  window.history.replaceState(null, "", "/todos");
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TodosView />
      </ToastProvider>
    </QueryClientProvider>,
  );
  expect(screen.getAllByText("by @devchief")).toHaveLength(1);
  expect(screen.getByText("by @devchief").className).toContain("jv-agent-chip");
  const segments = within(screen.getByRole("radiogroup", { name: "Tasks segment" }));
  expect(segments.getAllByRole("radio").map((el) => el.textContent)).toEqual(["All", "Mine", "AI", "Waiting"]);
  fireEvent.click(segments.getByRole("radio", { name: "AI" }));
  expect(window.location.search).toBe("?seg=ai");
  expect(segments.getByRole("radio", { name: "AI" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("Agent-created task")).toBeTruthy();
  expect(screen.queryByText("Person-created task")).toBeNull();
  expect(screen.queryByText("Untrusted display hint")).toBeNull();
  fireEvent.click(segments.getByRole("radio", { name: "All" }));
  expect(window.location.search).toBe("");
  expect(screen.getByText("Person-created task")).toBeTruthy();
});
