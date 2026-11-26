// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolStep } from "./ToolStep";
import { Menu } from "@/components/ui";
import { ContextIcon } from "@/components/icons";
afterEach(cleanup);
describe("structured delegation cards", () => {
  it("shows a failed steer visibly, separates input/result, and preserves raw text", () => {
    const input = JSON.stringify({ action: "steer", message: "Use the confirmed variant", subagent_id: "sa-example" });
    const output = JSON.stringify({ error: "No live subagent 'sa-example' in this conversation's spawn tree." });
    render(
      <ul>
        <ToolStep tool="delegate_task" input={input} output={output} />
      </ul>,
    );
    expect(screen.getByText(/Agent is no longer running/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Guide agent/ }));
    expect(screen.getByRole("region", { name: "Delegation input" }).textContent).toContain("Use the confirmed variant");
    expect(screen.getByRole("region", { name: "Delegation result" }).textContent).toContain("may have finished");
    fireEvent.click(screen.getByText("Raw details"));
    expect(screen.getByText(output)).toBeTruthy();
    expect(screen.queryByText("finished", { exact: true })).toBeNull();
  });
  it("escapes untrusted input and retains malformed payloads", () => {
    const { container } = render(
      <ul>
        <ToolStep tool="delegate_task" input={"<script>bad()</script>"} output="{broken" />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Delegated work/ }));
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("{broken", { selector: "pre" })).toBeTruthy();
  });
  it("keeps long instructions progressively disclosed and streaming output current", () => {
    const props = { tool: "delegate_task", input: JSON.stringify({ goal: "Audit", instructions: "Long instructions ".repeat(60) }) };
    const view = render(
      <ul>
        <ToolStep {...props} done={false} />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Delegate tasks/ }));
    expect(screen.getByText("Read more")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Delegation result" }).textContent).toContain("Waiting for output");
    view.rerender(
      <ul>
        <ToolStep {...props} output={'{"status":"queued","note":"Accepted"}'} />
      </ul>,
    );
    expect(screen.getByRole("region", { name: "Delegation result" }).textContent).toContain("queued");
  });
  it("menu icons are decorative and labels/keyboard navigation stay accessible", () => {
    render(<Menu label="Add" items={[{ label: "Context", icon: <ContextIcon /> }, { label: "Camera" }]} />);
    const first = screen.getByRole("menuitem", { name: "Context" });
    expect(first.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Camera" }));
  });
});
