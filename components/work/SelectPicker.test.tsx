// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DUE_EDIT_SETTLE_MS, DuePicker, MetaPicker, SelectPicker, quickDueDates, type SelectPickerOption } from "./MetaPicker";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const options: SelectPickerOption[] = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana", disabled: true },
  { value: "c", label: "Cherry" },
  { value: "d", label: "Clementine" },
  { value: "e", label: "Elderberry" },
];
function setup(opts = options, value = "c") {
  const onChange = vi.fn();
  render(<SelectPicker id="fruit" label="Fruit" value={value} options={opts} onChange={onChange} testId="fruit-picker" />);
  const trigger = screen.getByRole("button", { name: `Fruit: ${opts.find((o) => o.value === value)?.label ?? value}` });
  fireEvent.click(trigger);
  return { trigger, onChange, list: screen.getByRole("listbox") };
}
const activeLabel = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-activedescendant") ?? "")?.textContent;

it("opens on click, exposes the current accessible name/value and selected row, and focuses a searchless list", () => {
  const { trigger, list } = setup();
  expect(trigger.id).toBe("fruit");
  expect(trigger.getAttribute("aria-label")).toBe("Fruit: Cherry");
  expect(trigger.getAttribute("data-value")).toBe("c");
  expect(trigger.getAttribute("data-testid")).toBe("fruit-picker");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(document.activeElement).toBe(list);
  expect(activeLabel(list)).toBe("Cherry");
  expect(screen.getByRole("option", { name: "Cherry" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("option", { name: "Cherry" }).querySelector("svg")).not.toBeNull();
});

it("has no search at seven options, but filters and focuses search above seven", () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({ value: String(i), label: `Option ${i}` }));
  setup(seven, "0");
  expect(screen.queryByRole("combobox")).toBeNull();
  cleanup();
  setup([...seven, { value: "7", label: "Last choice" }], "7");
  const search = screen.getByRole("combobox", { name: "Search fruit" });
  expect(document.activeElement).toBe(search);
  expect(activeLabel(search)).toBe("Last choice");
  fireEvent.change(search, { target: { value: "last" } });
  expect(screen.getAllByRole("option").length).toBe(1);
  expect(activeLabel(search)).toBe("Last choice");
});

