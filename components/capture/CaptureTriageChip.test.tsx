// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CaptureExtras } from "@/components/capture/CaptureExtras";
import { CaptureTriageCard } from "@/components/capture/CaptureTriageCard";
import { CaptureTriageChip } from "@/components/capture/CaptureTriageChip";
import { AiSettingsView } from "@/components/work/ai/AiSettingsView";
import { DEFAULT_AI_SETTINGS, type AiSettings, type MeterView } from "@/lib/ai";
import { DEFAULT_CAPTURE_ACTIONS } from "@/lib/capture-triage";
import { CAPTURE_TRIAGE_STATES, type CaptureTriageState, type CaptureTriageView } from "@/lib/capture-triage";
import { ApiError, api } from "@/lib/client/api";
import type { InboxEntry } from "@/lib/work";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/api", async (original) => ({
  ...(await original<typeof import("@/lib/client/api")>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useToast: () => ({ toast, announce: vi.fn() }),
}));
vi.mock("@/components/areas/ModelPicker", () => ({ ModelCombobox: () => null }));

const clients: QueryClient[] = [];
function mount(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(qc);
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const view = render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);
  return { ...view, qc, invalidate };
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((qc) => qc.clear());
  vi.resetAllMocks();
});

const base: CaptureTriageView = {
  id: "triage /one",
  inboxId: "inb_one",
  state: "done",
  summary: "Added the key battery to House projects on Skylight",
  itemId: "wk /one",
  decisionRef: null,
  runRef: "R-1",
  undoable: false,
  openHref: null,
  openLabel: null,
  error: null,
  at: "2026-11-12T17:00:00.000Z",
};

it.each([
  ["planned", "Triaging…", "ai"],
  ["applying", "Triaging…", "ai"],
  ["done", "Done", "ai"],
  ["needs_input", "Needs you", "wn"],
  ["suggested", "Suggested", "prop"],
  ["filed", "Filed", "neutral"],
  ["failed", "Triage failed", "bad"],
  ["undone", "Undone", "neutral"],
  ["skipped", "Left as captured", "neutral"],
] as const)("renders the %s label and tone", (state, label, tone) => {
  mount(<CaptureTriageChip triage={{ ...base, state }} />);
  expect(screen.getByTestId("capture-triage").getAttribute("data-state")).toBe(state);
  expect(screen.getByTestId("capture-triage").textContent).toContain(base.summary);
  const status = screen.getByText(label);
  const pill = status.closest(".k-pill");
  expect(pill?.classList.contains(`k-t-${tone}`)).toBe(true);
  expect(status.classList.contains("ai-shimmer")).toBe(state === "planned" || state === "applying");
});

it.each([true, false])("renders Undo only when undoable is %s", (undoable) => {
  mount(<CaptureTriageChip triage={{ ...base, undoable }} />);
  const undo = screen.queryByRole("button", { name: `Undo: ${base.summary}` });
  expect(Boolean(undo)).toBe(undoable);
});

it.each(CAPTURE_TRIAGE_STATES)("renders Retry only for failed, not %s", (state) => {
  mount(<CaptureTriageChip triage={{ ...base, state }} />);
  expect(Boolean(screen.queryByRole("button", { name: "Retry" }))).toBe(state === "failed");
});

it("links Needs you to its D-n decision", () => {
  mount(<CaptureTriageChip triage={{ ...base, state: "needs_input", decisionRef: "D-12" }} />);
  expect(screen.getByRole("link", { name: "D-12" }).getAttribute("href")).toBe("/decisions/D-12");
});

it.each([null, "Check Skylight"])("uses the correction label %s with a fallback", (openLabel) => {
  mount(<CaptureTriageChip triage={{ ...base, openHref: "/skylight", openLabel }} />);
  expect(screen.getByRole("link", { name: openLabel ?? "Correct" }).getAttribute("href")).toBe("/skylight");
});

it("omits Correct when there is no destination", () => {
  mount(<CaptureTriageChip triage={base} />);
  expect(screen.queryByRole("link", { name: "Correct" })).toBeNull();
});

it.each(CAPTURE_TRIAGE_STATES)("gates the item Open link for %s", (state) => {
  mount(<CaptureTriageChip triage={{ ...base, state }} />);
  const open = screen.queryByRole("link", { name: "Open" });
  expect(Boolean(open)).toBe(["done", "needs_input", "filed"].includes(state));
  if (open) expect(open.getAttribute("href")).toBe("/areas?item=wk%20%2Fone");
});

