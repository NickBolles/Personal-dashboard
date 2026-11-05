// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ComponentProps } from "react";
import { ChatPanel } from "./ChatPanel";
import { chatThings, type ThingsTab } from "@/lib/chat/things";
import type { RunPanelView } from "@/components/workflows/RunPanel";

const execution = {
  sessionId: "s",
  parent: null,
  records: [],
  sources: [{ source: "transcript" as const, state: "ok" as const }],
  fetchedAt: "2026-11-05T00:00:00Z",
};
const workflow: RunPanelView = {
  id: "run",
  title: "Teaching notes",
  status: "live",
  capture: { session: { speaker: "Ann Lyle" }, points: ["Keep going"] },
  log: [],
  proposals: [],
  context: null,
  panel: [{ type: "Outline", props: { sections: [{ title: "Points", bind: "points" }] } }],
  definition: {
    capture: {},
    mid: [{ id: "speaker", label: "Speaker", bind: "session.speaker", type: "text" }],
  },
};
function mount(overrides: Partial<ComponentProps<typeof ChatPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["chat-files", "s"], []);
  client.setQueryData(["bible-status"], { installed: false });
  function Harness() {
    const [tab, setTab] = useState<ThingsTab>(overrides.tab ?? "Running");
    return (
      <QueryClientProvider client={client}>
        <ChatPanel
          sessionId="s"
          open
          wide
          onTab={setTab}
          onClose={vi.fn()}
          things={chatThings({ links: [], execution })}
          links={[]}
          context={[]}
          readOnly={false}
          onPatch={vi.fn()}
          onRemoveContext={vi.fn()}
          execution={execution}
          retry={vi.fn()}
          onAddContext={vi.fn()}
          {...overrides}
          tab={tab}
        />
      </QueryClientProvider>
    );
  }
  return render(<Harness />);
}
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("keeps roving keyboard tabs linked to their active panel", () => {
  mount();
  const running = screen.getByRole("tab", { name: /^Running/ });
  expect(running.getAttribute("aria-selected")).toBe("true");
  const files = screen.getByRole("tab", { name: /^Files/ });
  fireEvent.keyDown(running, { key: "ArrowRight" });
  expect(document.activeElement).toBe(files);
  expect(files.getAttribute("tabindex")).toBe("0");
  expect(running.getAttribute("tabindex")).toBe("-1");
  expect(files.getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);
  fireEvent.keyDown(files, { key: "End" });
  expect(screen.getByRole("tab", { name: /^Context/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(screen.getByRole("tab", { name: /^Links/ }).getAttribute("aria-selected")).toBe("true");
});

it("puts workflow tabs first and workflow bodies inside the selected tabpanel", () => {
  mount({ tab: "Outline", workflow: { run: workflow, target: null, onTarget: vi.fn(), capture: { unsaved: 0, retry: vi.fn() } } });
  expect(
    screen
      .getAllByRole("tab")
      .slice(0, 4)
      .map((tab) => tab.textContent),
  ).toEqual(["Outline", "Form", "Notes", "Outputs"]);
  expect(within(screen.getByRole("tabpanel")).getByTestId("workflow-outline").textContent).toContain("Keep going");
  expect(screen.getByRole("button", { name: "End session" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Form" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("Ann Lyle");
  expect(screen.queryByTestId("workflow-outline")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Outputs" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("End session to prepare outputs.");
});

it("clamps and persists the desktop panel width with keyboard resizing", () => {
  localStorage.setItem("jarvis.chat.panel.width", "470");
  mount();
  const separator = screen.getByRole("separator", { name: "Resize chat panel" });
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.getAttribute("aria-valuenow")).toBe("480");
  expect(localStorage.getItem("jarvis.chat.panel.width")).toBe("480");
  for (let n = 0; n < 12; n++) fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("280");
});

it("shows a bottom sheet with detents and restores focus when dismissed", () => {
  const close = vi.fn();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const { unmount } = mount({ wide: false, onClose: close });
  const dialog = screen.getByRole("dialog", { name: "In this chat" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Full height" }));
  expect(document.querySelector(".chat-panel-sheet")?.getAttribute("data-full")).toBe("true");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});
