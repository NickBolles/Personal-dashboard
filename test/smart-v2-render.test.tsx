// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { SmartSurface } from "@/components/smart/SmartSurface";
import type { JarvisSpec } from "@/lib/jarvis-ui/catalog";
import type { AppliedEntry, SurfaceView } from "@/lib/jarvis-ui/types";

const matrix: JarvisSpec = {
  v: 1,
  catalog: "jarvis-ui@1",
  root: "r",
  elements: {
    r: {
      type: "DecisionMatrix",
      props: {
        title: "Iris matrix live",
        ref: "item:iris",
        criteria: [
          { id: "speed", label: "Speed", weight: 1 },
          { id: "quality", label: "Quality", weight: 2 },
        ],
        options: [
          { id: "a", label: "Iris patch", scores: { speed: 5, quality: 2 } },
          { id: "b", label: "Iris replace", scores: { speed: 1, quality: 5 } },
        ],
      },
    },
  },
};
const form: JarvisSpec = {
  v: 1,
  catalog: "jarvis-ui@1",
  root: "r",
  elements: {
    r: {
      type: "Form",
      props: {
        title: "Iris review live",
        fields: [
          { id: "wins", label: "Wins", kind: "textarea", proposed: "Iris verified dry run" },
          { id: "next", label: "Next week", kind: "textarea", required: true },
        ],
        submit: { label: "Submit", creates: [{ parentRef: "item:iris", titleField: "next", splitLines: true, maxItems: 3 }] },
      },
    },
  },
};
let view: SurfaceView;
let post: MockInstance<typeof api.post>;
function mount(spec: JarvisSpec, session = "iris-live") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SmartSurface spec={spec} sessionId={session} blockIndex={0} dropped={0} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  view = { id: "uis_irislive", specHash: "a".repeat(64), state: {}, applied: [], readOnly: false };
  vi.spyOn(api, "put").mockImplementation(async () => structuredClone(view) as never);
  vi.spyOn(api, "patch").mockImplementation(async (_p, body) => {
    view = { ...view, state: (body as { state: SurfaceView["state"] }).state };
    return structuredClone(view) as never;
  });
  post = vi.spyOn(api, "post").mockImplementation(async (path, body) => {
    if (path === "/api/smart/hydrate")
      return {
        today: "2026-11-06",
        refs: { "item:iris": { ref: "item:iris", kind: "item", title: "Iris workshop", status: "in_progress", due: "2026-11-07" } },
      } as never;
    if (path === "/api/smart/apply") {
      const input = body as { intents: unknown[]; idempotencyKey: string };
      const entries: AppliedEntry[] = input.intents.map((intent, i) => ({
        intent,
        intentHash: String(i + 1).padStart(32, "0"),
        ok: true,
        message: "Updated",
        at: "2026-11-06T18:00:00Z",
        key: input.idempotencyKey,
        undo: { type: "item" },
      }));
      view = { ...view, applied: entries };
      return { results: entries.map(({ intentHash, ok, message }) => ({ intentHash, ok, message })), surface: structuredClone(view) } as never;
    }
    if (path === "/api/smart/undo") {
      view = { ...view, applied: view.applied.map((e) => (e.intentHash === (body as { intentHash: string }).intentHash ? { ...e, undone: true } : e)) };
      return { surface: structuredClone(view) } as never;
    }
    throw new Error(`Unexpected ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("v2 live surface", () => {
  it("changes weights locally, stages one exact option, confirms apply and undoes", async () => {
    mount(matrix);
    const pick = await screen.findByRole("button", { name: "Iris patch" });
    await waitFor(() => expect((pick as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Raise weight: Speed" }));
    expect(screen.getByLabelText("Weight: Speed").textContent).toBe("2");
    expect(post.mock.calls.some(([p]) => p === "/api/smart/apply")).toBe(false);
    fireEvent.click(pick);
    expect(screen.getByTestId("smart-tray-count").textContent).toBe("1 change staged");
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    expect(post.mock.calls.some(([p]) => p === "/api/smart/apply")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
    await screen.findByText("✓ 1 applied");
    expect(view.applied[0]?.intent).toEqual({ kind: "item.update", ref: "item:iris", patch: { nextAction: "Decided: Iris patch" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo latest smart change" }));
    await waitFor(() => expect(view.applied[0]?.undone).toBe(true));
  });
  it("restores a durable form draft and Ctrl+Z reverses the whole recent apply, but never native text undo", async () => {
    const first = mount(form);
    const next = await screen.findByLabelText("Next week (required)");
    await waitFor(() => expect((next as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.getByText("proposed · from Jarvis data, editable")).toBeTruthy();
    fireEvent.change(next, { target: { value: "Iris next one\nIris next two" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(view.state.pending).toBe(2));
    first.unmount();
    mount(form);
    await waitFor(() => expect(screen.getByTestId("smart-tray-count").textContent).toBe("2 changes staged"));
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
    await screen.findByText("✓ 2 applied");
    const field = screen.getByLabelText("Next week (required)");
    fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    expect(view.applied.some((e) => e.undone)).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(view.applied.every((e) => e.undone)).toBe(true));
  });
  it("only the most recent surface consumes global Undo", async () => {
    mount(form, "iris-one");
    mount(form, "iris-two");
    const surfaces = await screen.findAllByTestId("smart-surface");
    for (const [i, el] of surfaces.entries()) {
      const s = within(el);
      await waitFor(() => expect((s.getByLabelText("Next week (required)") as HTMLTextAreaElement).disabled).toBe(false));
      fireEvent.change(s.getByLabelText("Next week (required)"), { target: { value: `Iris lane ${i}` } });
      fireEvent.click(s.getByRole("button", { name: "Submit" }));
      fireEvent.click(s.getByRole("button", { name: "Apply 1 change" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
      await waitFor(() => expect(s.queryByText("✓ 1 applied")).not.toBeNull());
    }
    post.mockClear();
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(post.mock.calls.filter(([p]) => p === "/api/smart/undo")).toHaveLength(1));
  });
});
