// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccessProvider } from "@/components/access";
import { SkylightView } from "@/app/(shell)/skylight/SkylightView";
import { TodosView } from "@/app/(shell)/todos/TodosView";
import { skylightWriteVisual } from "@/e2e/fixtures/skylight";

const state = vi.hoisted(() => ({ sky: {} as ReturnType<typeof skylightWriteVisual> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/client/api", () => ({ api: { post: vi.fn(), get: vi.fn().mockResolvedValue({ timezone: "America/Chicago" }) } }));
vi.mock("@/components/useSource", () => ({
  useSource: (source: string) => ({
    isLoading: false,
    data: source === "skylight" ? state.sky : { data: { actions: [], extra: { provider: "google_tasks" } } },
  }),
}));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useOnline: () => true,
  useNow: () => Date.parse("2026-11-04T18:00:00Z"),
  useToast: () => ({ toast: vi.fn(), announce: vi.fn() }),
}));
function mount(node: React.ReactNode, capabilities = ["skylight.write"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["preferences"], { timezone: "America/Chicago" });
  return render(
    <QueryClientProvider client={qc}>
      <AccessProvider value={{ role: "admin", modules: [], capabilities }}>{node}</AccessProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.sky = skylightWriteVisual(new Date("2026-11-04T18:00:00Z"));
});
afterEach(cleanup);

function addOther() {
  state.sky.data.actions.push({
    ...state.sky.data.actions[0],
    id: "sky:other",
    sourceId: "other",
    title: "Other person's chore",
    assignee: { kind: "other", name: "Will" },
  });
}

it("defaults chores to Mine plus up-for-grabs; Everyone reveals other members", () => {
  addOther();
  mount(<SkylightView />);
  expect(screen.getByRole("radio", { name: "Mine" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText("Other person's chore")).toBeNull();
  expect(screen.getByRole("button", { name: /Claim: .*Visualsky fold the towels/ })).toBeDefined();
  fireEvent.click(screen.getByRole("radio", { name: "Everyone" }));
  expect(screen.getByText("Other person's chore")).toBeDefined();
});

it("defaults to Everyone when no household member is selected", () => {
  addOther();
  state.sky.data.extra.needsMember = true;
  mount(<SkylightView />);
  expect(screen.getByRole("radio", { name: "Everyone" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("Other person's chore")).toBeDefined();
  expect(screen.getByRole("link", { name: "Pick your member" })).toBeDefined();
});

it.each(["capability", "source"])("requires both write gates: no controls without %s", (gate) => {
  if (gate === "source") state.sky.data.extra.writable = false;
  mount(<SkylightView />, gate === "capability" ? [] : ["skylight.write"]);
  expect(screen.getByText("Read-only. Edit events and chores in Skylight.")).toBeDefined();
  expect(screen.queryByRole("checkbox", { name: /^Done:/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "New event" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Reopen:/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Claim:/ })).toBeNull();
  expect((screen.getByRole("checkbox", { name: "Visualsky oat milk" }) as HTMLInputElement).disabled).toBe(true);
});

it("separates overdue, today, future and newest-first completed rows with valid section ids", () => {
  state.sky.data.actions[0].priorityReason = "overdue";
  state.sky.data.actions[1].priorityReason = "due_soon";
  state.sky.data.actions[1].dueAt = "2026-11-05";
  state.sky.data.actions.push({ ...state.sky.data.actions[2], id: "sky:latest", title: "Newest done chore", updatedAt: "2026-11-04T19:00:00Z" });
  mount(<SkylightView />);
  expect(screen.getByRole("region", { name: /^Overdue/ }).textContent).toContain("Visualsky water the ferns");
  expect(document.getElementById("sk-upcoming")?.closest("section")?.textContent).toContain("Visualsky fold the towels");
  const done = screen.getByTestId("skylight-done");
  expect(within(done).getAllByRole("heading")[0].textContent).toBe("Newest done chore");
  for (const region of screen.getAllByRole("region")) expect(region.getAttribute("aria-labelledby")).not.toMatch(/\s/);
});

it("groups timed chores by household date rather than the UTC date prefix", () => {
  state.sky.data.actions[0].priorityReason = "due_soon";
  state.sky.data.actions[0].dueAt = "2026-11-05T01:00:00Z";
  state.sky.data.actions[0].dueIsDate = false;
  mount(<SkylightView />);
  expect(screen.getByRole("region", { name: /^Today/ }).textContent).toContain("Visualsky water the ferns");
});

it("shows a health failure alert and only offers event edits for editable events", () => {
  Object.assign(state.sky.data.extra.health, { ok: false, failed: ["lists", "events"] });
  state.sky.data.events[0].skylight.editable = false;
  mount(<SkylightView />);
  expect(screen.getByRole("alert").textContent).toBe("Skylight didn't return lists, events on the last sync — showing what it last returned.");
  expect(screen.queryByRole("button", { name: "Edit Visualsky family walk" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete Visualsky family walk" })).toBeNull();
});

it("Todos merges lists with their own source chips and the fixed-width Whose filter", () => {
  addOther();
  mount(<TodosView />);
  const whose = screen.getByRole("combobox", { name: "Whose" });
  expect(whose.parentElement?.className).toContain("w-36");
  expect(screen.queryByText("Other person's chore")).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Visualsky oat milk" })).toBeDefined();
  expect(screen.getAllByTestId("source-chip").some((chip) => chip.textContent === "Skylight · Visualsky Groceries")).toBe(true);
  fireEvent.change(whose, { target: { value: "everyone" } });
  expect(screen.getByText("Other person's chore")).toBeDefined();
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "Skylight · Visualsky Groceries" } });
  expect(screen.queryByText("Other person's chore")).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Visualsky paper towels" })).toBeDefined();
  expect(screen.queryByRole("checkbox", { name: /Done: .*Visualsky water the ferns/ })).toBeNull();
});
