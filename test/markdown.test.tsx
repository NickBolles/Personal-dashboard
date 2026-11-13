import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, MarkdownRefRenderer, safeHref } from "@/components/markdown/Markdown";
import { MARKDOWN_FIXTURE } from "@/lib/markdown-fixture";

const html = (t: string, opts: { sourceCount?: number; headingOffset?: number } = {}) => renderToStaticMarkup(<Markdown text={t} {...opts} />);

describe("Markdown renderer", () => {
  const out = html(MARKDOWN_FIXTURE);

  it("renders headings with an offset under the page's own headings", () => {
    expect(out).toContain('<h3 class="md-h ai-h" data-level="1">Rollout plan</h3>');
    expect(out).toContain('data-level="2">Steps</h4>');
    expect(html("# A", { headingOffset: 0 })).toContain("<h1");
  });

  it("renders inline formatting, links and line breaks", () => {
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<del>struck</del>");
    expect(out).toContain("<code>inline code</code>");
    expect(out).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer nofollow">safe link</a>');
    expect(out).toContain("safe link</a>.<br/>A second line");
    expect(out).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a</a>,');
  });

  it("renders nested ordered/unordered lists and task lists", () => {
    expect(out).toMatch(
      /<ol class="ai-ol"><li><p>Audit compatibility<\/p><\/li><li><p>Migrate config<\/p><ul class="ai-ul"><li><p>nested bullet<\/p><\/li><li><p>another one<\/p><ol class="ai-ol"><li><p>deep ordered<\/p><\/li><\/ol><\/li><\/ul><\/li><li><p>Roll out<\/p><\/li><\/ol>/,
    );
    expect(out).toContain(
      '<li class="md-task"><input type="checkbox" disabled="" readOnly="" aria-label="Done" checked=""/><div class="md-task-body"><p>Write the spec</p></div></li>',
    );
    expect(out).toContain('aria-label="Not done"/><div class="md-task-body"><p>Ship it</p></div>');
    expect(html("3. three\n4. four")).toContain('<ol start="3"');
    // a nested checklist stays inside the parent's block body
    expect(html("- [ ] Parent\n  - [ ] Child")).toMatch(/<div class="md-task-body"><p>Parent<\/p><ul class="ai-ul"><li class="md-task">.*Child.*<\/ul><\/div>/);
  });

  it("renders blockquotes (nested), rules, fenced code with a copy button, and tables", () => {
    expect(out).toContain("<blockquote><p>Quote: a merged PR is not proof.</p><blockquote><p>Nested quote</p></blockquote></blockquote>");
    expect(out).toContain("<hr/>");
    expect(out).toContain('<div class="md-code"><div class="md-code-bar"><span>ts</span><button type="button" aria-label="Copy ts">Copy</button></div>');
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain('<div class="md-table" role="region" aria-label="Table" tabindex="0"><table>');
    expect(out).toContain('<th style="text-align:right">Baseline</th>');
    expect(out).toContain('<td style="text-align:center">&lt; 1 %</td>');
  });

  it("shows raw HTML as text and drops unsafe links", () => {
    expect(out).toContain("raw &lt;b&gt;html&lt;/b&gt; stays text");
    expect(out).not.toContain("<b>");
    expect(out).not.toMatch(/href="javascript/i);
    expect(out).toContain("bad is not a link");
  });

  it.each([
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "[x](javascript:alert(1))",
    "[x](//evil.example/x)",
    "<javascript:alert(1)>",
    "| a |\n|---|\n| <img src=x onerror=alert(1)> |",
    "> <iframe src=//evil></iframe>",
    "- [x](data:text/html,hi)",
  ])("neutralises %s", (t) => {
    expect(html(t)).not.toMatch(/<script|<img|<iframe|onerror="|href="(javascript|data|vbscript|\/\/)/i);
  });

  it("keeps balanced parentheses in bare URLs and drops trailing punctuation", () => {
    expect(html("See https://en.wikipedia.org/wiki/Function_(mathematics).")).toContain('href="https://en.wikipedia.org/wiki/Function_(mathematics)"');
    expect(html("(see https://example.com/a)")).toContain(
      'href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a</a>)',
    );
  });

  it("never nests links (a URL used as a link label)", () => {
    const out = html("[https://example.com](https://example.com/docs) and [see <https://x.test>](/areas)");
    expect(out.match(/<a /g)).toHaveLength(2);
    expect(out).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer nofollow">https://example.com</a>');
    expect(out).toContain('<a href="/areas">see https://x.test</a>');
  });

  it("allows only http(s), mailto and same-origin hrefs", () => {
    expect(safeHref("/areas?item=1")).toBe("/areas?item=1");
    expect(safeHref("#report-source-1")).toBe("#report-source-1");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  it("keeps an unterminated fence (a streaming reply) as code, and escapes", () => {
    expect(html("```\nconst a = 1;")).toContain("<code>const a = 1;</code>");
    expect(html("\\*not em\\* and snake_case_name")).toBe('<div class="md"><p>*not em* and snake_case_name</p></div>');
  });
});

describe("D-n / R-n references in prose (MarkdownRefRenderer)", () => {
  /** A surface that draws references as chips (the Chief of staff thread does, with a button that jumps to the thing). */
  const chips = (t: string) =>
    renderToStaticMarkup(
      <MarkdownRefRenderer.Provider value={(ref) => <mark data-ref={ref}>{ref}</mark>}>
        <Markdown text={t} />
      </MarkdownRefRenderer.Provider>,
    );
  const refs = (t: string) => Array.from(chips(t).matchAll(/<mark data-ref="([^"]+)">/g), (m) => m[1]);

  it("with no provider the output is unchanged: a reference is the text that was written", () => {
    expect(html("See R-7 and **D-12**.")).toBe('<div class="md"><p>See R-7 and <strong>D-12</strong>.</p></div>');
    expect(html("- R-7 is done\n- D-12 waits")).toContain("<li><p>R-7 is done</p></li><li><p>D-12 waits</p></li>");
    // a provider that is explicitly null (a thread with nowhere to jump to) is the same as none
    expect(
      renderToStaticMarkup(
        <MarkdownRefRenderer.Provider value={null}>
          <Markdown text="See R-7." />
        </MarkdownRefRenderer.Provider>,
      ),
    ).toBe(html("See R-7."));
  });

  it("with a provider each reference in prose is drawn by it, wherever prose is: bold, lists, headings, tables, quotes", () => {
    expect(chips("See R-7 and **D-12**.")).toBe(
      '<div class="md"><p>See <mark data-ref="R-7">R-7</mark> and <strong><mark data-ref="D-12">D-12</mark></strong>.</p></div>',
    );
    expect(refs("# About R-1\n\n- D-2 waits\n- _R-3_ is done\n\n> R-4 said so\n\n| Run | State |\n| --- | --- |\n| R-5 | done |")).toEqual([
      "R-1",
      "D-2",
      "R-3",
      "R-4",
      "R-5",
    ]);
    // punctuation and brackets around a reference do not hide it; the same one twice is two chips
    expect(refs("(R-7), R-8; D-9: “R-7”. R-10?")).toEqual(["R-7", "R-8", "D-9", "R-7", "R-10"]);
    expect(refs("R-1")).toEqual(["R-1"]);
  });

  it("never draws a reference inside inline code, a code fence or a link label, or out of a URL", () => {
    expect(chips("Run `R-7` then ``D-8``")).toBe('<div class="md"><p>Run <code>R-7</code> then <code>D-8</code></p></div>');
    expect(refs("```\nfix R-7 and D-8\n```")).toEqual([]);
    expect(refs("~~~sh\necho R-7\n~~~")).toEqual([]);
    const linked = chips("[R-7 notes](https://example.com/notes) and [the log](/areas?item=R-8), then https://example.com/runs/R-9 and R-10");
    expect(linked).toContain('<a href="https://example.com/notes" target="_blank" rel="noopener noreferrer nofollow">R-7 notes</a>');
    expect(linked).toContain('<a href="/areas?item=R-8">the log</a>');
    expect(linked).toContain(">https://example.com/runs/R-9</a>");
    // only the one written as prose is a chip
    expect(Array.from(linked.matchAll(/<mark data-ref="([^"]+)">/g), (m) => m[1])).toEqual(["R-10"]);
  });

  it("only a whole D-n / R-n is a reference: PR-7, R-7b, R-7-beta, r-7 and R- 7 are words", () => {
    for (const text of ["PR-7 merged", "see R-7b", "tag R-7-beta", "r-7 and d-3", "R- 7", "R-", "D-x1", "XD-4", "R-12345678901", "R–7", "aR-7"]) {
      expect(refs(text), text).toEqual([]);
      expect(chips(text), text).toBe(html(text));
    }
    // right next to them, a real one still is
    expect(refs("PR-7 closes R-7; R-7b follows D-3.")).toEqual(["R-7", "D-3"]);
    expect(refs("R-0 and D-123456789")).toEqual(["R-0", "D-123456789"]);
  });
});
