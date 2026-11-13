// @vitest-environment jsdom
import { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import type { ConversationListResponse } from "@/lib/work";
import { ConversationsView, agentMark } from "./ConversationsView";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/chat/QuickCapture", () => ({ QuickCapture: () => null }));
vi.mock("@/components/chat/ContextNote", () => ({ ContextNote: () => null }));
vi.mock("@/components/chat/backend", () => ({ BackendSwitch: () => null, useAssistantChoice: () => ({ status: { defaultBackend: "hermes" } }) }));
vi.mock("@/components/ui", async (original) => ({ ...(await original<object>()), useToast: () => ({ toast: vi.fn(), announce: vi.fn() }) }));

type Row = ConversationListResponse["conversations"][number];
const row = (id: string, title: string, extra: Partial<Row> = {}): Row => ({
  id,
  title,
  preview: null,
  lastActiveAt: new Date().toISOString(),
  backend: "hermes",
  readOnly: false,
  linkedItems: [],
  placement: null,
  shared: false,
  agentProfile: null,
  unread: false,
  unreadCount: null,
  suggestions: [],
  ...extra,
});
const list: ConversationListResponse = {
  conversations: [
    row("plain", "Plain unfiled chat"),
    row("suggested", "Weekly eval review with a long title", {
      agentProfile: "chiefofstaff",
      suggestions: [{ id: "wk_site", title: "Marketing site refresh", path: "Work › Marketing site refresh", matched: ["review"] }],
    }),
    row("filed", "Garage cleanup", { backend: "claude", placement: { nodeId: "n", parentId: "wk_home", path: "Home › Garage", inMisc: false } }),
    row("misc", "Loose thought", { placement: { nodeId: "m", parentId: "wk_misc", path: "Miscellaneous", inMisc: true } }),
    row("cron", "[Cron delivery: nightly-backup] Backup report", { lastActiveAt: null }),
    row("daily", "Daily Compass Morning brief"),
  ],
  unfiledCount: 5,
  unreadCount: 0,
  unavailable: [],
};
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  vi.spyOn(api, "get").mockImplementation(async (path) => (path.startsWith("/api/work/conversations") ? list : { items: [], linkedConversations: [] }));
  vi.spyOn(api, "post").mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const show = async () => {
  render(
    <QueryClientProvider client={client}>
      <ConversationsView />
    </QueryClientProvider>,
  );
  await screen.findByRole("link", { name: "Plain unfiled chat" });
  return (id: string) => document.querySelector<HTMLElement>(`[data-conversation="${id}"]`)!;
};
const meta = (el: HTMLElement) => el.querySelector("p")?.textContent ?? "";

describe("agentMark", () => {
  it("marks an agent profile or a non-default assistant, never the default one", () => {
    expect(agentMark({ agentProfile: "devchief", backend: "hermes" })).toBe("@devchief");
    expect(agentMark({ backend: "hermes" })).toBeNull();
    expect(agentMark({ backend: "claude" })).toBe("Claude");
    expect(agentMark({ backend: "hermes" }, "claude")).toBe("Hermes");
    expect(agentMark({ backend: "claude" }, "claude")).toBeNull();
  });
});

describe("conversation rows", () => {
  it("say only what distinguishes a row, with no dangling separators", async () => {
    const at = await show();
    // Default assistant, not filed: just the time. No "Hermes · Not in Areas ·".
    expect(meta(at("plain"))).toBe("just now");
    expect(at("plain").getAttribute("data-placement")).toBe("none");
    expect(screen.queryByText("Not in Areas")).toBeNull();
    expect(screen.queryByText("Hermes")).toBeNull();
    // An agent, a non-default assistant and a real filing are shown.
    expect(meta(at("suggested")).startsWith("@chiefofstaff·just now")).toBe(true);
    expect(meta(at("filed"))).toBe("Claude·Home › Garage·just now");
    // Miscellaneous counts as unfiled: no path, but the row knows where it sits.
    expect(meta(at("misc"))).toBe("just now");
    expect(at("misc").getAttribute("data-placement")).toBe("misc");
    for (const id of ["plain", "suggested", "filed", "misc", "cron", "daily"]) expect(meta(at(id))).not.toMatch(/^·|·$/);
  });
  it("tags only explicit cron deliveries as Scheduled and shows their title without the wrapper", async () => {
    const at = await show();
    expect(within(at("cron")).getByRole("link", { name: "Backup report" }).getAttribute("title")).toBe("[Cron delivery: nightly-backup] Backup report");
    expect(within(at("cron")).getByTestId("scheduled-tag").textContent).toBe("Scheduled");
    // No time and nothing else to say: the tag alone, no separator.
    expect(meta(at("cron"))).toBe("Scheduled");
    expect(within(at("daily")).queryByTestId("scheduled-tag")).toBeNull();
  });
  it("makes the whole row one link target while filing stays a separate one-tap action", async () => {
    const at = await show();
    const suggested = at("suggested");
    const link = within(suggested).getByRole("link", { name: "Weekly eval review with a long title" });
    expect(link.getAttribute("href")).toBe("/chat/suggested");
    // The link is stretched over the row; nothing interactive is nested inside it.
    expect(link.className).toContain("after:absolute after:inset-0");
    expect(link.querySelector("button, a")).toBeNull();
    expect(within(suggested).getAllByRole("link")).toHaveLength(1);
    fireEvent.click(within(suggested).getByRole("button", { name: "File under Marketing site refresh: Weekly eval review with a long title" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/work/conversations/file", { sessionId: "suggested", itemId: "wk_site" }));
    // Filing options stay on the row's menu; a filed conversation has none.
    fireEvent.click(within(at("plain")).getByRole("button", { name: "Filing options: Plain unfiled chat" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["File under…", "File in Miscellaneous"]);
    expect(within(at("filed")).queryByRole("button")).toBeNull();
  });
  it("keeps Refresh and Mark all read in the list menu", async () => {
    await show();
    expect(screen.queryByRole("button", { name: "Refresh conversations" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Conversation list actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Refresh now", "Mark all read"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh now" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/work\/conversations\?view=all&refresh=1$/)));
  });
});
