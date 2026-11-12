import { describe, expect, it } from "vitest";
import { withPageContext } from "@/lib/coordinator/page-context";
import { decisionLogText } from "@/lib/decisions";
import { answererName, parseUserMessage, plainMessageLine, plainStatusWords, sameLabel, scheduledTitle, splitAttachedContext, splitLead } from "./display";

describe("parseUserMessage", () => {
  it("lifts the page context the coordinator composer prepends", () => {
    const sent = withPageContext("Skip the weekly chores\nand hide repeats", { label: "Todos", path: "/todos" });
    expect(parseUserMessage(sent)).toEqual({ context: { label: "Todos", path: "/todos" }, decision: null, text: "Skip the weekly chores\nand hide repeats" });
  });
  it("keeps breadcrumb labels and query paths intact", () => {
    const sent = withPageContext("Why is this blocked?", { label: "Areas › Portfolio › Store launch", path: "/areas?item=wi_1" });
    expect(parseUserMessage(sent).context).toEqual({ label: "Areas › Portfolio › Store launch", path: "/areas?item=wi_1" });
  });
  it("recognises a one-tap decision receipt", () => {
    const sent = `Decision on "Feature names": ${decisionLogText("Use plain names? Recommendation: keep them.", "Keep plain names (recommended)")}`;
    expect(parseUserMessage(sent)).toEqual({
      context: null,
      decision: { title: "Feature names", question: "Use plain names? Recommendation: keep them.", answer: "Keep plain names (recommended)" },
      text: "",
    });
  });
  it("leaves ordinary text, mid-message brackets and near misses alone", () => {
    for (const text of ["Plain message", "Look at [Viewing: x — /y] later", "[Viewing: no path]\nhello", 'Decision on "x": something else']) {
      expect(parseUserMessage(text)).toEqual({ context: null, decision: null, text });
    }
  });
});

describe("splitAttachedContext", () => {
  it("separates what was typed from what Jarvis attached", () => {
    expect(splitAttachedContext("Look at this\n\n---\nContext from Jarvis:\n- Storefront [item:wi_1]")).toEqual({
      body: "Look at this",
      attached: "- Storefront [item:wi_1]",
    });
    expect(splitAttachedContext("Plain")).toEqual({ body: "Plain", attached: "" });
  });
});

describe("plainStatusWords", () => {
  it("rewrites known work statuses only, outside code spans", () => {
    expect(plainStatusWords("This item is ready_to_settle; keep `in_progress` and my_var.")).toBe(
      "This item is ready to settle; keep `in_progress` and my_var.",
    );
  });
});

describe("splitLead", () => {
  it("returns short text whole", () => {
    expect(splitLead("Rotate the storefront DB password?")).toEqual({ lead: "Rotate the storefront DB password?", rest: "", whole: true });
  });
  it("leads with the first sentence of a paragraph and keeps the remainder", () => {
    const text =
      "@devchief proposes: settle. Owner requested settlement of ready-to-settle items. Its record reports cleanup completed on 2026-11-02, with no dependents.";
    const { lead, rest, whole } = splitLead(text);
    expect(whole).toBe(true);
    expect(lead).toBe("@devchief proposes: settle.");
    expect(rest).toBe("Owner requested settlement of ready-to-settle items. Its record reports cleanup completed on 2026-11-02, with no dependents.");
  });
  it("cuts at a word boundary when there is no early sentence end, keeping the full text as the body", () => {
    const text = `${"word ".repeat(40)}end`;
    const { lead, rest, whole } = splitLead(text, 60);
    expect(whole).toBe(false);
    expect(lead.endsWith("…")).toBe(true);
    expect(lead.length).toBeLessThanOrEqual(61);
    expect(rest).toBe(text);
  });
});

describe("sameLabel", () => {
  it("treats punctuation/case variants and prefix repeats as the same", () => {
    expect(sameLabel("Rotate the Storefront DB password", "rotate the storefront db password?")).toBe(true);
    expect(sameLabel("Store launch readiness: what's the call?", "Store launch readiness")).toBe(true);
    expect(sameLabel("Decide: move staging to the new region", "Move staging to the new region")).toBe(true);
  });
  it("keeps different or trivially short labels apart", () => {
    expect(sameLabel("Spend approvals", "Logo list")).toBe(false);
    expect(sameLabel("CI", "CI health")).toBe(false);
    expect(sameLabel("Checkout refactor", "The checkout refactor merged on 2026-11-06 and the item is ready to settle, but one test is flaky")).toBe(false);
    expect(sameLabel(null, "x")).toBe(false);
  });
});

describe("plainMessageLine", () => {
  it("shows the person's words, never the page-context wrapper", () => {
    expect(plainMessageLine("[Viewing: Todos — /todos]\nSupport skipping\n a recurring todo")).toBe("Support skipping a recurring todo");
    expect(plainMessageLine("[Viewing: Todos — /todos] Support skipping")).toBe("Support skipping");
    expect(plainMessageLine("Plain question")).toBe("Plain question");
  });
  it("reads a decision receipt as the choice and a bare wrapper as the page", () => {
    expect(plainMessageLine('Decision on "Rollout": Decision: Ship now or wait? → Wait')).toBe("Decided: Wait");
    expect(plainMessageLine("[Viewing: Today — /home]\n")).toBe("Viewing Today");
  });
});

describe("scheduledTitle", () => {
  it("recognises only the explicit cron delivery prefix", () => {
    expect(scheduledTitle("[Cron delivery: nightly-backup] Backup report")).toEqual({ job: "nightly-backup", title: "Backup report" });
    expect(scheduledTitle("[cron delivery: digest]")).toEqual({ job: "digest", title: "digest" });
    expect(scheduledTitle("Daily Compass Morning brief")).toBeNull();
    expect(scheduledTitle("Notes on [Cron delivery: x] syntax")).toBeNull();
  });
});

describe("answererName", () => {
  it("names the routed agent, else the assistant", () => {
    expect(answererName({ agentProfile: "chiefofstaff", assistant: "Hermes" })).toBe("@chiefofstaff");
    expect(answererName({ agentProfile: null, assistant: "Claude" })).toBe("Claude");
    expect(answererName({ assistant: "Hermes" })).toBe("Hermes");
  });
});
