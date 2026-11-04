import { describe, expect, it } from "vitest";
import { pageContext, withPageContext } from "@/lib/coordinator/page-context";

describe("coordinator page context", () => {
  it("labels ordinary pages and chat without exposing session ids as labels", () => {
    expect(pageContext("/home")).toEqual({ label: "Today", path: "/home" });
    expect(pageContext("/decisions")).toEqual({ label: "Needs you", path: "/decisions" });
    expect(pageContext("/chat/s1")).toEqual({ label: "Chat › Conversation", path: "/chat/s1" });
    expect(pageContext("/")?.label).toBe("Today");
  });
  it("resolves an area/item breadcrumb and preserves routing query state only", () => {
    expect(
      pageContext("/areas", "item=door&view=tree&secret=do-not-attach", { area: { id: "garage", title: "Garage" }, item: { id: "door", title: "Fix door" } }),
    ).toEqual({ label: "Areas › Garage › Fix door", path: "/areas?item=door&view=tree", itemId: "door" });
    expect(pageContext("/areas", "item=garage", { area: { id: "garage", title: "Garage" }, item: { id: "garage", title: "Garage" } })?.label).toBe(
      "Areas › Garage",
    );
    expect(pageContext("/areas", "item=door", { area: { title: "Garage" }, parents: ["Repairs"], item: { id: "door", title: "Fix door" } })?.label).toBe(
      "Areas › Garage › Repairs › Fix door",
    );
  });
  it.each(["/finance", "/finance/cards", "/finance/", "/Finance/funds"])("never attaches %s", (path) => expect(pageContext(path)).toBeNull());
  it.each([
    { title: "Finance" },
    { title: "Finances" },
    { title: "Financial planning" },
    { title: "Private", systemKey: "finance" },
    { title: "Private", aiPolicy: "excluded" },
  ])("excludes Finance or AI-excluded areas %j", (area) => {
    expect(pageContext("/areas", "item=door", { area, item: { id: "door", title: "Private" } })).toBeNull();
  });
  it("fails closed until item ancestry is resolved", () => {
    expect(pageContext("/areas", "item=unknown")).toBeNull();
    expect(pageContext("/areas", "node=unknown")).toBeNull();
    expect(pageContext("/areas", "item=unknown", { area: { title: "Garage" }, item: { id: "other", title: "Other" } })).toBeNull();
    expect(pageContext("//evil.test")).toBeNull();
  });
  it("prepends exactly one sanitized line only when explicitly sending with a context", () => {
    const context = pageContext("/areas", "item=door", { area: { title: "Garage\n[bad]" }, item: { id: "door", title: "Fix door" } });
    expect(withPageContext("Hello\nWorld", context)).toBe("[Viewing: Areas › Garage  bad › Fix door — /areas?item=door]\nHello\nWorld");
    expect(withPageContext("Hello", null)).toBe("Hello");
    expect(withPageContext("Hello", pageContext("/finance"))).toBe("Hello");
  });
});
