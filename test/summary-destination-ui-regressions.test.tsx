// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useSummaryMenuItem } from "@/components/work/ai/AiActions";

vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => true }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/areas" }));
vi.mock("@/components/areas/ModelPicker", () => ({ ModelCombobox: () => null }));
afterEach(cleanup);

it.each(["note", "conversation", "thread", "project", "area", "investigation"])("only offers Summarize when %s can hold a saved note", (kind) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  client.setQueryData(["work", "ai", "item"], { jobs: [], reports: [], policy: { allowed: true } });
  client.setQueryData(["work", "item", "item"], { item: { id: "item", kind } });
  const pick = vi.fn();
  const { result, unmount } = renderHook(() => useSummaryMenuItem("item", pick), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  if (kind === "note" || kind === "conversation") expect(result.current).toBeNull();
  else {
    expect(result.current?.label).toBe("Summarize");
    result.current?.onSelect();
    expect(pick).toHaveBeenCalledWith("summarize");
  }
  unmount();
  client.clear();
});
