// @vitest-environment jsdom
// Today's "Pick up where you left off" strip and the In flight navigation entry. The In flight page itself is the
// task list: components/tasks/task-list.test.tsx.
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useResume } from "@/components/resume/ResumeView";
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

it("renders no strip when the rows cannot be read", async () => {
  vi.mocked(api.get).mockRejectedValue(new Error("Resume unavailable"));
  render(<PickUpStrip />, { wrapper });
  await waitFor(() => expect(client.getQueryState(["work", "resume"])?.status).toBe("error"));
  expect(screen.queryByTestId("pick-up-strip")).toBeNull();
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
