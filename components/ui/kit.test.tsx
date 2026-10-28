// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button, Checkbox, LockBar, Menu, Orb, Pill, ProgressBar, Segmented, SplitButton, StatusCircle, Toggle } from "./kit";
import * as ui from "./index";

afterEach(cleanup);

it("keeps legacy @/components/ui exports", () => {
  for (const name of ["Button", "ButtonLink", "Card", "Badge", "Empty", "Dialog", "OverflowMenu", "ToastProvider", "useToast", "Kbd", "cx"]) {
    expect(ui).toHaveProperty(name);
  }
});

it("Button: variant classes, loading disables, iconOnly keeps an accessible name", () => {
  render(
    <>
      <Button variant="agent">Ask</Button>
      <Button loading>Save</Button>
      <Button iconOnly icon={<span>+</span>}>
        Add item
      </Button>
    </>,
  );
  expect(screen.getByRole("button", { name: "Ask" }).className).toContain("k-btn-agent");
  const save = screen.getByRole("button", { name: "Save" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(save.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("button", { name: "Add item" }).className).toContain("k-btn-icon");
});

it("Pill prop tone and StatusCircle label", () => {
  render(
    <>
      <Pill tone="prop">Proposed</Pill>
      <StatusCircle status="done" label="Done" />
    </>,
  );
  expect(screen.getByText("Proposed").className).toContain("k-t-prop");
  expect(screen.getByRole("img", { name: "Done" }).className).toContain("k-sc-done");
});

it("Checkbox and Toggle report changes; locked toggle doesn't", () => {
  const onCheck = vi.fn();
  const onToggle = vi.fn();
  render(
    <>
      <Checkbox checked={false} onChange={onCheck} label="Task" celebrate />
      <Toggle checked={false} onChange={onToggle} label="Alerts" />
      <Toggle checked={false} onChange={onToggle} label="Cap" locked />
    </>,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Task" }));
  expect(onCheck).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("switch", { name: "Alerts" }));
  fireEvent.click(screen.getByRole("switch", { name: /Cap/ }));
  expect(onToggle).toHaveBeenCalledTimes(1);
});

it("Segmented is a radiogroup with arrow-key selection", () => {
  const onChange = vi.fn();
  render(
    <Segmented
      label="Range"
      value="a"
      onChange={onChange}
      options={[
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ]}
    />,
  );
  const a = screen.getByRole("radio", { name: "A" });
  expect(a.getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(a, { key: "ArrowRight" });
  expect(onChange).toHaveBeenCalledWith("b");
});

it("Menu: roving focus, Esc closes, select fires", () => {
  const onClose = vi.fn();
  const pick = vi.fn();
  render(<Menu label="Actions" onClose={onClose} items={[{ label: "One", onSelect: pick }, { label: "Two" }]} />);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "One" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Two" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "One" }));
  expect(pick).toHaveBeenCalled();
});

it("SplitButton opens its menu", () => {
  render(<SplitButton label="New" onClick={() => {}} menu={[{ label: "Chat" }]} menuLabel="New options" />);
  const caret = screen.getByRole("button", { name: "New options" });
  expect(caret.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(caret);
  expect(screen.getByRole("menuitem", { name: "Chat" })).toBeTruthy();
});

it("ProgressBar clamps, Orb exposes expanded, LockBar unlocks", () => {
  const unlock = vi.fn();
  render(
    <>
      <ProgressBar value={140} label="Load" />
      <Orb expanded />
      <LockBar locked onUnlock={unlock} />
    </>,
  );
  expect(screen.getByRole("progressbar", { name: "Load" }).getAttribute("aria-valuenow")).toBe("100");
  expect(screen.getByRole("button", { name: "Jarvis commands" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(unlock).toHaveBeenCalled();
});
