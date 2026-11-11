// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/lib/activity";
import type { ItemAgentInfo } from "@/lib/agent-runs";
import type { Decision } from "@/lib/cw-decisions";
import type { CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import type { WorkItem } from "@/lib/work";
import { ItemCard, type ItemCardData } from "./ItemCard";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const item = (id: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id,
    parentId: null,
    kind: "thread",
    title: `Item ${id}`,
    summary: "",
    nextAction: "",
    status: "in_progress",
    targetDate: null,
    archived: false,
    tags: [],
    assignee: null,
    decision: null,
    createdAt: ago(600),
    updatedAt: ago(30),
    ...over,
  }) as WorkItem;
const change = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  at: ago(10),
  type: "edit",
  actor: { kind: "agent", name: "chiefofstaff" },
  verb: "edited summary",
  object: { id: "b", title: "Holiday sale checklist" },
  detail: null,
  undoOpId: null,
  ...over,
});
const items = [
  item("proj", { kind: "project", title: "Storefront" }),
  item("b", { parentId: "proj", title: "Holiday sale checklist", nextAction: "Confirm the sale dates", summary: "Last year's list, updated.", tags: ["q4"] }),
];
const run = {
  id: "r3",
  ref: "R-3",
  itemId: "b",
  title: "Smoke tests",
  state: "running",
  stalled: true,
  updatedAt: ago(50),
  startedAt: ago(90),
  parentRunId: null,
} as CoordinatorRunRow;
const decision = { id: "d1", ref: "D-14", itemId: "b", question: "Use last year's dates?", state: "open", createdAt: ago(100) } as Decision;
const agent = {
  itemId: "b",
  who: { kind: "agent", name: "devchief" },
  live: "running",
  liveAt: ago(2),
  sessionId: "sess 1",
  prs: [{ ref: "x#1", url: "https://example.com/pr/1", title: "Sale banner", state: "open", checks: "failure", deploy: null }],
  report: { title: "Banner drafted", summary: "Two variants.", at: ago(40), href: null },
  progress: { done: 1, total: 4 },
} as unknown as ItemAgentInfo;
const data = (over: Partial<ItemCardData> = {}): ItemCardData => ({ items, agents: {}, runs: [], events: [], decisions: [], ...over });
const card = () => within(document.querySelector<HTMLElement>("article")!);
afterEach(cleanup);

it("a quiet item shows its status, where it sits and what is next; actions are one tap in", () => {
  const onAsk = vi.fn();
  render(<ItemCard itemId="b" title="Holiday sale checklist" data={data()} onAsk={onAsk} />);
  expect(card().getByText("In progress")).toBeTruthy();
  expect(card().getByText("Storefront")).toBeTruthy();
  expect(card().getByText("#q4")).toBeTruthy();
  expect(card().getByText("Confirm the sale dates")).toBeTruthy();
  // The arrow goes straight to the item; the rest of the actions are one tap in.
  expect(card().getByRole("link", { name: "Open Holiday sale checklist" }).getAttribute("href")).toBe("/areas?item=b");
  expect(card().queryByRole("link", { name: "Open item" })).toBeNull();
  fireEvent.click(card().getByRole("button", { expanded: false }));
  expect(card().getByRole("link", { name: "Open item" }).getAttribute("href")).toBe("/areas?item=b");
  expect(card().getByText("Last year's list, updated.")).toBeTruthy();
  fireEvent.click(card().getByRole("button", { name: "Ask in chat about Holiday sale checklist" }));
  expect(onAsk).toHaveBeenCalledExactlyOnceWith("Holiday sale checklist");
});

