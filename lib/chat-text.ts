/**
 * Display-only helpers for chat bubbles. Nothing here changes what is sent or stored.
 */

const LEADING_PUNCT = /^[.,;:!?)\]”’]/;

/**
 * Text copied from a web page or PDF often carries hard line breaks in the middle of a sentence
 * ("Forgiveness is about the\nPAST\n; trust is about the\nFUTURE\n."). When a message shows that
 * signature (a line that starts with punctuation), join single line breaks inside sentences so the
 * bubble wraps naturally. Blank lines (paragraphs) and list lines are kept, and messages without
 * the signature are returned untouched, so intentional line breaks ("Milk\nEggs") survive.
 */
export function unwrapBrokenLines(text: string): string {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  // Code or deliberately formatted text (fences, indentation, open brackets at line end): never reflow.
  if (text.includes("```") || lines.some((l) => /^(\t| {2,})\S/.test(l) || /[([{]\s*$/.test(l))) return text;
  if (!lines.slice(1).some((l) => LEADING_PUNCT.test(l.trim()))) return text;
  const out: string[] = [lines[0]!];
  for (let i = 1; i < lines.length; i++) {
    const prev = out[out.length - 1]!;
    const line = lines[i]!;
    const t = line.trim();
    const isList = /^([-*•]|\d+[.)])\s/.test(t);
    const sentenceEnded = /[.!?:]["”’)]?\s*$/.test(prev) && !LEADING_PUNCT.test(t);
    if (!t || !prev.trim() || isList || sentenceEnded) {
      out.push(line);
      continue;
    }
    out[out.length - 1] = LEADING_PUNCT.test(t) ? prev.replace(/\s+$/, "") + t : `${prev.replace(/\s+$/, "")} ${t}`;
  }
  return out.join("\n");
}

/** Show a centred time divider before a message when this much time passed since the previous one. */
export const TIME_GAP_MS = 5 * 60_000;

/** True when `at` should get a time divider (first timed message, or a gap over 5 minutes). */
export function needsTimeDivider(prevAt: string | undefined, at: string | undefined): boolean {
  if (!at) return false;
  const b = Date.parse(at);
  if (!Number.isFinite(b)) return false;
  if (!prevAt) return true;
  const a = Date.parse(prevAt);
  return !Number.isFinite(a) || b - a > TIME_GAP_MS;
}
