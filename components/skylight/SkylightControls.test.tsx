// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NextAction } from "@/lib/contracts";
import { AccessProvider } from "@/components/access";
import { api } from "@/lib/client/api";
import { ActionCard } from "@/components/actions/ActionCard";
import { EventForm } from "./EventForm";
import { SkylightActionRow } from "./SkylightActionRow";
import { SkylightListCard } from "./SkylightListCard";

const state = vi.hoisted(() => ({ online: true, toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/client/api", () => ({ api: { post: vi.fn() } }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useOnline: () => state.online,
  useToast: () => ({ toast: state.toast, announce: vi.fn() }),
}));
const action: NextAction = {
  id: "sky:chore",
  source: "skylight",
  sourceId: "chore",
  title: "Water the fern",
  detail: "Nick",
  status: "open",
  priorityReason: "today",
  href: "/skylight",
  fetchedAt: "2026-11-01T12:00:00Z",
  staleAfter: "2099-11-02T12:00:00Z",
  updatedAt: "2026-11-01T12:00:00Z",
  primaryAction: { kind: "open", label: "Open Skylight" },
  skylight: { kind: "chore", choreId: "chore", categoryId: null },
  assignee: { kind: "up_for_grabs" },
};
function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <AccessProvider value={{ role: "admin", modules: [], capabilities: [] }}>{node}</AccessProvider>
      </QueryClientProvider>,
    ),
  };
}
beforeEach(() => {
  state.online = true;
  vi.mocked(api.post).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("round chore checkbox delegates completion instead of calling /api/actions", () => {
  const request = vi.fn();
  mount(<SkylightActionRow action={action} writable request={request} management />);
  fireEvent.click(screen.getByRole("checkbox", { name: `Done: ${action.title}` }));
  expect(request).toHaveBeenCalledWith({ op: "chore.complete", title: action.title, choreId: "chore", categoryId: null });
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: /Open Skylight/ })).toBeNull();
});

it("completion override applies to the ActionCard menu too", () => {
  const onComplete = vi.fn();
  mount(<ActionCard action={{ ...action, secondaryActions: ["complete"] }} row onComplete={onComplete} />);
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${action.title}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
  expect(onComplete).toHaveBeenCalledOnce();
  expect(api.post).not.toHaveBeenCalled();
});

it("preserves the normal ActionCard completion path when no override is given", async () => {
  vi.mocked(api.post).mockResolvedValue({ message: "Done" });
  mount(<ActionCard action={{ ...action, source: "todos", primaryAction: { kind: "complete", label: "Done" } }} row />);
  fireEvent.click(screen.getByRole("checkbox", { name: `Done: ${action.title}` }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/actions", { actionId: action.id, kind: "complete" }));
});

it("keeps read-only Skylight rows free of write controls and suppresses recurring claims", () => {
  const view = mount(<SkylightActionRow action={action} writable={false} request={vi.fn()} management />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Claim:/ })).toBeNull();
  view.unmount();
  mount(
    <SkylightActionRow
      action={{ ...action, skylight: { kind: "chore", choreId: "chore", categoryId: null, recurring: true } }}
      writable
      request={vi.fn()}
      management
    />,
  );
  expect(screen.queryByRole("button", { name: /^Claim:/ })).toBeNull();
});

it("claims a nonrecurring up-for-grabs chore and reopens a completed chore", () => {
  const request = vi.fn();
  const view = mount(<SkylightActionRow action={action} writable request={request} management />);
  fireEvent.click(screen.getByRole("button", { name: `Claim: ${action.title}` }));
  expect(request).toHaveBeenCalledWith({ op: "chore.claim", choreId: "chore", title: action.title, fromCategoryId: null });
  view.unmount();
  mount(<SkylightActionRow action={{ ...action, status: "completed" }} writable request={request} management />);
  fireEvent.click(screen.getByRole("button", { name: `Reopen: ${action.title}` }));
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ op: "chore.reopen" }));
});

it("lists show pending before completed, limit done to five, and confirm before changing checks", () => {
  const request = vi.fn();
  const item = (title: string, completed: boolean): NextAction => ({
    ...action,
    id: title,
    title,
    status: completed ? "completed" : "open",
    skylight: { kind: "list_item", listId: "7001", listLabel: "Groceries", itemId: title },
  });
  mount(
    <SkylightListCard
      list={{ id: "7001", label: "Groceries", kind: "grocery" }}
      items={[...Array.from({ length: 7 }, (_, i) => item(`Done ${i}`, true)), item("Oat milk", false)]}
      writable
      request={request}
    />,
  );
  expect(screen.getAllByRole("checkbox")).toHaveLength(6);
  expect(screen.getAllByRole("checkbox")[0].getAttribute("aria-label")).toBe("Oat milk");
  fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(8);
  const oat = screen.getByRole("checkbox", { name: "Oat milk" }) as HTMLInputElement;
  fireEvent.click(oat);
  expect(oat.checked).toBe(false);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: "list.check", label: "Oat milk", listId: "7001" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Add to Groceries" }), { target: { value: "  Skywrite lemons  " } });
  fireEvent.submit(screen.getByRole("button", { name: "Add" }).closest("form")!);
  expect(request).toHaveBeenLastCalledWith({ op: "list.add", label: "Skywrite lemons", listId: "7001", listLabel: "Groceries" });
});

