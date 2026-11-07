// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import { WorkflowBuilderEntry } from "@/components/workflows/WorkflowBuilderEntry";
import { WorkflowBuilder } from "@/components/workflows/WorkflowBuilder";
import { FinanceOverviewView } from "@/app/(shell)/finance/FinanceOverviewView";
import { FinanceSnapshotCards } from "@/components/finance/FinanceSnapshotCards";
import { HideAmountsProvider, HideAmountsToggle } from "@/components/finance/money";
import { financeSnapshotFixture } from "../mock-upstreams/finance-snapshot.mjs";

vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => true }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function shell(node: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>
  );
}

it("workflow dynamic boundary server-renders a page heading (SSR is not disabled)", () => {
  const html = renderToString(shell(<WorkflowBuilderEntry slug="lazy-state-fixture" />));
  expect(html).toMatch(/<h1\b[^>]*>[^<]+<\/h1>/);
});
it("edit builder keeps exactly one h1 in server-rendered data-loading state", () => {
  const html = renderToString(shell(<WorkflowBuilder slug="lazy-state-fixture" />));
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain("Edit workflow");
  expect(html).toContain("k-skel");
});
it("finance keeps exactly one server-rendered h1 before finance or chart data loads", () => {
  const html = renderToString(shell(<FinanceOverviewView />));
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain(">Finance</h1>");
  expect(html).toContain("Loading finances");
});
it("a failed edit read preserves its h1 and never opens a blank creation form", () => {
  // Keep the seeded terminal read error visible rather than retrying on this SSR mount.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  client
    .getQueryCache()
    .build(client, { queryKey: ["workflows"] })
    .setState({ status: "error", fetchStatus: "idle", error: new Error("Builder read unavailable") });
  const html = renderToString(shell(<WorkflowBuilder slug="lazy-state-fixture" />, client));
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain("Builder read unavailable");
  expect(html).toContain("Retry");
  expect(html).not.toContain('id="wf-name"');
});
it("a missing workflow preserves its h1 and uses a kit empty state", () => {
  // A fresh list (no refetch in flight): a stale one still refetching shows the loading state instead.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["workflows"], { workflows: [] });
  const html = renderToString(shell(<WorkflowBuilder slug="lazy-state-fixture" />, client));
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain("k-empty");
  expect(html).not.toContain('id="wf-name"');
});
it("snapshot amounts are server-rendered independently of its deferred decorative chart", () => {
  const fixture = financeSnapshotFixture();
  const html = renderToString(<FinanceSnapshotCards snapshot={fixture.overview.snapshot} />);
  expect(html).toContain("57,000.00");
  expect(html).toContain("3,466.00");
  expect(html).not.toContain("<polyline");
});
it("hiding amounts unmounts the deferred chart as well as masking its totals", async () => {
  const fixture = financeSnapshotFixture();
  const view = render(
    <HideAmountsProvider>
      <HideAmountsToggle />
      <FinanceSnapshotCards snapshot={fixture.overview.snapshot} />
    </HideAmountsProvider>,
  );
  await vi.waitFor(() => expect(view.container.querySelectorAll("svg polyline")).toHaveLength(1));
  fireEvent.click(screen.getByRole("checkbox", { name: "Hide amounts on this device" }));
  expect(view.container.querySelectorAll("svg")).toHaveLength(0);
  expect(screen.queryByText("57,000.00")).toBeNull();
});
