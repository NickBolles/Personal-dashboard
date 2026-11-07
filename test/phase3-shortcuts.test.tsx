// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ItemAiChips } from "@/components/work/ItemAiChips";
import { CapturePreview } from "@/components/capture/CapturePreview";
afterEach(cleanup);
it("AI shortcuts open the same handlers and have distinct accessible names", () => {
  const draft = vi.fn(),
    split = vi.fn(),
    move = vi.fn();
  render(
    <ItemAiChips
      aiActions={[{ label: "✦ Draft it…", onSelect: draft }]}
      itemActions={[
        { label: "Split into child", onSelect: split },
        { label: "Move…", onSelect: move, disabled: true },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "AI: Draft next step" }));
  fireEvent.click(screen.getByRole("button", { name: "AI: Split" }));
  expect(draft).toHaveBeenCalledTimes(1);
  expect(split).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "AI: Move" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "AI: Summarize" })).toBeNull();
});
it("hides every shortcut when the existing policy/capability gate offers no AI actions", () => {
  render(<ItemAiChips aiActions={[]} itemActions={[{ label: "Move…", onSelect: vi.fn() }]} />);
  expect(screen.queryByRole("group")).toBeNull();
});
it("capture preview updates its real title and Inbox destination without inventing a due date", () => {
  const { rerender } = render(<CapturePreview text={"Tune the bandsaw\nNotes"} url="" fileCount={0} />);
  expect(screen.getByTestId("capture-preview").textContent).toBe("Will create: Capture · Tune the bandsaw · Inbox");
  rerender(<CapturePreview text="" url="https://example.com/new" fileCount={0} />);
  expect(screen.getByTestId("capture-preview").textContent).toContain("example.com");
  rerender(<CapturePreview text="" url="" fileCount={1} />);
  expect(screen.getByTestId("capture-preview").textContent).toContain("Screenshot");
});
