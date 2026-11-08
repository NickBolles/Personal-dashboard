// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ResumeView, useResume } from "@/components/resume/ResumeView";
import { PickUpStrip } from "@/components/resume/PickUpStrip";
import { allowed, DESTINATIONS, PRIMARY } from "@/components/navigation/destinations";
import { moduleFor } from "@/lib/modules";
import { api } from "@/lib/client/api";
import type { ResumeConversationRow, ResumeResponse, ResumeRunRow } from "@/lib/resume";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/resume",
}));

const at = "2026-11-07T14:05:00Z";
const run = (key: string, extra: Partial<ResumeRunRow> = {}): ResumeRunRow => ({
  kind: "run",
  key,
  itemId: key,
  title: `Run ${key}`,
  path: "General Dev › Jarvis › Resume hub",
  live: "running",
  approval: false,
  stalled: false,
  who: "@devchief",
  at,
  href: `/chat/${key}`,
  itemHref: `/areas?item=${key}`,
  sessionId: key,
  ...extra,
});
const conversation = (key: string, extra: Partial<ResumeConversationRow> = {}): ResumeConversationRow => ({
  kind: "conversation",
  key,
  sessionId: key,
  title: `Chat ${key}`,
  preview: null,
  path: "General Dev › Jarvis",
  parentId: "jarvis",
  unfiled: false,
  unread: false,
  unreadCount: null,
  agentProfile: "devchief",
  at,
  href: `/chat/${key}`,
  itemHref: "/areas?item=jarvis",
  ...extra,
});
function fixture(): ResumeResponse {
  return {
    runs: [run("waiting", { live: "waiting", approval: true }), run("running")],
    conversations: [
      conversation("unread", { unread: true, unreadCount: 2 }),
      conversation("recent"),
      conversation("unfiled", { unfiled: true, path: null, parentId: null, itemHref: null }),
    ],
    counts: { running: 1, waiting: 1, unread: 1, unfiled: 1 },
    conversationsUnavailable: false,
    fetchedAt: at,
  };
}
let data: ResumeResponse;
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  data = fixture();
  nav.search = "";
  nav.replace.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "get").mockImplementation(async () => data);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("renders one heading, counted sections, state dots, breadcrumbs, agent chips and exact Resume targets", async () => {
  render(<ResumeView />, { wrapper });
  await screen.findByText("Run waiting");
  expect(screen.getAllByRole("heading", { level: 1 }).map((e) => e.textContent)).toEqual(["In flight"]);
  expect(screen.getByRole("heading", { name: /^Needs you \/ running\s*2$/ }).textContent).toContain("2");
  expect(screen.getByRole("heading", { name: /^Conversations\s*2$/ }).textContent).toContain("2");
  expect(screen.getByRole("heading", { name: /^Unfiled\s*1$/ }).textContent).toContain("1");
  expect(screen.getByRole("img", { name: "Waiting for you" }).className).toContain("k-t-wn");
  expect(screen.getByRole("img", { name: "Running" }).className).toContain("k-dot-live");
  expect(screen.getByRole("img", { name: "Running" }).className).toContain("k-t-ai");
  expect(screen.getByRole("img", { name: "Unread" })).toBeTruthy();
  expect(screen.getByText("2 unread")).toBeTruthy();
  expect(screen.getAllByText("@devchief")).toHaveLength(5);
  expect(screen.getAllByRole("link", { name: "Resume" }).map((e) => e.getAttribute("href"))).toEqual([
    "/chat/waiting",
    "/chat/running",
    "/chat/unread",
    "/chat/recent",
    "/chat/unfiled",
  ]);
  expect(screen.getAllByRole("link", { name: "Open item" }).map((e) => e.getAttribute("href"))).toEqual(["/areas?item=waiting", "/areas?item=running"]);
  expect(screen.getAllByRole("link", { name: "General Dev › Jarvis" })[0].getAttribute("href")).toBe("/areas?item=jarvis");
  expect(screen.getByRole("link", { name: "File…" }).getAttribute("href")).toBe("/inbox");
  expect(document.querySelectorAll("time[data-dynamic]")).toHaveLength(5);
  expect(api.get).toHaveBeenCalledWith("/api/work/resume");
});

it("renders failed in red and stalled without a misleading live animation", async () => {
  data.runs = [run("failed", { live: "failed" }), run("stalled", { stalled: true })];
  render(<ResumeView />, { wrapper });
  expect((await screen.findByRole("img", { name: "Failed" })).className).toContain("k-t-bad");
  expect(screen.getByRole("img", { name: "Stalled" }).className).not.toContain("k-dot-live");
  expect(screen.getByText("Stalled").className).toContain("k-pill");
});

it("hides empty sections and zero counts, showing only New chat on an empty hub", async () => {
  data = { ...data, runs: [], conversations: [], counts: { running: 0, waiting: 0, unread: 0, unfiled: 0 } };
  render(<ResumeView />, { wrapper });
  await screen.findByText("Nothing in flight.");
  expect(screen.getByText("New chats and agent runs show up here.")).toBeTruthy();
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  expect(screen.queryByText("0")).toBeNull();
  expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["All conversations", "New chat"]);
  expect(screen.getByRole("link", { name: "All conversations" }).getAttribute("href")).toBe("/chat");
  expect(screen.getByRole("link", { name: "New chat" }).getAttribute("href")).toBe("/chat");
});

it("hides independently empty sections while keeping populated runs", async () => {
  data.conversations = [];
  render(<ResumeView />, { wrapper });
  await screen.findByText("Run running");
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  expect(screen.queryByText("Nothing in flight.")).toBeNull();
});

