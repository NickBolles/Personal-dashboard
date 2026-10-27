import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeHref } from "@/components/markdown/Markdown";
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
    expect(out).toContain('<li class="md-task"><input type="checkbox" disabled="" readOnly="" aria-label="Done" checked=""/><p>Write the spec</p></li>');
    expect(out).toContain('aria-label="Not done"/><p>Ship it</p>');
    expect(html("3. three\n4. four")).toContain('<ol start="3"');
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
