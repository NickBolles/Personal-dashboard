// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolStep } from "./ToolStep";
import { AttachmentChips, type DraftFile } from "./Attachments";
import { toolOutcome } from "@/lib/tool-outcome";
afterEach(cleanup);
describe("chat refinements", () => {
  it("keeps JSON behind two disclosures and shows semantic file path", () => {
    render(<ToolStep tool="read_file" input={'{"path":"/src/a.ts","extra":"raw-only"}'} output="private output" />);
    expect(screen.getByRole("button").textContent).toContain("Read a file · /src/a.ts");
    expect(screen.queryByText("private output")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Arguments and output")).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });
  it("only links returned Jarvis item metadata and never treats proposals as completion", () => {
    expect(toolOutcome("jarvis_update_item", '{"item":{"id":"wk_abc","title":"Item","status":"active"}}')).toEqual({
      label: "Updated item · Item",
      href: "/areas?item=wk_abc",
      status: "active",
    });
    expect(toolOutcome("jarvis_update_item", '{"error":"failed","item":{"id":"wk_abc"}}')).toBeUndefined();
    expect(toolOutcome("jarvis_request_change", '{"proposed":true}')).toEqual({ label: "Proposed · awaiting owner" });
    expect(toolOutcome("jarvis_update_item", '{"item":')).toBeUndefined();
  });
  it("has honest determinate and unknown progress and a draft-photo button", () => {
    const d: DraftFile = { localId: "one", kind: "image", name: "photo.jpg", size: 50, progress: null, status: "uploading", previewUrl: "blob:owned" };
    const { rerender } = render(<AttachmentChips drafts={[d]} onRemove={() => {}} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    expect(screen.getByRole("button", { name: "Open picture photo.jpg" }).getAttribute("type")).toBe("button");
    rerender(<AttachmentChips drafts={[{ ...d, progress: 37 }]} onRemove={() => {}} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("37");
    fireEvent.click(screen.getByRole("button", { name: "Open picture photo.jpg" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zoom picture" }));
    expect(screen.getByRole("button", { name: "Fit picture" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
