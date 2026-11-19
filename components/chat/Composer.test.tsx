// @vitest-environment jsdom
/**
 * The one composer, on its own: what it keeps per conversation, and what a scope chip changes about a send.
 */
import { useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import type { ChatAttachments, DraftFile } from "./Attachments";

const stored = new Map<string, unknown>();
vi.mock("@/lib/client/idb", () => ({
  kvGet: vi.fn(async (key: string) => stored.get(key)),
  kvSet: vi.fn(async (key: string, value: unknown) => void stored.set(key, value)),
  kvDel: vi.fn(async (key: string) => void stored.delete(key)),
}));

const ready: DraftFile = { localId: "l1", name: "notes.txt", size: 12, kind: "text", progress: null, status: "ready", file: { id: "f1" } as DraftFile["file"] };
const files = (drafts: DraftFile[]): ChatAttachments => ({
  drafts,
  add: vi.fn(),
  remove: vi.fn(),
  retry: vi.fn(),
  clear: vi.fn(),
  uploading: false,
  readyIds: drafts.flatMap((d) => (d.file ? [d.file.id] : [])),
});

let client: QueryClient;
const onSend = vi.fn(async () => true);
const onSteer = vi.fn(async () => true);
function Host(props: Partial<ComponentProps<typeof Composer>>) {
  const [text, setText] = useState("");
  return (
    <QueryClientProvider client={client}>
      <Composer
        surface="panel"
        sessionId={null}
        text={text}
        onText={setText}
        answerer="Chief of staff"
        online
        context={[]}
        onRemoveContext={() => {}}
        onAttach={() => {}}
        attachments={files([])}
        onSend={onSend}
        onSteer={onSteer}
        repo={null}
        testIds={{ input: "field", send: "send" }}
        {...props}
      />
    </QueryClientProvider>
  );
}
const field = () => screen.getByTestId("field") as HTMLTextAreaElement;
const send = () => screen.getByTestId("send") as HTMLButtonElement;
const settle = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  stored.clear();
  onSend.mockClear();
  onSteer.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

it("switching conversations swaps drafts: the words stay with the thread they were typed in, and the other thread's own come back", async () => {
  stored.set("draft:thread-b", "A reply I started in B");
  const view = render(<Host sessionId="thread-a" />);
  await settle();
  fireEvent.change(field(), { target: { value: "Half a thought in A" } });
  // Switched before the draft's own save (200 ms) had run.
  view.rerender(<Host sessionId="thread-b" />);
  await settle(300);
  expect(field().value).toBe("A reply I started in B");
  expect(stored.get("draft:thread-a")).toBe("Half a thought in A");
  expect(stored.get("draft:thread-b")).toBe("A reply I started in B");
  // And back again.
  view.rerender(<Host sessionId="thread-a" />);
  await settle(300);
  expect(field().value).toBe("Half a thought in A");
});

it("a thread with no draft of its own opens empty after a switch, and nothing of the other thread is saved under it", async () => {
  const view = render(<Host sessionId="thread-a" />);
  await settle();
  fireEvent.change(field(), { target: { value: "Only for A" } });
  await settle(300);
  view.rerender(<Host sessionId="thread-b" />);
  await settle(300);
  expect(field().value).toBe("");
  expect(stored.has("draft:thread-b")).toBe(false);
  expect(stored.get("draft:thread-a")).toBe("Only for A");
});

it("a conversation that is only now created keeps what was typed for it", async () => {
  const view = render(<Host sessionId={null} />);
  await settle();
  fireEvent.change(field(), { target: { value: "First message of a new thread" } });
  view.rerender(<Host sessionId="thread-new" />);
  await settle();
  await settle(300);
  expect(field().value).toBe("First message of a new thread");
  expect(stored.get("draft:thread-new")).toBe("First message of a new thread");
});

it("during a run an attachment in the draft holds back plain guidance, but not a send the scope chip decides", async () => {
  const view = render(<Host sessionId="thread-a" phase="running" attachments={files([ready])} />);
  await settle();
  fireEvent.change(field(), { target: { value: "Yes, delete them" } });
  fireEvent.click(send());
  await settle();
  // Attachments go with a new message: guidance for the run cannot carry them, and says so.
  expect(onSteer).not.toHaveBeenCalled();
  view.rerender(<Host sessionId="thread-a" phase="running" attachments={files([ready])} scope={<span>D-4</span>} />);
  fireEvent.click(send());
  await settle();
  expect(onSteer).toHaveBeenCalledExactlyOnceWith("Yes, delete them");
});

it("with a scope chip an attachment alone is nothing to send: no stand-in words are recorded as the answer", async () => {
  render(<Host sessionId="thread-a" attachments={files([ready])} scope={<span>D-4</span>} />);
  await settle();
  expect(send().disabled).toBe(true);
  fireEvent.keyDown(field(), { key: "Enter" });
  await settle();
  expect(onSend).not.toHaveBeenCalled();
});

it("without a chip an attachment alone is a message", async () => {
  render(<Host sessionId="thread-a" attachments={files([ready])} />);
  await settle();
  expect(send().disabled).toBe(false);
  fireEvent.click(send());
  await settle();
  expect(onSend).toHaveBeenCalledExactlyOnceWith("Here's the attached file.", expect.any(String));
});
