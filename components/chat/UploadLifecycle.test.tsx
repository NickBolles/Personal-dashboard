// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useChatAttachments } from "./Attachments";
vi.mock("@/lib/client/api", () => ({ api: { get: vi.fn(async () => ({ files: [] })), del: vi.fn(async () => ({})) } }));
class Xhr {
  static all: Xhr[] = [];
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  onloadend?: () => void;
  status = 200;
  response: unknown;
  aborted = false;
  open() {}
  setRequestHeader() {}
  send() {
    Xhr.all.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
    this.onloadend?.();
  }
}
beforeEach(() => {
  Xhr.all = [];
  vi.stubGlobal("XMLHttpRequest", Xhr);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:owned"), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("tracks real bytes, keeps processing indeterminate until server confirmation, and cancels on removal", async () => {
  const { result } = renderHook(() => useChatAttachments("fixture"));
  act(() => result.current.add([new File(["photo"], "test.png", { type: "image/png" })]));
  expect(Xhr.all).toHaveLength(1);
  const xhr = Xhr.all[0];
  act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 10 }));
  expect(result.current.drafts[0].progress).toBe(30);
  act(() => xhr.upload.onload?.());
  expect(result.current.drafts[0]).toMatchObject({ progress: null, status: "uploading" });
  expect(result.current.readyIds).toEqual([]);
  act(() => result.current.remove(result.current.drafts[0].localId));
  expect(xhr.aborted).toBe(true);
  expect(result.current.drafts).toEqual([]);
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned"));
});
it("retries a failed upload once and ignores repeated retry taps while active", async () => {
  const { result } = renderHook(() => useChatAttachments("fixture"));
  act(() => result.current.add([new File(["photo"], "test.png", { type: "image/png" })]));
  await act(async () => {
    Xhr.all[0].onerror?.();
  });
  expect(result.current.drafts[0].status).toBe("error");
  const id = result.current.drafts[0].localId;
  act(() => {
    result.current.retry(id);
    result.current.retry(id);
  });
  expect(Xhr.all).toHaveLength(2);
  await act(async () => {
    Xhr.all[1].response = { file: { id: "cf_fixture", kind: "image", name: "test.png" } };
    Xhr.all[1].onload?.();
  });
  expect(result.current.readyIds).toEqual(["cf_fixture"]);
  expect(result.current.drafts).toHaveLength(1);
});
