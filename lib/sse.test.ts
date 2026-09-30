import { describe, expect, it } from "vitest";
import { formatSse, SseParser } from "./sse";

describe("SseParser", () => {
  it("handles chunk boundaries, CRLF, comments and multi-line data", () => {
    const p = new SseParser();
    const out = [...p.push(": hi\r\nid: 1\r\ndata: a"), ...p.push("\r\ndata: b\r\n\r\nevent: done\ndata: {}\n"), ...p.push("\n")];
    expect(out).toEqual([
      { id: "1", data: "a\nb" },
      { event: "done", data: "{}" },
    ]);
  });
  it("flushes a trailing frame at end of stream", () => {
    const p = new SseParser();
    expect(p.push("data: x")).toEqual([]);
    expect(p.end()).toEqual([{ data: "x" }]);
  });
  it("round-trips formatSse", () => {
    const p = new SseParser();
    expect(p.push(formatSse({ a: 1 }, { id: 7, event: "e" }))).toEqual([{ id: "7", event: "e", data: '{"a":1}' }]);
  });
});
