// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantText } from "@/components/smart/AssistantText";
import { SmartScope } from "@/components/smart/SmartScope";
import { AnswerBatch } from "@/components/smart/AnswerBatch";
import { SmartReply } from "@/components/smart/live";
import { answerComplete, answerPayload, answerQuestions, type AnswerQuestion } from "@/lib/jarvis-ui/answers";
import { smartDecisionRefs } from "@/lib/jarvis-ui/live";
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
it("selects locally and ONE Submit sends once without review; retry preserves identity", async () => {
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
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("region", { name: "Review exact reply" })).toBeNull();
  await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
  const payload = reply.mock.calls[0][0];
  expect(payload).toContain("Elm [choice:elm]");
  expect(payload).toContain("question:0:naming");
  expect(payload).toContain("skipped (optional)");

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
it("chat and rail share selections, in-flight lock and sent receipt for the same response", async () => {
  let accept!: (value: boolean) => void;
  const reply = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      }),
  );
  render(
    <SmartReply.Provider value={reply}>
      <AnswerBatch questions={questions} session="isolated" source="shared" />
      <AnswerBatch questions={questions} session="isolated" source="shared" />
    </SmartReply.Provider>,
  );
  const [chat, rail] = screen.getAllByTestId("answer-batch").map((el) => within(el));
  fireEvent.click(chat.getByRole("button", { name: "Birch" }));
  expect(rail.getByRole("button", { name: "Birch" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(chat.getByRole("button", { name: "Submit choices" }));
  fireEvent.click(rail.getByRole("button", { name: "Retry same reply" }));

  expect(reply).toHaveBeenCalledTimes(1);
  accept(true);
  await waitFor(() => expect(screen.getAllByText("Sent as one reply to this conversation.")).toHaveLength(2));
});
it("rechecks stale D refs after selection and before any send", async () => {
  const { api } = await import("@/lib/client/api");
  vi.mocked(api.get)
    .mockResolvedValueOnce({ decisions: [{ ref: "D-9001", state: "open" }] })
    .mockResolvedValueOnce({ decisions: [] });
  const reply = vi.fn();
  render(
    <SmartReply.Provider value={reply}>
      <AnswerBatch questions={[{ ...questions[0], ref: "D-9001" }]} session="isolated" source="race" />
    </SmartReply.Provider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Birch" }).closest("fieldset")?.disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Birch" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit choices" }));
  await screen.findByText(/D-9001 is closed/);
  expect(reply).not.toHaveBeenCalled();
});
it("preserves multiline fields and enclosing section instructions in the reviewed reply", () => {
  const v = validateBlock(
    JSON.stringify({
      root: "section",
      elements: {
        section: { type: "Section", props: { title: "Discussion only", subtitle: "No commitments" }, children: ["form"] },
        form: {
          type: "Form",
          props: { title: "Notes", fields: [{ id: "details", label: "Details", kind: "textarea", proposed: "Draft note" }], submit: { label: "Reply" } },
        },
      },
    }),
  );
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  const qs = answerQuestions(v.spec, 1);
  expect(qs[0].kind).toBe("textarea");
  expect(qs[0].context).toBe("Discussion only: No commitments");
  expect(qs[0].proposed).toEqual({ choice: "text", other: "Draft note" });
  const reply = vi.fn();
  const draw = () => (
    <SmartReply.Provider value={reply}>
      <AnswerBatch questions={qs} session="isolated" source="proposed" />
    </SmartReply.Provider>
  );
  const ui = render(draw());
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Draft note");
  expect(screen.getByText("Proposed by Jarvis · editable")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Owner's edited note" } });
  ui.unmount();
  render(draw());
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Owner's edited note");
  expect(screen.queryByText("Proposed by Jarvis · editable")).toBeNull();
  expect(reply).not.toHaveBeenCalled();
  expect(answerPayload(qs, { [qs[0].id]: { choice: "text", other: "First line\nSecond line" } })).toContain("First line\nSecond line");
  expect(answerComplete(qs[0], { choice: "text", other: "" })).toBe(true);
});
it("unbound controls cannot offer a fake submit path", () => {
  render(<AnswerBatch questions={questions} session="isolated" source="unbound" />);
  expect((screen.getByRole("button", { name: "Submit choices" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Birch" }).closest("fieldset")?.disabled).toBe(true);
});
it("streamed and persisted assistant text use the same batch contract, never incomplete controls", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(["smart-settings"], { enabled: true });
  const reply = vi.fn().mockResolvedValue(true);
  const text = `Summary\n\n\`\`\`jarvis-ui\n${JSON.stringify({
    root: "q",
    elements: {
      q: {
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
    },
  })}\n\`\`\``;
  const draw = (live: boolean) => (
    <QueryClientProvider client={qc}>
      <SmartScope session="isolated" reply={reply}>
        <AssistantText text={text} messageId="reply-1" live={live} />
      </SmartScope>
    </QueryClientProvider>
  );
  const ui = render(draw(true));
  expect(screen.queryByTestId("answer-batch")).toBeNull();
  ui.rerender(draw(false));
  await screen.findByTestId("answer-batch");
  fireEvent.click(screen.getByRole("button", { name: "One" }));
  expect(reply).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: "Submit choices" })).toHaveLength(1);
  ui.unmount();
  render(draw(false));
  expect(screen.getByRole("button", { name: "One" }).getAttribute("aria-pressed")).toBe("true");
});
it("rejects duplicate option IDs and mismatched explicit/title D refs before rendering controls", () => {
  expect(
    smartDecisionRefs(
      `\`\`\`jarvis-ui\n${JSON.stringify({
        root: "q",
        elements: {
          q: {
            type: "DecisionCard",
            props: {
              title: "Test question",
              decisionRef: "D-9001",
              options: [
                { id: "one", label: "One" },
                { id: "two", label: "Two" },
              ],
            },
          },
        },
      })}\n\`\`\``,
    ),
  ).toEqual(["D-9001"]);
  const card = (options: unknown[], extra = {}) =>
    JSON.stringify({ root: "q", elements: { q: { type: "DecisionCard", props: { title: "D-9001 · Test question", ...extra, options } } } });
  expect(
    validateBlock(
      card([
        { id: "one", label: "One" },
        { id: "one", label: "Duplicate" },
      ]),
    ).ok,
  ).toBe(false);
  expect(
    validateBlock(
      card(
        [
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
        ],
        { decisionRef: "D-9002" },
      ),
    ).ok,
  ).toBe(false);
});
it("supports long choice-only questionnaires within the real chat transport limit", () => {
  const qs: AnswerQuestion[] = Array.from({ length: 12 }, (_, i) => ({
    id: `field-${i}`,
    title: "T".repeat(200) + " · " + "Q".repeat(200),
    context: "C".repeat(400),
    required: true,
    kind: "choice",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    proposed: { choice: "yes" },
  }));
  const text = answerPayload(qs, Object.fromEntries(qs.map((q) => [q.id, { choice: "yes" }])));
  expect(text.length).toBeGreaterThan(8000);
  expect(text.length).toBeLessThan(50000);
  render(
    <SmartReply.Provider value={vi.fn()}>
      <AnswerBatch questions={qs} session="isolated" source="long" />
    </SmartReply.Provider>,
  );
  expect((screen.getByRole("button", { name: "Submit choices" }) as HTMLButtonElement).disabled).toBe(false);
});
it("warns when malformed siblings are dropped from an otherwise answer-only block", () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(["smart-settings"], { enabled: true });
  const text = `\`\`\`jarvis-ui\n${JSON.stringify({
    root: "r",
    elements: {
      r: { type: "Stack", props: {}, children: ["good", "bad"] },
      good: {
        type: "DecisionCard",
        props: {
          title: "Valid",
          options: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
          ],
        },
      },
      bad: {
        type: "DecisionCard",
        props: {
          title: "Invalid",
          options: [
            { id: "same", label: "One" },
            { id: "same", label: "Two" },
          ],
        },
      },
    },
  })}\n\`\`\``;
  render(
    <QueryClientProvider client={qc}>
      <SmartScope session="isolated" reply={vi.fn()}>
        <AssistantText text={text} messageId="partial" />
      </SmartScope>
    </QueryClientProvider>,
  );
  expect(screen.getByTestId("smart-fallback").textContent).toContain("Only the listed answers will be sent");
  expect(screen.getAllByTestId("answer-batch")).toHaveLength(1);
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
  expect(answerQuestions(v.spec, 2).map((q) => q.id)).toEqual(["2:question:name"]);
  expect(answerComplete(questions[0], { choice: "forged" })).toBe(false);
  expect(answerComplete(questions[0], { choice: "$other", other: " " })).toBe(false);
  expect(answerPayload(questions, {})).toContain("not authorization");
});
