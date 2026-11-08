// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GetStarted, ReportViewer, useAiMenuItems, useSummaryMenuItem } from "@/components/work/ai/AiActions";
import { ItemAiChips } from "@/components/work/ItemAiChips";
import { api } from "@/lib/client/api";
import { ToastProvider } from "@/components/ui";
import { OverflowMenu } from "@/components/ui/legacy";
import type { ItemAiResponse, ReportView } from "@/lib/ai";
import type { ReactNode } from "react";

const access = vi.hoisted(() => ({ ai: true }));
vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => access.ai }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/areas" }));
vi.mock("@/components/areas/ModelPicker", () => ({ ModelCombobox: () => null }));

const report: ReportView = {
  id: "air_summary",
  jobId: "aij_summary",
  kind: "summarize",
  subjectType: "work_item",
  subjectId: "wk_item",
  title: "Review summary",
  summary: "Current state in brief",
  bodyMd: "Item details for review.",
  structured: {},
  confidence: "medium",
  model: "summary-model",
  costUsd: null,
  conversationId: null,
  readAt: "2026-11-07T12:00:00Z",
  pinnedAt: null,
  archivedAt: null,
  feedback: null,
  supersededBy: null,
  createdAt: "2026-11-07T12:00:00Z",
  sourceCount: 0,
};
const allowed: ItemAiResponse = { jobs: [], reports: [], policy: { allowed: true } };
let client: QueryClient;
function mount(children: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}
function ItemMenu({ onPick }: { onPick: (kind: string) => void }) {
  const items = useAiMenuItems("wk_item", onPick);
  const summary = useSummaryMenuItem("wk_item", onPick);
  return (
    <>
      <ItemAiChips aiActions={items} itemActions={[]} />
      <OverflowMenu label="More item actions" items={summary ? [...items, summary] : items} />
    </>
  );
}
beforeEach(() => {
  access.ai = true;
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("shows a teal draft and dismisses it without any note/apply mutation", async () => {
  vi.spyOn(api, "get").mockResolvedValue(report);
  const post = vi.spyOn(api, "post").mockResolvedValue({});
  const close = vi.fn();
  mount(<ReportViewer reportId={report.id} itemId="wk_item" onClose={close} />);
  const group = await screen.findByRole("group", { name: "Summary draft · review before saving" });
  expect(group.className).toContain("k-propbox");
  expect(group.textContent).toContain("Item details for review.");
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(close).toHaveBeenCalledOnce();
  expect(post).not.toHaveBeenCalled();
});

it("Save as note explicitly applies the summary, disables repeat submission and exposes Undo", async () => {
  vi.spyOn(api, "get").mockResolvedValue(report);
  const post = vi.spyOn(api, "post").mockResolvedValue({ op: { id: "op_summary", kind: "create", label: "Created note" } });
  mount(<ReportViewer reportId={report.id} itemId="wk_item" onClose={() => {}} />);
  const save = await screen.findByRole("button", { name: "Save as note" });
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(save);
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith("/api/ai/reports/air_summary/apply", { what: "summary_note" }));
  expect(((await screen.findByRole("button", { name: "Saved as note" })) as HTMLButtonElement).disabled).toBe(true);
  expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
});

it("offers Summarize in the item overflow menu, with a reason when policy refuses it", async () => {
  vi.spyOn(api, "get").mockResolvedValue(allowed);
  const pick = vi.fn();
  const view = mount(<ItemMenu onPick={pick} />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "More item actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Summarize" }));
  expect(pick).toHaveBeenCalledWith("summarize");
  view.unmount();
  client.clear();
  vi.mocked(api.get).mockResolvedValue({ ...allowed, policy: { allowed: false, reason: "ai_excluded_area" } });
  mount(<ItemMenu onPick={pick} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "More item actions" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "More item actions" }));
  const disabled = await screen.findByRole("menuitem", { name: /Summarize/ });
  expect((disabled as HTMLButtonElement).disabled).toBe(true);
  expect(disabled.textContent).toContain("AI is excluded here");
  expect(screen.queryByRole("group", { name: "AI shortcuts" })).toBeNull();
});

it("does not promote Summarize to the Get started primary button or expose it without work.ai", async () => {
  vi.spyOn(api, "get").mockResolvedValue(allowed);
  localStorage.setItem("jarvis.ai.last:area", "summarize");
  const view = mount(<GetStarted itemId="wk_item" areaId="area" />);
  expect(await screen.findByRole("button", { name: /Get started · Research it/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Get started · Summarize/ })).toBeNull();
  view.unmount();
  client.clear();
  access.ai = false;
  mount(<ItemMenu onPick={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "More item actions" }));
  expect(screen.queryByRole("menuitem", { name: /Summarize/ })).toBeNull();
});
