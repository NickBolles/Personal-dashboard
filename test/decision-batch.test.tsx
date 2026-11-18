// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AnswerBatch } from "@/components/smart/AnswerBatch";
import { SmartReply } from "@/components/smart/live";
import { answerComplete, answerPayload, answerQuestions, type AnswerQuestion } from "@/lib/jarvis-ui/answers";
import { validateBlock } from "@/lib/jarvis-ui/validator";
vi.mock("@/lib/client/api", () => ({ api: { get: vi.fn(async () => ({ decisions: [] })) }, newIdempotencyKey: () => "answers-fixture-key" }));
const questions: AnswerQuestion[] = [
  {
    id: "0:naming",
    title: "Project name",
    required: true,
    kind: "choice",
    options: [
      { id: "birch", label: "Birch", consequence: "Discuss renaming" },
      { id: "elm", label: "Elm" },
    ],
    allowOther: true,
  },
  {
    id: "0:timing",
    title: "Timing",
    required: false,
    kind: "choice",
    options: [
      { id: "now", label: "Now" },
      { id: "later", label: "Later" },
    ],
  },
];
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});
it("selects locally, edits, previews exact readable payload then sends once with retry identity", async () => {
  const reply = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  render(
    <SmartReply.Provider value={reply}>
      <AnswerBatch questions={questions} session="isolated" source="fixture" />
    </SmartReply.Provider>,
  );
  expect((screen.getByRole("button", { name: "Submit choices" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Birch" }));
  expect(screen.getByRole("button", { name: "Birch" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Elm" }));
  expect(reply).toHaveBeenCalledTimes(0);
  fireEvent.click(screen.getByRole("button", { name: "Submit choices" }));
  const payload = screen.getByRole("region", { name: "Review exact reply" }).querySelector("pre")!.textContent;
  expect(payload).toContain("Elm [choice:elm]");
  expect(payload).toContain("question:0:naming");
  expect(payload).toContain("skipped (optional)");
  fireEvent.click(screen.getByRole("button", { name: "Confirm send reply" }));
  await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
  await screen.findByText(/Send not confirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Retry same reply" }));
  await screen.findByText("Sent as one reply to this conversation.");
  expect(reply.mock.calls).toEqual([
    [payload, "answers-fixture-key"],
    [payload, "answers-fixture-key"],
  ]);
});
it("keeps editable draft and sent receipt on reload, supports Other and reset", async () => {
  const reply = vi.fn().mockResolvedValue(true);
  const draw = () =>
    render(
      <SmartReply.Provider value={reply}>
        <AnswerBatch questions={questions} session="isolated" source="fixture" />
      </SmartReply.Provider>,
    );
  let ui = draw();
  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Willow" } });
  ui.unmount();
  ui = draw();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Willow");
  fireEvent.click(screen.getByRole("button", { name: "Reset choices" }));
  expect((screen.getByRole("button", { name: "Submit choices" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Birch" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit choices" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm send reply" }));
  await screen.findByText("Sent as one reply to this conversation.");
  ui.unmount();
  draw();
  expect(screen.queryByRole("button", { name: "Submit choices" })).toBeNull();
  expect(reply).toHaveBeenCalledTimes(1);
});
it("closed or missing D ref never sends or writes", async () => {
  const reply = vi.fn();
  render(
    <SmartReply.Provider value={reply}>
      <AnswerBatch questions={[{ ...questions[0], ref: "D-9001" }]} session="isolated" source="stale" />
    </SmartReply.Provider>,
  );
  await screen.findByText(/D-9001 is closed/);
  expect((screen.getByRole("button", { name: "Submit choices" }) as HTMLButtonElement).disabled).toBe(true);
  expect(reply).not.toHaveBeenCalled();
});
it("extracts nested cards, retains stable IDs and separates explicit writes", () => {
  const v = validateBlock(
    JSON.stringify({
      root: "r",
      elements: {
        r: { type: "Stack", props: {}, children: ["question", "write"] },
        question: {
          type: "DecisionCard",
          props: {
            id: "name",
            title: "Name",
            options: [
              { id: "one", label: "One" },
              { id: "two", label: "Two" },
            ],
          },
        },
        write: {
          type: "DecisionCard",
          props: {
            title: "Write",
            options: [
              { id: "one", label: "One", intent: { kind: "item.update", ref: "item:wk_fixture", patch: { nextAction: "One" } } },
              { id: "two", label: "Two", intent: { kind: "item.update", ref: "item:wk_fixture", patch: { nextAction: "Two" } } },
            ],
          },
        },
      },
    }),
  );
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  expect(answerQuestions(v.spec, 2).map((q) => q.id)).toEqual(["2:name"]);
  expect(answerComplete(questions[0], { choice: "forged" })).toBe(false);
  expect(answerComplete(questions[0], { choice: "$other", other: " " })).toBe(false);
  expect(answerPayload(questions, {})).toContain("not authorization");
});
