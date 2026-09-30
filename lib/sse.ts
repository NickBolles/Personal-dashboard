/**
 * Minimal spec-compliant SSE frame parser. Handles frames with or without an
 * `event:` line, ignores comment lines (":"), and supports multi-line data.
 */
export type SseFrame = { id?: string; event?: string; data: string; retry?: number };

export class SseParser {
  private buffer = "";
  private frame: { id?: string; event?: string; data: string[]; retry?: number } = { data: [] };

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const out: SseFrame[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, idx);
      const nl = this.buffer[idx] === "\r" && this.buffer[idx + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(idx + nl);
      const f = this.line(line);
      if (f) out.push(f);
    }
    return out;
  }

  /** Flush a final frame when the stream ends without a trailing blank line. */
  end(): SseFrame[] {
    const out: SseFrame[] = [];
    if (this.buffer) {
      const f = this.line(this.buffer);
      this.buffer = "";
      if (f) out.push(f);
    }
    const f = this.line("");
    if (f) out.push(f);
    return out;
  }

  private line(line: string): SseFrame | undefined {
    if (line === "") {
      if (!this.frame.data.length && this.frame.event === undefined) {
        this.frame = { data: [] };
        return undefined;
      }
      const f: SseFrame = { data: this.frame.data.join("\n") };
      if (this.frame.id !== undefined) f.id = this.frame.id;
      if (this.frame.event !== undefined) f.event = this.frame.event;
      if (this.frame.retry !== undefined) f.retry = this.frame.retry;
      this.frame = { data: [] };
      return f;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.frame.data.push(value);
    else if (field === "event") this.frame.event = value;
    else if (field === "id") this.frame.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.frame.retry = Number(value);
    return undefined;
  }
}

export function formatSse(data: unknown, opts: { id?: string | number; event?: string } = {}) {
  let s = "";
  if (opts.id !== undefined) s += `id: ${opts.id}\n`;
  if (opts.event) s += `event: ${opts.event}\n`;
  s += `data: ${JSON.stringify(data)}\n\n`;
  return s;
}
