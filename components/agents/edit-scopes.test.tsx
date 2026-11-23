// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditScopesDialog } from "./EditScopesDialog";
import type { AgentTokenView } from "@/lib/agent-access";

afterEach(() => cleanup());

const token: AgentTokenView = {
  id: "agt_1",
  name: "Chief of staff",
  profile: "chiefofstaff",
  scopes: ["work.read", "work.write", "conversations.file"],
  hint: "x7Qe",
  createdAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

it("flags risky scopes, needs a change, confirms the diff, then saves the normalised list", async () => {
  const onSave = vi.fn(async () => {});
  render(<EditScopesDialog token={token} onClose={() => {}} onSave={onSave} />);
  expect(box(/Read work/).checked).toBe(true);
  expect(box(/Start and steer tasks/).checked).toBe(false);
  expect(screen.getByText("Spends budget")).toBeTruthy();
  expect(button("Review change").disabled).toBe(true);

  fireEvent.click(box(/Start and steer tasks/));
  fireEvent.click(box(/File conversations/));
  expect(button("Review change").disabled).toBe(false);
  fireEvent.click(button("Review change"));

  const added = screen.getByRole("list", { name: "Scopes to add" });
  const removed = screen.getByRole("list", { name: "Scopes to remove" });
  expect(added.textContent).toContain("Start and steer tasks");
  expect(removed.textContent).toContain("File conversations");
  expect(screen.getByText(/spend model budget/)).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();

  fireEvent.click(button("Save scopes"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["work.read", "work.write", "tasks.run"]));
});

it("Back returns to the checklist and an empty selection can't be reviewed", () => {
  render(<EditScopesDialog token={{ ...token, scopes: ["work.read"] }} onClose={() => {}} onSave={async () => {}} />);
  fireEvent.click(box(/Write work/));
  fireEvent.click(button("Review change"));
  fireEvent.click(button("Back"));
  expect(box(/Write work/).checked).toBe(true);
  fireEvent.click(box(/Write work/));
  fireEvent.click(box(/Read work/));
  expect(button("Review change").disabled).toBe(true);
  expect(screen.getByText(/revoke the token/)).toBeTruthy();
});