it("omits Open when no item was created", () => {
  mount(<CaptureTriageChip triage={{ ...base, itemId: null }} />);
  expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
});

it.each([
  ["done", "undo", "Undone"],
  ["failed", "retry", "Retrying triage"],
] as const)("posts %s actions and refreshes work and activity after success", async (state, action, message) => {
  const onChanged = vi.fn();
  vi.mocked(api.post).mockResolvedValue({ triage: { ...base, state: action === "undo" ? "undone" : "planned" } });
  const { invalidate } = mount(<CaptureTriageChip triage={{ ...base, state, undoable: action === "undo" }} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: action === "undo" ? `Undo: ${base.summary}` : "Retry" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(api.post).toHaveBeenCalledWith(`/api/capture/triage/triage%20%2Fone/${action}`, {});
  expect(toast).toHaveBeenCalledWith(message, "ok");
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activity"] });
});

it("disables mutation controls while an action is pending", async () => {
  let resolve!: (value: { triage: CaptureTriageView }) => void;
  vi.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((success) => {
        resolve = success;
      }),
  );
  const onChanged = vi.fn();
  mount(<CaptureTriageChip triage={{ ...base, state: "failed", undoable: true }} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole("button", { name: `Undo: ${base.summary}` }) as HTMLButtonElement).disabled).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
  await act(async () => resolve({ triage: base }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
});

it("reports a not_undoable conflict without claiming success", async () => {
  const onChanged = vi.fn();
  vi.mocked(api.post).mockRejectedValueOnce(new ApiError(409, "This action can no longer be undone", "not_undoable"));
  mount(<CaptureTriageChip triage={{ ...base, undoable: true }} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: `Undo: ${base.summary}` }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("This action can no longer be undone", "danger"));
  expect(onChanged).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalledWith("Undone", "ok");
});

