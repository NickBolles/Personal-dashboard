// @vitest-environment jsdom
/**
 * An answer's receipt follows its delivery (task threads E4): "Sending" while it can be undone and while it is on
 * its way, then "Delivered" or "Not delivered" as the server reads it back; never "sent" just because Undo ended.
 */
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import type { DeliveryState } from "@/lib/cw-decisions";
import { DecisionReceiptLine } from "./DecisionBlock";
import type { DecisionReceipt } from "./useAnswerDecision";

const view = {
  ref: "D-7",
  itemId: "wk_desk",
  question: "What is your budget ceiling?",
  choices: ["$350", "$300"],
  recommended: null,
  risk: [],
  pack: "single",
  defaultChoice: null,
  expiresAt: null,
  createdAt: "2026-11-22T10:00:00Z",
  blocks: null,
} as unknown as DecisionReceipt["view"];
const receipt = (undoable: boolean): DecisionReceipt => ({ view, choice: "$350", op: null, index: 0, undoable, sending: true });
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the receipt's delivery word", () => {
  it("says Sending while Undo is open, without asking the server", () => {
    const get = vi.spyOn(api, "get");
    render(<DecisionReceiptLine receipt={receipt(true)} />, { wrapper });
    expect(screen.getByText(/Sending/)).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it.each<[DeliveryState, string]>([
    ["sent", "Sending"],
    ["delivered", "Delivered"],
    ["failed", "Not delivered"],
  ])("after Undo, a %s answer reads %s", async (state, word) => {
    vi.spyOn(api, "get").mockResolvedValue({ delivery: { state, at: null } } as never);
    render(<DecisionReceiptLine receipt={receipt(false)} />, { wrapper });
    expect(await screen.findByText(new RegExp(`· ${word}$`))).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/work/decisions/D-7/delivery", expect.anything());
  });
});