it("what needs the owner leads, and its chips jump to the decision and the run", () => {
  const onRef = vi.fn();
  render(<ItemCard itemId="b" title="x" data={data({ runs: [run], decisions: [decision], agents: { b: agent } })} onRef={onRef} />);
  expect(document.querySelector("article")!.getAttribute("data-state")).toBe("needs");
  expect(card().getByText("Needs you")).toBeTruthy();
  // one clock for the chip (how long the decision has waited); the item's own stage moves to the quiet line
  expect(card().getByText(/^waiting /)).toBeTruthy();
  expect(card().getByText("Stage: In progress")).toBeTruthy();
  fireEvent.click(card().getByRole("button", { name: "Review decision D 14: Use last year's dates?" }));
  fireEvent.click(card().getByRole("button", { name: "Run R 3: Quiet, Smoke tests" }));
  expect(onRef.mock.calls).toEqual([["D-14"], ["R-3"]]);
  // who is on it, progress and the pull request with its checks; the run chip already says it is running
  expect(card().getByText("@devchief")).toBeTruthy();
  expect(card().queryByTestId("agent-live")).toBeNull();
  expect(card().getByRole("progressbar", { name: "1 of 4 done" })).toBeTruthy();
  const prs = within(card().getByRole("list", { name: "Pull requests" }));
  expect(prs.getByRole("link", { name: /^Sale banner/ }).getAttribute("href")).toBe("https://example.com/pr/1");
  expect(prs.getByText("Open")).toBeTruthy();
  fireEvent.click(card().getByRole("button", { expanded: false }));
  expect(card().getByText("Banner drafted: Two variants.")).toBeTruthy();
  expect(card().getByRole("link", { name: "Agent conversation" }).getAttribute("href")).toBe("/chat/sess%201");
});

it("a project gathers what is under it", () => {
  render(<ItemCard itemId="proj" title="Storefront" data={data({ runs: [run], decisions: [decision] })} />);
  expect(card().getByText("Project")).toBeTruthy();
  expect(card().getByText("Needs you")).toBeTruthy();
  // nothing done yet is a count on the quiet line, not an empty bar
  expect(card().getByText("0 of 1 done")).toBeTruthy();
  expect(card().queryByRole("progressbar")).toBeNull();
  fireEvent.click(card().getByRole("button", { expanded: false }));
  expect(card().getByRole("link", { name: "Open project" })).toBeTruthy();
});

it("lists what was changed as a timeline: the latest when closed, three when open, each with its own Undo", () => {
  const changes = [
    change("c1", { verb: "Dates: start — → —, target — → 2026-11-22", undoOpId: "op1" }),
    change("c2", { verb: "tagged #q4" }),
    change("c3", { type: "status", verb: "moved to Exploring", detail: "Captured → Exploring: Predates the new checkout" }),
    change("c4", { type: "created", verb: "created" }),
  ];
  render(
    <ItemCard itemId="b" title="x" data={data()} changes={changes} undo={(row) => (row.undoOpId ? <button type="button">Undo {row.id}</button> : null)} />,
  );
  const list = () => within(card().getByRole("list", { name: "Changes to Holiday sale checklist" })).getAllByRole("listitem");
  const said = () => list().map((li) => li.querySelector(".rc-event-main")!.textContent);
  expect(said()).toEqual([expect.stringMatching(/^Target date \w+ 22$/)]);
  expect(within(list()[0]!).getByRole("button", { name: "Undo c1" })).toBeTruthy();
  fireEvent.click(card().getByRole("button", { expanded: false, name: /Holiday sale checklist/ }));
  expect(said().slice(1)).toEqual(["Tagged #q4", "Moved to Exploring: Predates the new checkout"]);
  // each row's colour says what kind of change it was
  expect(list()[2]!.className).toContain("k-t-ac");
  fireEvent.click(card().getByRole("button", { name: "Show 1 earlier" }));
  expect(said()).toHaveLength(4);
  expect(said()[3]).toBe("Created");
});

it("an item that is gone still shows what was done to it", () => {
  render(<ItemCard itemId="gone" title="Archived thing" data={data()} changes={[change("c1", { object: { id: "gone", title: "Archived thing" } })]} />);
  expect(card().getByText("Archived thing")).toBeTruthy();
  expect(screen.getByRole("list", { name: "Changes to Archived thing" })).toBeTruthy();
  fireEvent.click(card().getByRole("button", { expanded: false }));
  expect(card().queryByRole("link", { name: /^Open/ })).toBeNull();
  expect(card().getByText(/no longer in your areas/)).toBeTruthy();
});
