"use client";

import { Fragment, useState, type ReactNode } from "react";

/**
 * Safe Markdown for every Jarvis surface that shows model or user text: chat
 * messages, AI reports, work packets/handoffs. No dependency and no
 * dangerouslySetInnerHTML: the text is parsed into React elements, so raw HTML
 * is shown as text. Links are http(s)/mailto or same-origin paths only; images
 * render as links (no remote loads).
 *
 * Supported: ATX headings, paragraphs with hard line breaks (chat-style),
 * nested ordered/unordered lists, task lists, blockquotes (nested), fenced code
 * (language label + copy), GFM tables (scroll on narrow screens), rules, inline
 * code, bold, italic, strikethrough, links, autolinks, backslash escapes and
 * optional `[n]` source markers.
 */

const LINK_REL = "noopener noreferrer nofollow";

/** http(s) and mailto URLs; same-origin paths and anchors. Everything else is dropped. */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (/^(\/(?!\/)|#)/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

type Ctx = { sourceCount: number; headingOffset: number };

// ---------------------------------------------------------------- inline

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;

function link(href: string | null, label: ReactNode, key: string, fallback: ReactNode): ReactNode {
  if (!href) return <Fragment key={key}>{fallback}</Fragment>;
  const internal = href.startsWith("/") || href.startsWith("#");
  return internal ? (
    <a key={key} href={href}>
      {label}
    </a>
  ) : (
    <a key={key} href={href} target="_blank" rel={LINK_REL}>
      {label}
    </a>
  );
}

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

export function renderInline(text: string, key: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let n = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);
    const k = `${key}.${n++}`;
    let m: RegExpExecArray | null;

    if (c === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        let code = text.slice(i + run.length, end);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        push(<code key={k}>{code}</code>);
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (c === "!" && (m = /^!\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      const href = safeHref(m[2]!);
      push(link(href, m[1] || href, k, m[1] || ""));
      i += m[0].length;
      continue;
    }
    if (c === "[") {
      if ((m = /^\[((?:[^[\]]|\[[^\]]*\])+)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
        const label = renderInline(m[1]!, k, ctx);
        push(link(safeHref(m[2]!), label, k, label));
        i += m[0].length;
        continue;
      }
      if (ctx.sourceCount && (m = /^\[(\d{1,2})\]/.exec(rest))) {
        const num = Number(m[1]);
        if (num >= 1 && num <= ctx.sourceCount) {
          push(
            <a key={k} href={`#report-source-${num}`} className="ai-cite" aria-label={`Source ${num}`}>
              [{num}]
            </a>,
          );
          i += m[0].length;
          continue;
        }
      }
    }
    if (c === "<" && (m = /^<((?:https?:\/\/|mailto:)[^\s>]+)>/.exec(rest))) {
      push(link(safeHref(m[1]!), m[1], k, m[0]));
      i += m[0].length;
      continue;
    }
    if ((c === "h" || c === "H") && !isWord(text[i - 1]) && (m = /^https?:\/\/[^\s<>"]+/i.exec(rest))) {
      const url = m[0].replace(/[.,;:!?'")\]]+$/, "");
      push(link(safeHref(url), url, k, url));
      i += url.length;
      continue;
    }
    if (c === "~" && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      push(<del key={k}>{renderInline(m[1]!, k, ctx)}</del>);
      i += m[0].length;
      continue;
    }
    if (c === "*" || c === "_") {
      const leftOk = c === "*" || !isWord(text[i - 1]);
      const strong = c === "*" ? /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest) : /^__(?=\S)([\s\S]*?\S)__/.exec(rest);
      if (leftOk && strong && (c === "*" || !isWord(text[i + strong[0].length]))) {
        push(<strong key={k}>{renderInline(strong[1]!, k, ctx)}</strong>);
        i += strong[0].length;
        continue;
      }
      const em = c === "*" ? /^\*(?=[^\s*])((?:\*\*[^*]+\*\*|[^*])*?[^\s*])\*(?!\*)/.exec(rest) : /^_(?=\S)([^_]*?\S)_/.exec(rest);
      if (leftOk && em && (c === "*" || !isWord(text[i + em[0].length]))) {
        push(<em key={k}>{renderInline(em[1]!, k, ctx)}</em>);
        i += em[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Paragraph text: every newline is a visible line break (chat convention). */
function lines(text: string, key: string, ctx: Ctx): ReactNode[] {
  return text.split("\n").map((l, j) => (
    <Fragment key={j}>
      {j ? <br /> : null}
      {renderInline(l.replace(/ {2,}$|\\$/, ""), `${key}-${j}`, ctx)}
    </Fragment>
  ));
}

// ---------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?: +|$)(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function startsBlock(line: string, next: string | undefined) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_DELIM.test(next) && next.includes("-"))
  );
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < r.length; i++) {
    const ch = r[i]!;
    if (ch === "\\" && r[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const indentOf = (l: string) => /^ */.exec(l.replace(/\t/g, "    "))![0].length;

function parseBlocks(src: string[], key: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < src.length) {
    const line = src[i]!;
    const k = `${key}.${b++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = FENCE.exec(line))) {
      const fence = m[1]!;
      const lang = m[2] || "";
      const body: string[] = [];
      i++;
      while (i < src.length && !new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(src[i]!)) body.push(src[i++]!);
      i++; // closing fence (or end of a still-streaming message)
      out.push(<CodeBlock key={k} lang={lang} code={body.join("\n")} />);
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const level = Math.min(6, m[1]!.length + ctx.headingOffset);
      const Tag = `h${level}` as "h3";
      out.push(
        <Tag key={k} className="md-h ai-h" data-level={m[1]!.length}>
          {renderInline(m[2] ?? "", k, ctx)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push(<hr key={k} />);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < src.length && src[i]!.trim() && (QUOTE.test(src[i]!) || !startsBlock(src[i]!, src[i + 1]))) body.push(src[i++]!.replace(QUOTE, ""));
      out.push(<blockquote key={k}>{parseBlocks(body, k, ctx)}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < src.length && TABLE_DELIM.test(src[i + 1]!) && src[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(src[i + 1]!).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < src.length && src[i]!.trim() && src[i]!.includes("|")) rows.push(splitRow(src[i++]!));
      out.push(
        <div key={k} className="md-table" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j} style={align[j] ? { textAlign: align[j] } : undefined}>
                    {renderInline(h, `${k}h${j}`, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={align[j] ? { textAlign: align[j] } : undefined}>
                      {renderInline(r[j] ?? "", `${k}r${ri}c${j}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if ((m = ITEM.exec(line))) {
      const [list, next] = parseList(src, i, k, ctx);
      out.push(list);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < src.length && src[i]!.trim() && (!para.length || !startsBlock(src[i]!, src[i + 1]))) para.push(src[i++]!.trim());
    out.push(<p key={k}>{lines(para.join("\n"), k, ctx)}</p>);
  }
  return out;
}

function parseList(src: string[], start: number, key: string, ctx: Ctx): [ReactNode, number] {
  const first = ITEM.exec(src[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const startNum = ordered ? parseInt(first[2]!, 10) : 1;
  const items: { body: string[]; task: null | boolean }[] = [];
  let i = start;
  let loose = false;
  while (i < src.length) {
    const m = ITEM.exec(src[i]!);
    if (!m || m[1]!.length !== base || /\d/.test(m[2]!) !== ordered) break;
    const contentIndent = base + m[2]!.length + 1;
    let text = m[3] ?? "";
    let task: null | boolean = null;
    const t = /^\[([ xX])\]\s+/.exec(text);
    if (t) {
      task = t[1] !== " ";
      text = text.slice(t[0].length);
    }
    const body = [text];
    i++;
    while (i < src.length) {
      const l = src[i]!;
      if (!l.trim()) {
        // a blank line continues the item only when indented content follows
        const nxt = src.slice(i + 1).find((x) => x.trim());
        if (nxt !== undefined && indentOf(nxt) > base) {
          loose = true;
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind > base) {
        body.push(l.replace(/\t/g, "    ").slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      const im = ITEM.exec(l);
      if (im || startsBlock(l, src[i + 1])) break;
      body.push(l.trim()); // lazy continuation of the item's paragraph
      i++;
    }
    items.push({ body, task });
    // blank line(s) between sibling items
    let j = i;
    while (j < src.length && !src[j]!.trim()) j++;
    if (j > i && j < src.length) {
      const nm = ITEM.exec(src[j]!);
      if (nm && nm[1]!.length === base && /\d/.test(nm[2]!) === ordered) {
        loose = true;
        i = j;
      }
    }
  }
  const List = ordered ? "ol" : "ul";
  const node = (
    <List key={key} start={ordered && startNum !== 1 ? startNum : undefined} className={ordered ? "ai-ol" : "ai-ul"} data-loose={loose || undefined}>
      {items.map((it, j) => {
        const kids = parseBlocks(it.body, `${key}-${j}`, ctx);
        return (
          <li key={j} className={it.task !== null ? "md-task" : undefined}>
            {it.task !== null ? <input type="checkbox" checked={it.task} disabled readOnly aria-label={it.task ? "Done" : "Not done"} /> : null}
            {kids}
          </li>
        );
      })}
    </List>
  );
  return [node, i];
}

// ---------------------------------------------------------------- code

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context): the text stays selectable */
    }
  };
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || "code"}</span>
        <button type="button" onClick={copy} aria-label={copied ? "Copied" : `Copy ${lang || "code"}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="ai-pre">
        <code data-lang={lang || undefined}>{code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- entry

export function Markdown({
  text,
  sourceCount = 0,
  headingOffset = 2,
  className,
}: {
  text: string;
  /** `[n]` markers become links to `#report-source-n` up to this count */
  sourceCount?: number;
  /** `#` renders as h(1+offset): message headings sit under the page's own h1/h2 */
  headingOffset?: number;
  className?: string;
}) {
  const src = text.replace(/\r\n?/g, "\n").split("\n");
  return <div className={className ? `md ${className}` : "md"}>{parseBlocks(src, "m", { sourceCount, headingOffset })}</div>;
}
