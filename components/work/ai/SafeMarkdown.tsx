import { Fragment, type ReactNode } from "react";

/**
 * Minimal safe Markdown renderer for AI report bodies (spec §8.6, no new
 * dependency): headings, paragraphs, lists, emphasis, inline/fenced code,
 * http(s) links and `[n]` source markers. Raw HTML is shown as text, images
 * are rendered as plain links, and there is no dangerouslySetInnerHTML.
 */

export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const LINK_REL = "noopener noreferrer nofollow";

function inline(text: string, key: string, sourceCount: number): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code, image (as link), link, bold, italic, source marker.
  const re = /(`[^`]+`)|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|\[(\d{1,2})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[3] !== undefined) {
      const href = safeHref(m[3]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel={LINK_REL}>
            {m[2] || href}
          </a>
        ) : (
          m[0]
        ),
      );
    } else if (m[5] !== undefined) {
      const href = safeHref(m[5]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel={LINK_REL}>
            {m[4]}
          </a>
        ) : (
          m[4]
        ),
      );
    } else if (m[6]) out.push(<strong key={k}>{m[6]}</strong>);
    else if (m[7] || m[8]) out.push(<em key={k}>{m[7] ?? m[8]}</em>);
    else if (m[9]) {
      const n = Number(m[9]);
      out.push(
        n >= 1 && n <= sourceCount ? (
          <a key={k} href={`#report-source-${n}`} className="ai-cite" aria-label={`Source ${n}`}>
            [{n}]
          </a>
        ) : (
          m[0]
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function SafeMarkdown({ text, sourceCount = 0, className }: { text: string; sourceCount?: number; className?: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${b++}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={key} className="ai-pre">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(6, h[1]!.length + 2);
      const Tag = `h${level}` as "h3";
      blocks.push(
        <Tag key={key} className="ai-h">
          {inline(h[2]!, key, sourceCount)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key} className={ordered ? "ai-ol" : "ai-ul"}>
          {items.map((t, j) => (
            <li key={j}>{inline(t, `${key}-${j}`, sourceCount)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(
      <p key={key}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j ? <br /> : null}
            {inline(p, `${key}-${j}`, sourceCount)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={className ?? "ai-md"}>{blocks}</div>;
}