it("completed list rows request uncheck, not chore completion", () => {
  const request = vi.fn();
  mount(
    <SkylightActionRow
      action={{
        ...action,
        title: "Paper towels",
        status: "completed",
        skylight: { kind: "list_item", listId: "7001", listLabel: "Groceries", itemId: "paper" },
      }}
      writable
      request={request}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Paper towels" }));
  expect(request).toHaveBeenCalledWith({ op: "list.uncheck", label: "Paper towels", listId: "7001", listLabel: "Groceries", itemId: "paper" });
  expect(api.post).not.toHaveBeenCalled();
});

it("event form validates ordering and creates offset ISO fields in household time", () => {
  const onSubmit = vi.fn();
  mount(<EventForm timezone="America/Chicago" onClose={vi.fn()} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Lantern walk" } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-01" } });
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: "17:00" } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "16:00" } });
  fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
  expect(screen.getByRole("alert").textContent).toBe("End must be after start.");
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "18:00" } });
  fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
  expect(onSubmit).toHaveBeenCalledWith({
    op: "event.create",
    event: {
      summary: "Lantern walk",
      allDay: false,
      startsAt: "2026-11-01T17:00:00-06:00",
      endsAt: "2026-11-01T18:00:00-06:00",
      location: null,
      description: null,
    },
  });
});

it("all-day form creates dates with a next-day exclusive end and no time controls", () => {
  const onSubmit = vi.fn();
  mount(<EventForm timezone="America/Chicago" onClose={vi.fn()} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Family day" } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-30" } });
  fireEvent.click(screen.getByLabelText("All day"));
  expect(screen.queryByLabelText("Start")).toBeNull();
  fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ event: expect.objectContaining({ allDay: true, startsAt: "2026-11-30", endsAt: "2026-12-01" }) }),
  );
});

it("event edits prefill household time and preserve the previous fields and description", () => {
  const onSubmit = vi.fn();
  const event = {
    id: "sky:event",
    source: "skylight" as const,
    title: "Lantern walk",
    startsAt: "2026-11-01T23:00:00Z",
    endsAt: "2026-11-02T00:00:00Z",
    allDay: false,
    location: "Park",
    skylight: { eventId: "event", editable: true, description: "Bring a lantern" },
  };
  mount(<EventForm event={event} timezone="America/Chicago" onClose={vi.fn()} onSubmit={onSubmit} />);
  expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("17:00");
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Lantern stroll" } });
  fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
  expect(onSubmit).toHaveBeenCalledWith({
    op: "event.update",
    eventId: "event",
    event: {
      summary: "Lantern stroll",
      startsAt: "2026-11-01T17:00:00-06:00",
      endsAt: "2026-11-01T18:00:00-06:00",
      allDay: false,
      location: "Park",
      description: "Bring a lantern",
    },
    previous: { summary: "Lantern walk", startsAt: event.startsAt, endsAt: event.endsAt, allDay: false, location: "Park", description: "Bring a lantern" },
  });
});

it("event form keeps focus and typed values across parent rerenders", () => {
  const onSubmit = vi.fn();
  const view = mount(<EventForm timezone="America/Chicago" onClose={() => {}} onSubmit={onSubmit} />);
  const location = screen.getByLabelText("Location");
  act(() => location.focus());
  fireEvent.change(location, { target: { value: "Trailhead" } });
  view.rerender(
    <QueryClientProvider client={view.qc}>
      <AccessProvider value={{ role: "admin", modules: [], capabilities: [] }}>
        <EventForm timezone="America/Chicago" onClose={() => {}} onSubmit={onSubmit} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  expect(document.activeElement).toBe(location);
  expect((location as HTMLInputElement).value).toBe("Trailhead");
});

it.each([
  ["multi-day timed", false, "2026-11-29T17:00:00-06:00", "2026-12-01T18:00:00-06:00", "2026-12-02T18:00:00-06:00"],
  ["overnight", false, "2026-11-29T23:00:00-06:00", "2026-11-30T01:00:00-06:00", "2026-12-01T01:00:00-06:00"],
  ["all-day multi-day", true, "2026-11-29", "2026-12-02", "2026-12-03"],
])("moving a %s event preserves its end date and wall time", (_label, allDay, startsAt, endsAt, expectedEnd) => {
  const onSubmit = vi.fn();
  const event = { id: "sky:event", source: "skylight" as const, title: "Trip", startsAt, endsAt, allDay, skylight: { eventId: "event", editable: true } };
  mount(<EventForm event={event} timezone="America/Chicago" onClose={vi.fn()} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-30" } });
  if (!allDay) expect((screen.getByLabelText("End date") as HTMLInputElement).value).toBe(expectedEnd.slice(0, 10));
  fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ op: "event.update", event: expect.objectContaining({ endsAt: expectedEnd }) }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clearing Date before picking a new one still shifts a multi-day end (#209)", () => {
  const onSubmit = vi.fn();
  const event = {
    id: "sky:event",
    source: "skylight" as const,
    title: "Trip",
    startsAt: "2026-11-29T17:00:00-06:00",
    endsAt: "2026-12-01T18:00:00-06:00",
    allDay: false,
    skylight: { eventId: "event", editable: true },
  };
  mount(<EventForm event={event} timezone="America/Chicago" onClose={vi.fn()} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-30" } });
  expect((screen.getByLabelText("End date") as HTMLInputElement).value).toBe("2026-12-02");
  fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ endsAt: "2026-12-02T18:00:00-06:00" }) }));
});

it("keeps the original multi-day end-date control visible even after choosing the start day", () => {
  mount(
    <EventForm
      event={{
        id: "sky:event",
        source: "skylight",
        title: "Trip",
        startsAt: "2026-11-29T09:00:00-06:00",
        endsAt: "2026-11-30T10:00:00-06:00",
        skylight: { eventId: "event", editable: true },
      }}
      timezone="America/Chicago"
      onClose={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-11-29" } });
  expect(screen.getByLabelText("End date")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-30" } });
  expect((screen.getByLabelText("End date") as HTMLInputElement).value).toBe("2026-11-30");
});