it("shows unavailable conversations as a note, not as zero or an empty hub", async () => {
  data = { ...data, runs: [], conversations: [], conversationsUnavailable: true };
  render(<ResumeView />, { wrapper });
  await screen.findByText("Conversations couldn't load");
  expect(screen.queryByText("0 conversations")).toBeNull();
  expect(screen.queryByText("Nothing in flight.")).toBeNull();
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
});

it.each([
  ["running", ["Run running"]],
  ["unread", ["Chat unread"]],
  ["unfiled", ["Chat unfiled"]],
  ["unknown", ["Run waiting", "Run running", "Chat unread", "Chat recent", "Chat unfiled"]],
])("restores the %s URL filter", async (view, titles) => {
  nav.search = `view=${view}`;
  render(<ResumeView />, { wrapper });
  await screen.findByText(titles[0]);
  expect(
    screen
      .getAllByTestId("resume-row")
      .map((e) => titles.filter((t) => e.textContent?.includes(t)))
      .flat(),
  ).toEqual(titles);
  expect(screen.getAllByTestId("resume-row")).toHaveLength(titles.length);
});

it("changes the URL without losing other parameters and clears All's view parameter", async () => {
  nav.search = "context=jarvis";
  const view = render(<ResumeView />, { wrapper });
  await screen.findByText("Run waiting");
  fireEvent.click(screen.getByRole("radio", { name: "Unread" }));
  expect(nav.replace).toHaveBeenLastCalledWith("/resume?context=jarvis&view=unread", { scroll: false });
  nav.search = "context=jarvis&view=unread";
  view.rerender(<ResumeView />);
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  expect(nav.replace).toHaveBeenLastCalledWith("/resume?context=jarvis", { scroll: false });
});

it("does not claim the whole hub is empty when just a filter has no matches", async () => {
  data.conversations = data.conversations.map((c) => ({ ...c, unread: false }));
  nav.search = "view=unread";
  render(<ResumeView />, { wrapper });
  await screen.findByText("Nothing in this view.");
  expect(screen.queryByText("Nothing in flight.")).toBeNull();
});

it("uses counts.unfiled in its header rather than the truncated list length", async () => {
  data.counts.unfiled = 12;
  nav.search = "view=unfiled";
  render(<ResumeView />, { wrapper });
  await screen.findByText("Chat unfiled");
  expect(screen.getByRole("heading", { name: /^Unfiled\s*12$/ })).toBeTruthy();
});

it("renders the strip's top three in-flight and unread rows, with See all", async () => {
  render(<PickUpStrip />, { wrapper });
  const strip = within(await screen.findByTestId("pick-up-strip"));
  expect(strip.getAllByTestId("pick-up-row").map((r) => r.textContent)).toEqual([
    expect.stringContaining("Run waiting"),
    expect.stringContaining("Run running"),
    expect.stringContaining("Chat unread"),
  ]);
  expect(strip.getAllByRole("link", { name: "Resume" }).map((e) => e.getAttribute("href"))).toEqual(["/chat/waiting", "/chat/running", "/chat/unread"]);
  expect(strip.getByRole("link", { name: "See all" }).getAttribute("href")).toBe("/resume");
  expect(strip.queryByText("Chat recent")).toBeNull();
});

it("deduplicates sessions in the strip and fills the remaining slots", async () => {
  data.conversations.unshift(conversation("duplicate", { sessionId: "running", unread: true }));
  render(<PickUpStrip />, { wrapper });
  await screen.findByTestId("pick-up-strip");
  expect(screen.getAllByTestId("pick-up-row")).toHaveLength(3);
  expect(screen.queryByText("Chat duplicate")).toBeNull();
  expect(screen.getByText("Chat unread")).toBeTruthy();
});

it("renders no strip when empty", async () => {
  data.runs = [];
  data.conversations = [];
  const view = render(<PickUpStrip />, { wrapper });
  await waitFor(() => expect(client.getQueryState(["work", "resume"])?.status).toBe("success"));
  expect(view.container.textContent).toBe("");
});

it("shows hub errors with Retry but renders no strip on error", async () => {
  vi.mocked(api.get).mockRejectedValue(new Error("Resume unavailable"));
  render(
    <>
      <ResumeView />
      <PickUpStrip />
    </>,
    { wrapper },
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Resume unavailable");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByTestId("pick-up-strip")).toBeNull();
  expect(screen.queryByText("Nothing in flight.")).toBeNull();
});

it("gates both navigation destinations and registers the route under work.use", () => {
  expect(
    PRIMARY.filter((d) => allowed(d, ["work.use", "hermes.chat"]))
      .slice(0, 3)
      .map((d) => d.key),
  ).toEqual(["home", "areas", "alerts"]);
  const destination = DESTINATIONS.find((d) => d.key === "resume")!;
  expect(destination.href).toBe("/resume");
  expect(allowed(destination, [])).toBe(false);
  expect(allowed(destination, ["work.use"])).toBe(true);
  const routes = moduleFor("work")!.routes;
  expect(routes[routes.findIndex((r) => r.href === "/areas") + 1]).toEqual({ href: "/resume", label: "In flight" });
});

it("polls every five seconds while updating, then every thirty seconds", async () => {
  vi.useFakeTimers();
  data = { ...data, updating: true };
  renderHook(() => useResume(), { wrapper });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(api.get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(api.get).toHaveBeenCalledTimes(2);
  data = { ...data, updating: false };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(api.get).toHaveBeenCalledTimes(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_000);
  });
  expect(api.get).toHaveBeenCalledTimes(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(api.get).toHaveBeenCalledTimes(4);
});

it("does not fetch when its capability/viewport gate is disabled", () => {
  renderHook(() => useResume(false), { wrapper });
  expect(api.get).not.toHaveBeenCalled();
});