it("keeps Retry available after a failed request", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Couldn't reach Jarvis"));
  mount(<CaptureTriageChip triage={{ ...base, state: "failed" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't reach Jarvis", "danger"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false));
});

it("renders no card while loading or when triage is null", async () => {
  let resolve!: (value: { triage: null }) => void;
  vi.mocked(api.get).mockImplementationOnce(
    () =>
      new Promise((success) => {
        resolve = success;
      }),
  );
  const { qc } = mount(<CaptureTriageCard itemId="wk /one" />);
  expect(screen.queryByTestId("capture-triage-card")).toBeNull();
  expect(api.get).toHaveBeenCalledWith("/api/capture/triage?item=wk%20%2Fone", expect.any(AbortSignal));
  await act(async () => resolve({ triage: null }));
  await waitFor(() => expect(qc.getQueryData(["capture-triage", "wk /one"])).toEqual({ triage: null }));
  expect(screen.queryByTestId("capture-triage-card")).toBeNull();
});

it.each(["done", "filed"] as const)("shows the capture card and only reminds done captures to settle (%s)", async (state: CaptureTriageState) => {
  vi.mocked(api.get).mockResolvedValueOnce({ triage: { ...base, state } });
  mount(<CaptureTriageCard itemId="wk /one" />);
  const card = await screen.findByTestId("capture-triage-card");
  expect(card.getAttribute("role")).toBe("status");
  expect(card.textContent).toContain("From your capture");
  expect(card.textContent?.includes("Check it and settle when you're happy — Jarvis never settles on its own.")).toBe(state === "done");
});

it("refetches the capture card after Undo and shows the verified response", async () => {
  vi.mocked(api.get)
    .mockResolvedValueOnce({ triage: { ...base, undoable: true } })
    .mockResolvedValueOnce({ triage: { ...base, state: "undone", summary: "Removed from Skylight", undoable: false } });
  vi.mocked(api.post).mockResolvedValueOnce({ triage: { ...base, state: "undone", undoable: false } });
  const { invalidate } = mount(<CaptureTriageCard itemId="wk /one" />);
  fireEvent.click(await screen.findByRole("button", { name: `Undo: ${base.summary}` }));
  await waitFor(() => expect(screen.getByTestId("capture-triage").getAttribute("data-state")).toBe("undone"));
  expect(screen.getByTestId("capture-triage-card").textContent).toContain("Removed from Skylight");
  expect(screen.queryByRole("button", { name: /^Undo:/ })).toBeNull();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["capture-triage", "wk /one"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work"] });
});

it.each([true, false])("preserves legacy queued feedback without duplicating a triage chip (%s)", (hasTriage) => {
  const entry: InboxEntry = {
    id: "inb_one",
    source: "capture",
    title: "Replace key battery",
    note: "",
    url: null,
    repo: null,
    number: null,
    reason: "Quick capture",
    createdAt: base.at,
    capture: {
      channel: null,
      triageState: "queued",
      triageSkipReason: null,
      suggestedTitle: null,
      suggestedKind: null,
      suggestion: null,
      sensitivity: "none",
      report: null,
      attachments: [],
      investigating: false,
      triage: hasTriage ? { ...base, state: "planned" } : null,
    },
  };
  mount(<CaptureExtras entry={entry} onAccepted={vi.fn()} />);
  expect(screen.getAllByText("Triaging…")).toHaveLength(1);
  expect(Boolean(screen.queryByTestId("capture-triage"))).toBe(hasTriage);
});

function mountSettings(settings: AiSettings) {
  const meter: MeterView = {
    mode: "api",
    provider: null,
    label: "API",
    state: "api",
    usedPct: null,
    stopAtPct: 48,
    resetsAt: null,
    fetchedAt: null,
    backgroundAllowed: true,
    summary: "Budget mode",
    warning: null,
  };
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/api/settings/ai")
      return {
        settings,
        runner: { armed: false, running: 0, queued: 0, budgetBlocked: 0, lastTickAt: null, lastError: null },
        dispatcher: { running: false, lastRunAt: null, lastSent: 0, lastError: null },
        today: { spentUsd: 0, reservedUsd: 0, day: "2026-11-12" },
        meter,
        hermesConfigured: true,
      };
    return { days: [], totals: { jobs: 0, costUsd: 0, overCap: 0 } };
  });
  return mount(<AiSettingsView />);
}

it("defaults capture actions for older settings without an actions block", async () => {
  const { actions: _actions, ...capture } = DEFAULT_AI_SETTINGS.capture;
  mountSettings({ ...DEFAULT_AI_SETTINGS, capture });
  const auto = await screen.findByRole("checkbox", { name: /^Auto-handle captures/ });
  expect((auto as HTMLInputElement).checked).toBe(true);
  const mode = screen.getByRole("combobox", { name: "When it can act" }) as HTMLSelectElement;
  expect(mode.value).toBe("act");
  expect(mode.id).toBe("ai-capture-actions-mode");
  for (const name of ["Skylight list items", "Skylight calendar events", "Jarvis to-dos"]) {
    const allow = screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect(allow.checked).toBe(true);
    expect(allow.disabled).toBe(false);
  }
});

it("disables capture mode and allowlist when auto-handle is off", async () => {
  mountSettings({ ...DEFAULT_AI_SETTINGS, capture: { ...DEFAULT_AI_SETTINGS.capture, actions: { ...DEFAULT_CAPTURE_ACTIONS, autoHandle: false } } });
  await screen.findByRole("checkbox", { name: /^Auto-handle captures/ });
  expect((screen.getByRole("combobox", { name: "When it can act" }) as HTMLSelectElement).disabled).toBe(true);
  for (const name of ["Skylight list items", "Skylight calendar events", "Jarvis to-dos"]) {
    expect((screen.getByRole("checkbox", { name }) as HTMLInputElement).disabled).toBe(true);
  }
});

it.each([
  ["autoHandle", "Auto-handle captures"],
  ["mode", "When it can act"],
  ["skylightList", "Skylight list items"],
  ["skylightEvent", "Skylight calendar events"],
  ["jarvisTask", "Jarvis to-dos"],
] as const)("saves capture %s without dropping existing settings", async (key, label) => {
  const actions = { ...DEFAULT_CAPTURE_ACTIONS, minConfidence: 0.9 };
  const settings = { ...DEFAULT_AI_SETTINGS, capture: { ...DEFAULT_AI_SETTINGS.capture, stripLocation: true, actions } };
  vi.mocked(api.put).mockResolvedValue({});
  const { invalidate } = mountSettings(settings);
  await screen.findByRole("checkbox", { name: /^Auto-handle captures/ });
  if (key === "mode") {
    fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value: "triage_only" } });
  } else {
    fireEvent.click(screen.getByRole("checkbox", { name: key === "autoHandle" ? /^Auto-handle captures/ : label }));
  }
  const expectedActions =
    key === "autoHandle"
      ? { ...actions, autoHandle: false }
      : key === "mode"
        ? { ...actions, mode: "triage_only" }
        : { ...actions, allow: { ...actions.allow, [key]: false } };
  await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/ai", { capture: { ...settings.capture, actions: expectedActions } }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved", "ok"));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["settings", "ai"] });
});
