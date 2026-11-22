// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AskAboutStep, NoticeCard, askAboutText } from "./Notice";
import type { ChatNotice } from "@/lib/chat-notices";

afterEach(cleanup);

const notice: Extract<ChatNotice, { kind: "delegation" }> = {
  kind: "delegation",
  title: "Subagent finished",
  status: "completed",
  duration: "6m",
  detail: "",
  tasks: [
    {
      index: 1,
      total: 1,
      goal: "Collect three print quotes",
      ok: true,
      status: "completed",
      duration: "6m",
      body: "Lakeside is cheapest at $0.84 a copy for 500.",
      transcript: "/host/logs/quotes.jsonl",
    },
  ],
};

describe("a delegated step with no chat of its own", () => {
  it("is a card that opens in place to its summary, with the log path as text, never a link", () => {
    render(<NoticeCard notice={notice} />);
    expect(screen.getByText("Subagent finished")).toBeTruthy();
    expect(screen.getByText("Collect three print quotes")).toBeTruthy();
    expect(screen.getByText("Lakeside is cheapest at $0.84 a copy for 500.")).toBeTruthy();
    expect(screen.getByTestId("transcript-path").textContent).toBe("/host/logs/quotes.jsonl");
    expect(screen.queryByRole("link")).toBeNull();
    // Outside a thread there is nobody to ask.
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
  });

  it("Ask about this quotes the step into the thread's composer and sends nothing", () => {
    const ask = vi.fn();
    render(
      <AskAboutStep.Provider value={ask}>
        <NoticeCard notice={notice} />
      </AskAboutStep.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    expect(ask).toHaveBeenCalledWith("About the step “Collect three print quotes”: ");
  });

  it("quotes a step that has no goal by its number, on one line", () => {
    expect(askAboutText({ goal: "", index: 2, total: 3 })).toBe("About the step “task 2/3”: ");
    expect(askAboutText({ goal: "Read\n  the   price table", index: 1, total: 1 })).toBe("About the step “Read the price table”: ");
  });
});
