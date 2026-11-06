// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IconAction } from "@/components/ui/IconAction";
import { coordinatorDot } from "@/lib/agent-runs";

afterEach(cleanup);

test("coordinatorDot: waiting beats failed beats running; nothing live → no dot", () => {
  expect(coordinatorDot([])).toBe(null);
  expect(coordinatorDot([{ live: "finished" }, { live: "idle" }])).toBe(null);
  expect(coordinatorDot([{ live: "running" }])).toBe("running");
  expect(coordinatorDot([{ live: "running" }, { live: "failed" }])).toBe("failed");
  expect(coordinatorDot([{ live: "failed" }, { live: "waiting" }, { live: "running" }])).toBe("waiting");
});

test("IconAction: named by its label (plus the live state), tooltip, click, busy disables", () => {
  const onClick = vi.fn();
  const { rerender } = render(<IconAction label="Coordinator chat for Home" icon={<svg />} dot="waiting" onClick={onClick} />);
  const btn = screen.getByRole("button", { name: "Coordinator chat for Home (waiting for you)" });
  expect(btn.getAttribute("title")).toBe("Coordinator chat for Home (waiting for you)");
  expect(btn.getAttribute("type")).toBe("button");
  expect(btn.getAttribute("data-dot")).toBe("waiting");
  fireEvent.click(btn);
  expect(onClick).toHaveBeenCalledTimes(1);

  rerender(<IconAction label="Chat here" title="Chat here: starts a conversation" icon={<svg />} busy onClick={onClick} />);
  const chat = screen.getByRole("button", { name: "Chat here" });
  expect(chat.getAttribute("title")).toBe("Chat here: starts a conversation");
  expect((chat as HTMLButtonElement).disabled).toBe(true);
  expect(chat.getAttribute("aria-busy")).toBe("true");
  // 44px phone / 40px tablet+desktop hit target classes stay on the button.
  expect(chat.className).toContain("h-11");
  expect(chat.className).toContain("sm:h-10");
});
