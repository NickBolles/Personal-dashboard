// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "@/components/markdown/Markdown";
import { ChatLinkProvider } from "./ChatLinkProvider";
import type { PanelLink } from "@/server/chat/links";
afterEach(cleanup);
it("chips only recognized safe links and keeps plain web links ordinary", () => {
  render(
    <ChatLinkProvider links={[]}>
      <Markdown text="[Board](/v/board) [PR](https://github.com/n/r/pull/1) [Item](/areas?item=wk_1) [Web](https://example.com) [Bad](javascript:alert(1))" />
    </ChatLinkProvider>,
  );
  for (const name of ["Board", "PR", "Item"]) expect(screen.getByRole("link", { name }).getAttribute("class")).toContain("chat-inline-chip");
  expect(screen.getByRole("link", { name: "Web" }).getAttribute("class")).toBeNull();
  expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
});
it("reuses reported link states, including canonical relative artifact links", () => {
  const links: PanelLink[] = [
    { url: "https://github.com/n/r/pull/1", domain: "github.com", kind: "github", ghType: "pull", title: "Failed checks", state: "failed", pinned: false },
    { url: "https://github.com/n/r/issues/2", domain: "github.com", kind: "github", ghType: "issue", title: "Open issue", state: "open", pinned: false },
    { url: "https://artifacts.ai.nickbolles.com/v/board/", domain: "artifacts.ai.nickbolles.com", kind: "artifact", title: "Known board", pinned: false },
  ];
  render(
    <ChatLinkProvider links={links}>
      <Markdown text="[PR](https://github.com/n/r/pull/1) [Issue](https://github.com/n/r/issues/2) [Board](/a/board/index.html) [Finance](/finance?item=wk_1)" />
    </ChatLinkProvider>,
  );
  expect(screen.getByRole("link", { name: "Failed checks" }).querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("red");
  expect(screen.getByRole("link", { name: "Open issue" }).querySelector("[data-state]")?.getAttribute("data-state")).toBe("open");
  expect(screen.getByRole("link", { name: "Known board" }).getAttribute("href")).toBe("/a/board/index.html");
  expect(screen.getByRole("link", { name: "Finance" }).getAttribute("class")).toBeNull();
});
