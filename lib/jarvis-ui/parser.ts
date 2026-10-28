import { FENCE, LIMITS } from "./catalog";

/**
 * Splits assistant text into markdown segments and ```jarvis-ui fenced
 * blocks. A block still open at the end (streaming) is reported with
 * `closed: false` so the renderer can show a placeholder instead of raw JSON.
 * Never throws, whatever the input (cut-off streams included).
 */
export type Segment = { kind: "text"; text: string } | { kind: "block"; index: number; raw: string; closed: boolean; tooLarge?: boolean };

const OPEN = new RegExp("^(`{3,}|~{3,})[ \\t]*" + FENCE + "[ \\t]*$");

export function splitBlocks(text: string): Segment[] {
  const out: Segment[] = [];
  if (!text) return out;
  const lines = text.split("\n");
  let buf: string[] = [];
  let block: { fence: string; lines: string[] } | null = null;
  let index = 0;
  const flushText = () => {
    if (buf.length) {
      const t = buf.join("\n");
      if (t.trim()) out.push({ kind: "text", text: t });
    }
    buf = [];
  };
  for (const line of lines) {
    if (!block) {
      const m = OPEN.exec(line.trimEnd());
      if (m && index < LIMITS.blocksPerMessage) {
        flushText();
        block = { fence: m[1]!, lines: [] };
      } else buf.push(line);
      continue;
    }
    const t = line.trim();
    if (t.startsWith(block.fence[0]!.repeat(block.fence.length)) && t.replace(new RegExp(`^\\${block.fence[0]}+`), "") === "") {
      const raw = block.lines.join("\n");
      out.push({ kind: "block", index: index++, raw, closed: true, ...(raw.length > LIMITS.blockBytes ? { tooLarge: true } : {}) });
      block = null;
    } else block.lines.push(line);
  }
  if (block) {
    const raw = block.lines.join("\n");
    out.push({ kind: "block", index: index++, raw, closed: false });
  }
  flushText();
  return out;
}

/** Does this text contain a smart block at all? (cheap check before parsing) */
export function hasBlock(text: string | undefined) {
  return Boolean(text && text.includes(FENCE));
}

/** Plain-text summary for clients without the renderer: the text outside the blocks. */
export function summaryText(text: string) {
  const segs = splitBlocks(text);
  const textOnly = segs
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text.trim())
    .join("\n\n");
  return segs.some((s) => s.kind === "block") ? `${textOnly}\n\n_Structured reply (open in Jarvis)_`.trim() : textOnly;
}
