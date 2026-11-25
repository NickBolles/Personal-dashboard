// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Disclosure, Sheet, SideDock, SplitPane } from "@/components/ui";

afterEach(cleanup);

describe("Disclosure", () => {
  it("opens its content in place and says so to assistive tech", () => {
    const onOpenChange = vi.fn();
    render(
      <Disclosure summary="Log" meta="Status set · 2h ago" onOpenChange={onOpenChange}>
        <p>Captured by you</p>
      </Disclosure>,
    );
    const row = screen.getByRole("button", { name: /Log/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Captured by you")).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(row.getAttribute("aria-controls")!)?.textContent).toBe("Captured by you");
    expect(onOpenChange).toHaveBeenCalledWith(true);
    fireEvent.click(row);
    expect(screen.queryByText("Captured by you")).toBeNull();
  });
});

describe("Sheet", () => {
  it("is a named modal dialog that takes focus, closes on Escape and gives focus back", () => {
    const onClose = vi.fn();
    const Host = ({ open }: { open: boolean }) => (
      <>
        <button type="button">Opener</button>
        {open ? (
          <Sheet title="In this chat" onClose={onClose} closeLabel="Collapse">
            <a href="/x">A link</a>
          </Sheet>
        ) : null}
      </>
    );
    const view = render(<Host open={false} />);
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(<Host open />);
    const dialog = screen.getByRole("dialog", { name: "In this chat" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(screen.getByRole("link", { name: "A link" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(<Host open={false} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Opener" }));
    expect(document.body.style.overflow).toBe("");
  });

  it("switches between half and full height from the grab bar", () => {
    render(
      <Sheet title="Sheet" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    const sheet = document.querySelector(".k-sheet")!;
    expect(sheet.getAttribute("data-full")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Full height" }));
    expect(sheet.getAttribute("data-full")).toBe("true");
    fireEvent.keyDown(screen.getByRole("button", { name: "Half height" }), { key: "ArrowDown" });
    expect(sheet.getAttribute("data-full")).toBe("false");
  });
});

const panes = [
  { id: "overview", label: "Overview", content: <p>Overview pane</p> },
  { id: "chat", label: "Chat", content: <p>Chat pane</p> },
] as const;

const swipe = (el: Element, from: [number, number], to: [number, number], ms = 120) => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  fireEvent.touchStart(el, { touches: [{ clientX: from[0], clientY: from[1] }] });
  clock.mockReturnValue(1000 + ms);
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: to[0], clientY: to[1] }] });
  clock.mockRestore();
};

describe("SplitPane", () => {
  it("shows both panes side by side when there is room, the second in a dock", () => {
    render(<SplitPane split panes={panes} value="overview" onChange={() => undefined} />);
    expect(screen.getByRole("region", { name: "Overview" }).textContent).toBe("Overview pane");
    expect(screen.getByRole("complementary", { name: "Chat" }).textContent).toBe("Chat pane");
  });

  it("shows one pane at a time without room, and a sideways swipe moves to the other", () => {
    Object.defineProperty(window, "innerWidth", { value: 368, configurable: true });
    const onChange = vi.fn();
    const view = render(<SplitPane split={false} panes={panes} value="overview" onChange={onChange} />);
    expect(screen.getByText("Overview pane")).toBeTruthy();
    expect(screen.queryByText("Chat pane")).toBeNull();
    const pane = screen.getByText("Overview pane");
    swipe(pane, [300, 400], [120, 410]);
    expect(onChange).toHaveBeenLastCalledWith("chat");
    // There is nothing before the first pane.
    onChange.mockClear();
    swipe(pane, [120, 400], [300, 410]);
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<SplitPane split={false} panes={panes} value="chat" onChange={onChange} />);
    expect(screen.queryByText("Overview pane")).toBeNull();
    swipe(screen.getByText("Chat pane"), [120, 400], [300, 410]);
    expect(onChange).toHaveBeenLastCalledWith("overview");
  });

  it("ignores scrolls, slow drags, edge gestures and touches on things that scroll sideways or take typing", () => {
    Object.defineProperty(window, "innerWidth", { value: 368, configurable: true });
    const onChange = vi.fn();
    render(
      <SplitPane
        split={false}
        value="overview"
        onChange={onChange}
        panes={[
          {
            id: "overview",
            label: "Overview",
            content: (
              <div>
                <p>Overview pane</p>
                <div data-scroll-x>
                  <span>Chips</span>
                </div>
                <textarea aria-label="Note" />
              </div>
            ),
          },
          panes[1],
        ]}
      />,
    );
    const pane = screen.getByText("Overview pane");
    swipe(pane, [300, 400], [270, 400]); // too short
    swipe(pane, [300, 400], [150, 520]); // mostly vertical: a scroll
    swipe(pane, [300, 400], [120, 410], 900); // slow drag
    swipe(pane, [362, 400], [120, 410]); // starts at the screen edge
    swipe(screen.getByText("Chips"), [300, 400], [120, 410]);
    swipe(screen.getByRole("textbox", { name: "Note" }), [300, 400], [120, 410]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SideDock", () => {
  it("is a named landmark with its header, body and footer", () => {
    render(
      <SideDock label="Chat" header={<p>Head</p>} footer={<p>Foot</p>}>
        <p>Body</p>
      </SideDock>,
    );
    expect(screen.getByRole("complementary", { name: "Chat" }).textContent).toBe("HeadBodyFoot");
  });
});
