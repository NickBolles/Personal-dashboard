// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskIdentity } from "./TaskIdentity";

const id = "wk_14689923-eed9-462b-8235-7e672a7f234e";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

it("copies the exact canonical task id on tap without navigating", async () => {
  const writeText = vi.fn(async (_value: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const navigate = vi.fn();
  render(
    <div onClick={navigate}>
      <TaskIdentity id={id} />
    </div>,
  );

  expect(screen.getByTestId("task-id-value").textContent).toBe(id);
  const copy = screen.getByRole("button", { name: "Copy task ID" });
  expect(copy.tagName).toBe("BUTTON");
  fireEvent.click(copy);

  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(id));
  expect(screen.getByRole("button", { name: "Copy task ID" }).textContent).toBe("Copied");
  expect(screen.getByRole("status").textContent).toBe("Task ID copied.");
  expect(navigate).not.toHaveBeenCalled();
});

it("clears copied feedback when WorkView selects another task", async () => {
  const writeText = vi.fn(async (_value: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const view = render(<TaskIdentity id={id} />);

  fireEvent.click(screen.getByRole("button", { name: "Copy task ID" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy task ID" }).textContent).toBe("Copied"));
  view.rerender(<TaskIdentity id="wk_new" />);

  expect(screen.getByRole("button", { name: "Copy task ID" }).textContent).toBe("Copy");
  expect(screen.queryByRole("status")).toBeNull();
});

it("copies with the keyboard", async () => {
  const writeText = vi.fn(async (_value: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<TaskIdentity id={id} />);

  fireEvent.keyDown(screen.getByRole("button", { name: "Copy task ID" }), { key: "Enter" });

  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(id));
});

it("keeps the full selectable id and explains the manual fallback when clipboard copy fails", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
  render(<TaskIdentity id={id} />);

  fireEvent.click(screen.getByRole("button", { name: "Copy task ID" }));

  expect((await screen.findByRole("status")).textContent).toBe("Copy unavailable — select the ID above.");
  expect(screen.getByTestId("task-id-value").textContent).toBe(id);
  expect(screen.getByTestId("task-id-value").getAttribute("tabindex")).toBe("0");
});