it("supports arrows, wrapping, Home/End and skips disabled options", () => {
  const { list, onChange } = setup();
  fireEvent.keyDown(list, { key: "ArrowUp" });
  expect(activeLabel(list)).toBe("Apple");
  fireEvent.keyDown(list, { key: "ArrowDown" });
  expect(activeLabel(list)).toBe("Cherry");
  fireEvent.keyDown(list, { key: "End" });
  expect(activeLabel(list)).toBe("Elderberry");
  fireEvent.keyDown(list, { key: "ArrowDown" });
  expect(activeLabel(list)).toBe("Apple");
  fireEvent.keyDown(list, { key: "ArrowUp" });
  expect(activeLabel(list)).toBe("Elderberry");
  fireEvent.keyDown(list, { key: "Home" });
  expect(activeLabel(list)).toBe("Apple");
  const disabled = screen.getByRole("option", { name: "Banana" });
  expect(disabled.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(disabled);
  expect(onChange).not.toHaveBeenCalled();
});

it("Enter picks, closes and returns focus to the trigger", () => {
  const { trigger, list, onChange } = setup();
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("d");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("Space picks, while Escape closes without picking and refocuses", () => {
  const { trigger, list, onChange } = setup();
  fireEvent.keyDown(list, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("listbox"), { key: " " });
  expect(onChange).toHaveBeenCalledWith("d");
});

it("type-ahead jumps, accumulates prefixes, cycles repeated letters and resets after 600ms", () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { list } = setup(options, "a");
  fireEvent.keyDown(list, { key: "c" });
  expect(activeLabel(list)).toBe("Cherry");
  fireEvent.keyDown(list, { key: "l" });
  expect(activeLabel(list)).toBe("Clementine");
  now += 601;
  fireEvent.keyDown(list, { key: "c" });
  expect(activeLabel(list)).toBe("Cherry");
  fireEvent.keyDown(list, { key: "c" });
  expect(activeLabel(list)).toBe("Clementine");
  now += 601;
  fireEvent.keyDown(list, { key: "b" });
  expect(activeLabel(list)).toBe("Clementine"); // disabled Banana cannot be reached
});

it("does not select disabled-only lists; disabled trigger cannot open", () => {
  const { list, onChange } = setup([{ value: "x", label: "Unavailable", disabled: true }], "x");
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  expect(activeLabel(list)).toBe("Unavailable");
  cleanup();
  render(<SelectPicker label="Locked" value="" options={[]} onChange={onChange} disabled />);
  const trigger = screen.getByRole("button", { name: "Locked:" }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  fireEvent.click(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("outside click closes without stealing focus", () => {
  const { trigger } = setup();
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  fireEvent.pointerDown(outside);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

it("starts on an existing disabled value but arrows and Enter cannot choose it", () => {
  const { list, onChange } = setup(options, "b");
  expect(activeLabel(list)).toBe("Banana");
  fireEvent.keyDown(list, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(list, { key: "ArrowDown" });
  expect(activeLabel(list)).toBe("Cherry");
  fireEvent.keyDown(list, { key: "ArrowUp" });
  expect(activeLabel(list)).toBe("Apple");
});

it("search keyboard navigation skips disabled rows and safely handles no matches", () => {
  const { onChange } = setup([...options, { value: "f", label: "Fig" }, { value: "g", label: "Grape" }, { value: "h", label: "Honeydew" }], "a");
  const search = screen.getByRole("combobox");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(activeLabel(search)).toBe("Cherry");
  fireEvent.keyDown(search, { key: "End" });
  expect(activeLabel(search)).toBe("Honeydew");
  fireEvent.keyDown(search, { key: "Home" });
  expect(activeLabel(search)).toBe("Apple");
  fireEvent.change(search, { target: { value: "no match" } });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(search.getAttribute("aria-activedescendant")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it("preserves MetaPicker multi-select search, toggling and create behaviour", () => {
  const onToggle = vi.fn();
  const onCreate = vi.fn();
  render(
    <MetaPicker
      label="Tags"
      buttonLabel="Edit tags"
      button="+"
      options={[{ value: "apple", label: "Apple", checked: true }]}
      placeholder="Tags"
      multi
      onToggle={onToggle}
      onCreate={onCreate}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit tags" }));
  const search = screen.getByRole("combobox");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onToggle).toHaveBeenCalledWith("apple");
  fireEvent.change(search, { target: { value: "New tag" } });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onCreate).toHaveBeenCalledWith("New tag");
  expect(screen.queryByRole("dialog")).not.toBeNull();
});

it.each([
  [new Date(2026, 0, 31, 23, 30), { today: "2026-01-31", tomorrow: "2026-02-01", nextWeek: "2026-02-02" }],
  [new Date(2026, 11, 31, 23, 30), { today: "2026-12-31", tomorrow: "2027-01-01", nextWeek: "2027-01-04" }],
  [new Date(2026, 10, 1, 12), { today: "2026-11-01", tomorrow: "2026-11-02", nextWeek: "2026-11-02" }],
  [new Date(2026, 10, 2, 12), { today: "2026-11-02", tomorrow: "2026-11-03", nextWeek: "2026-11-09" }],
  [new Date(2026, 2, 8, 0, 30), { today: "2026-03-08", tomorrow: "2026-03-09", nextWeek: "2026-03-09" }],
  [new Date(2028, 1, 28, 12), { today: "2028-02-28", tomorrow: "2028-02-29", nextWeek: "2028-03-06" }],
])("quick due dates use the local calendar for %s", (now, expected) => {
  const before = now.getTime();
  expect(quickDueDates(now)).toEqual(expected);
  expect(now.getTime()).toBe(before);
});

it("due picker saves Tomorrow, closes and refocuses", () => {
  const onSave = vi.fn();
  render(<DuePicker value={null} onSave={onSave} />);
  const trigger = screen.getByRole("button", { name: "Due date: Set due date" });
  fireEvent.click(trigger);
  expect(screen.queryByRole("option", { name: "Clear due date" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "Tomorrow" }));
  expect(onSave).toHaveBeenCalledWith(quickDueDates(new Date()).tomorrow);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("Sunday Tomorrow and Next week remain distinct options with one selected row", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 1, 12));
  const onSave = vi.fn();
  render(<DuePicker value="2026-11-02" onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  expect(screen.getAllByRole("option", { selected: true }).length).toBe(1);
  expect(screen.getByRole("option", { name: "Tomorrow" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: "Next week" }));
  expect(onSave).not.toHaveBeenCalled(); // unchanged date still closes
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("due picker reveals a native date field, saves once editing settles and can clear", () => {
  vi.useFakeTimers();
  const onSave = vi.fn();
  render(<DuePicker value="2026-11-21" onSave={onSave} />);
  const trigger = screen.getByRole("button", { name: /^Due date:/ });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "Pick a date…" }));
  const date = screen.getByLabelText("Due date", { exact: true, selector: "input" });
  expect(date.getAttribute("type")).toBe("date");
  expect(document.activeElement).toBe(date);
  // segment-by-segment keyboard edits keep the editor open (#207)
  fireEvent.change(date, { target: { value: "2027-01-01" } });
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS - 100));
  fireEvent.change(date, { target: { value: "2027-01-02" } });
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS - 100));
  expect(onSave).not.toHaveBeenCalled();
  expect(date.isConnected).toBe(true);
  act(() => vi.advanceTimersByTime(200));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith("2027-01-02");
  expect(document.activeElement).toBe(trigger);
  vi.useRealTimers();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "Clear due date" }));
  expect(onSave).toHaveBeenLastCalledWith(null);
});

it("due picker saves a typed date right away on Enter", () => {
  const onSave = vi.fn();
  render(<DuePicker value={null} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  fireEvent.click(screen.getByRole("option", { name: "Pick a date…" }));
  const date = screen.getByLabelText("Due date", { exact: true, selector: "input" });
  fireEvent.change(date, { target: { value: "2027-03-04" } });
  fireEvent.keyDown(date, { key: "Enter" });
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith("2027-03-04");
});

it.each(["Today", "Tomorrow", "Next week", "Clear due date"])("due preset %s wins over a pending custom date on internal blur", (label) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 7, 12));
  const onSave = vi.fn();
  render(<DuePicker value="2026-11-21" onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  fireEvent.click(screen.getByRole("option", { name: "Pick a date…" }));
  const date = screen.getByLabelText("Due date", { exact: true, selector: "input" });
  const preset = screen.getByRole("option", { name: label });
  fireEvent.change(date, { target: { value: "2027-03-04" } });
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS - 100));
  fireEvent.blur(date, { relatedTarget: preset });
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS));
  expect(onSave).not.toHaveBeenCalled();
  expect(preset.isConnected).toBe(true);
  fireEvent.click(preset);
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS));
  const dates = quickDueDates(new Date());
  const expected: Record<string, string | null> = { Today: dates.today, Tomorrow: dates.tomorrow, "Next week": dates.nextWeek, "Clear due date": null };
  expect(onSave).toHaveBeenCalledExactlyOnceWith(expected[label]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("due presets cancel the pending custom timer even without a blur", () => {
  vi.useFakeTimers();
  const onSave = vi.fn();
  render(<DuePicker value={null} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  fireEvent.click(screen.getByRole("option", { name: "Pick a date…" }));
  fireEvent.change(screen.getByLabelText("Due date", { selector: "input" }), { target: { value: "2027-03-04" } });
  fireEvent.click(screen.getByRole("option", { name: "Tomorrow" }));
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS));
  expect(onSave).toHaveBeenCalledExactlyOnceWith(quickDueDates(new Date()).tomorrow);
});

it("due picker still flushes a custom date when focus leaves the picker", () => {
  vi.useFakeTimers();
  const onSave = vi.fn();
  render(<DuePicker value={null} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  fireEvent.click(screen.getByRole("option", { name: "Pick a date…" }));
  const date = screen.getByLabelText("Due date", { selector: "input" });
  fireEvent.change(date, { target: { value: "2027-03-04" } });
  fireEvent.blur(date, { relatedTarget: document.body });
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS));
  expect(onSave).toHaveBeenCalledExactlyOnceWith("2027-03-04");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("due picker saves a parked custom date when dismissed after focusing a preset", () => {
  vi.useFakeTimers();
  const onSave = vi.fn();
  render(<DuePicker value={null} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
  fireEvent.click(screen.getByRole("option", { name: "Pick a date…" }));
  const date = screen.getByLabelText("Due date", { selector: "input" });
  fireEvent.change(date, { target: { value: "2027-03-04" } });
  fireEvent.blur(date, { relatedTarget: screen.getByRole("option", { name: "Tomorrow" }) });
  act(() => vi.advanceTimersByTime(DUE_EDIT_SETTLE_MS * 2));
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith("2027-03-04");
  expect(screen.queryByRole("dialog")).toBeNull();
});
