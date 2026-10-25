import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown, safeHref } from "@/components/work/ai/SafeMarkdown";

const html = (t: string, n = 0) => renderToStaticMarkup(<SafeMarkdown text={t} sourceCount={n} />);

describe("SafeMarkdown (XSS fixtures)", () => {
  const XSS = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "![img](javascript:alert(1))",
    '<a href="javascript:alert(1)">x</a>',
    "<iframe src=//evil></iframe>",
    "[x](vbscript:msgbox(1))",
    '<svg onload="alert(1)">',
    "```\n</code><script>alert(1)</script>\n```",
  ];
  it.each(XSS)("neutralises %s", (t) => {
    const out = html(t);
    expect(out).not.toMatch(/<script|<img|<iframe|<svg|onerror="|onload="|href="(javascript|data|vbscript):/i);
  });

  it("renders headings, lists, emphasis, code and safe links with rel attributes; images become links", () => {
    const out = html(
      "## Title\n\n- **bold** and *em*\n- `code`\n\n1. one\n2. two\n\nSee [docs](https://example.com/a) and ![pic](https://example.com/p.png) [1] [9]",
      2,
    );
    expect(out).toContain("<h4");
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>em</em>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain('href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow"');
    expect(out).not.toContain("<img");
    expect(out).toContain('href="https://example.com/p.png"');
    expect(out).toContain('href="#report-source-1"');
    expect(out).not.toContain("#report-source-9");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://x.test/")).toBe("https://x.test/");
  });
});
