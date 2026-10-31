import { describe, expect, it } from "vitest";
import { canonicalUrl, classifyUrl, extractLinks, findUrls, linkFallbackTitle } from "@/lib/chat-links";
import { addPick, flattenSections, isFinanceContext, togglePick } from "@/lib/chat-context";
import type { TimelineItem } from "@/lib/hermes";

describe("chat links: URL extraction", () => {
  it("finds URLs and trims trailing punctuation / markdown", () => {
    expect(findUrls("see https://example.com/a. and (https://x.dev/b) or <https://y.io>, `https://z.io/c`")).toEqual([
      "https://example.com/a",
      "https://x.dev/b",
      "https://y.io",
      "https://z.io/c",
    ]);
    expect(findUrls("[board](https://artifacts.ai.nickbolles.com/v/jarvis-x/)!")).toEqual(["https://artifacts.ai.nickbolles.com/v/jarvis-x/"]);
  });

  it("canonicalises host, fragment, www, tracking params, trailing slash", () => {
    expect(canonicalUrl("https://WWW.Example.com/a/?utm_source=x#top")).toBe("https://example.com/a");
    expect(canonicalUrl("https://user:pw@example.com/")).toBeNull();
    expect(canonicalUrl("ftp://example.com")).toBeNull();
  });

  it("classifies artifact /v/ and /a/ forms to the same slug", () => {
    const v = classifyUrl("https://artifacts.ai.nickbolles.com/v/jarvis-chat-context-20261030/");
    const a = classifyUrl("https://artifacts.ai.nickbolles.com/a/jarvis-chat-context-20261030/shot.png");
    expect(v).toMatchObject({ kind: "artifact", slug: "jarvis-chat-context-20261030" });
    expect(a?.url).toBe(v?.url);
    expect(classifyUrl("https://artifacts.ai.nickbolles.com/")?.kind).toBe("web");
  });

  it("classifies GitHub PRs and issues", () => {
    expect(classifyUrl("https://github.com/NickBolles/Personal-dashboard/pull/66/files")).toMatchObject({
      kind: "github",
      repo: "NickBolles/Personal-dashboard",
      number: 66,
      ghType: "pull",
      url: "https://github.com/NickBolles/Personal-dashboard/pull/66",
    });
    expect(classifyUrl("https://github.com/a/b/issues/7")).toMatchObject({ ghType: "issue", number: 7 });
    expect(classifyUrl("https://github.com/a/b")?.kind).toBe("web");
  });

  it("extracts from user, assistant and tool messages and dedupes", () => {
    const tl: TimelineItem[] = [
      { kind: "user", id: "1", text: "check https://github.com/a/b/pull/3", at: "t1" },
      { kind: "assistant", id: "2", text: "Board: https://artifacts.ai.nickbolles.com/v/s1/ and https://github.com/a/b/pull/3#issuecomment-1" },
      {
        kind: "tool",
        id: "3",
        tool: "terminal",
        summary: "curl",
        detail: "published https://artifacts.ai.nickbolles.com/a/s1/index.html https://docs.example.org/x",
      },
    ];
    const links = extractLinks(tl);
    expect(links.map((l) => [l.kind, l.source])).toEqual([
      ["github", "user"],
      ["artifact", "assistant"],
      ["web", "tool"],
    ]);
    expect(links[0].firstSeenAt).toBe("t1");
    expect(linkFallbackTitle(links[0])).toBe("a/b#3");
    expect(linkFallbackTitle(links[1])).toBe("s1");
    expect(linkFallbackTitle(links[2])).toBe("docs.example.org/x");
  });
});

describe("chat context: finance block + picks", () => {
  it("blocks finance references", () => {
    expect(isFinanceContext({ type: "item", id: "abc", url: "/finance/accounts" })).toBe(true);
    expect(isFinanceContext({ type: "finance", id: "x" })).toBe(true);
    expect(isFinanceContext({ type: "file", id: "https://jarvis.nickbolles.com/api/finance/tx" })).toBe(true);
    expect(isFinanceContext({ type: "item", id: "monarch:123" })).toBe(true);
    expect(isFinanceContext({ type: "item", id: "abc", label: "Refinance thoughts" })).toBe(false);
  });

  it("adds, dedupes, toggles and refuses finance", () => {
    let r = addPick([], { type: "area", id: "a1", label: "Home" });
    expect(r.list).toHaveLength(1);
    r = addPick(r.list, { type: "area", id: "a1", label: "Home" });
    expect(r.list).toHaveLength(1);
    const f = addPick(r.list, { type: "file", id: "/finance/x", label: "Budget" });
    expect(f.blocked).toBe(true);
    expect(f.list).toHaveLength(1);
    expect(togglePick(r.list, { type: "area", id: "a1", label: "Home" }).list).toHaveLength(0);
  });

  it("flattens sections with current-area suggestions first", () => {
    const rows = flattenSections(
      [
        {
          label: "Areas",
          options: [
            { type: "area", id: "a", label: "Garage" },
            { type: "area", id: "b", label: "Health" },
          ],
        },
        {
          label: "Work",
          options: [
            { type: "item", id: "i", label: "Fix door", detail: "Health › Gym" },
            { type: "item", id: "i", label: "dup" },
          ],
        },
      ],
      "Health",
    );
    expect(rows.map((r) => [r.key, r.section])).toEqual([
      ["area:b", "Suggested"],
      ["item:i", "Suggested"],
      ["area:a", "Areas"],
    ]);
  });
});
