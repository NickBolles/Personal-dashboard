import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  buildRunInput,
  classifyChatFile,
  fencedAttachment,
  formatBytes,
  parseFileMarkers,
  runInputText,
  validateBatch,
  CHAT_FILE_LIMITS,
} from "@/lib/chat-files";
import { extractPdfText, textFromContent } from "@/server/chat/pdf-text";
import { checkUpload } from "@/server/chat/files";
import { saveAiSettings } from "@/server/ai/settings";
import { contains32, jpegWithGps, LAT_MARK } from "./fixtures/exif";

const MB = 1024 * 1024;

describe("chat attachment validation", () => {
  it("accepts pictures, PDFs and text files with their own size limits", () => {
    expect(classifyChatFile("cat.jpg", "image/jpeg", 2 * MB)).toMatchObject({ ok: true, kind: "image" });
    expect(classifyChatFile("scan.pdf", "application/pdf", 20 * MB)).toMatchObject({ ok: true, kind: "pdf" });
    expect(classifyChatFile("notes.md", "", 1000)).toMatchObject({ ok: true, kind: "text" });
    expect(classifyChatFile("data.csv", "text/csv", 1000)).toMatchObject({ ok: true, kind: "text" });
    expect(classifyChatFile("cfg.json", "application/json", 1000)).toMatchObject({ ok: true, kind: "text" });
    expect(classifyChatFile("big.png", "image/png", 11 * MB)).toEqual({ ok: false, reason: "big.png is over 10 MB" });
    expect(classifyChatFile("big.pdf", "application/pdf", 26 * MB)).toEqual({ ok: false, reason: "big.pdf is over 25 MB" });
  });

  it("rejects programs, archives, markup and unknown types", () => {
    for (const [n, t] of [
      ["setup.exe", "application/x-msdownload"],
      ["photos.zip", "application/zip"],
      ["run.sh", "text/plain"],
      ["page.html", "text/html"],
      ["logo.svg", "image/svg+xml"],
      ["app.apk", ""],
      ["backup.tar.gz", "application/gzip"],
      ["clip.mov", "video/quicktime"],
      ["photo.heic", "image/heic"],
    ])
      expect(classifyChatFile(n!, t!, 100).ok, n).toBe(false);
  });

  it("caps a batch at 6 per message and reports each rejection", () => {
    const f = (name: string, type = "image/png", size = 100) => ({ name, type, size });
    const r = validateBatch([f("a.png"), f("x.exe", "application/octet-stream"), f("b.png"), f("c.png")], 4);
    expect(r.accepted.map((a) => a.file.name)).toEqual(["a.png", "b.png"]);
    expect(r.errors).toEqual(["x.exe: programs and archives can't be attached", `At most ${CHAT_FILE_LIMITS.perMessage} files per message`]);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * MB)).toBe("1.5 MB");
  });
});

describe("Hermes run input", () => {
  it("stays a plain string without images", () => {
    expect(buildRunInput("hello", [])).toBe("hello");
  });

  it("becomes one user message with text + image_url parts when pictures are attached", () => {
    const input = buildRunInput("what is this?", ["data:image/jpeg;base64,AAAA", "https://example.com/a.png"]);
    expect(input).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ]);
    expect(runInputText(input)).toBe("what is this?");
  });

  it("fences extracted text so it can't break out, and marks files for the bubble", () => {
    const block = fencedAttachment("notes.md", "a\n```\nb");
    expect(block.split("\n")[0]).toBe("Attached file: notes.md");
    expect(block).toContain("````text\na\n```\nb\n````");
    expect(parseFileMarkers("Attachments: jarvis-file:cf_abc123 jarvis-file:cf_def456 jarvis-file:cf_abc123")).toEqual(["cf_abc123", "cf_def456"]);
  });
});

function pdfWith(content: string, flate = true) {
  const body = flate ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${body.length}${flate ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1");
  return new Uint8Array(Buffer.concat([head, body, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]));
}

describe("PDF text extraction", () => {
  it("reads Tj/TJ strings from Flate and raw content streams", () => {
    const content = "BT /F1 12 Tf 72 720 Td (Invoice for the gutter repair) Tj 0 -14 Td [(Total) -400 (due:) -400 (\\$120)] TJ ET";
    expect(extractPdfText(pdfWith(content))).toBe("Invoice for the gutter repair\nTotal due: $120");
    expect(extractPdfText(pdfWith(content, false))).toContain("gutter repair");
  });

  it("decodes UTF-16 hex strings and returns empty for non-PDFs and scans", () => {
    expect(textFromContent("BT <FEFF00480069> Tj ET")).toBe("Hi");
    expect(extractPdfText(new TextEncoder().encode("not a pdf"))).toBe("");
    expect(extractPdfText(pdfWith("q 100 0 0 100 0 0 cm /Im1 Do Q"))).toBe("");
  });
});

describe("upload checks", () => {
  it("removes photo location when capture.stripLocation is on, keeps it when off", () => {
    saveAiSettings({ capture: { auto: "off", investigateMinConfidence: 0.6, stripLocation: false } });
    const kept = checkUpload({ name: "porch.jpg", type: "image/jpeg", bytes: jpegWithGps() });
    expect(kept.locationRemoved).toBe(false);
    expect(contains32(kept.bytes, LAT_MARK)).toBe(true);
    saveAiSettings({ capture: { auto: "off", investigateMinConfidence: 0.6, stripLocation: true } });
    const stripped = checkUpload({ name: "porch.jpg", type: "image/jpeg", bytes: jpegWithGps() });
    expect(stripped.locationRemoved).toBe(true);
    expect(contains32(stripped.bytes, LAT_MARK)).toBe(false);
  });

  it("checks magic bytes, refuses finance files and extracts text", () => {
    expect(() => checkUpload({ name: "x.png", type: "image/png", bytes: new TextEncoder().encode("hello") })).toThrow(/isn't a PNG/);
    expect(() => checkUpload({ name: "x.pdf", type: "application/pdf", bytes: new TextEncoder().encode("hello") })).toThrow(/isn't a PDF/);
    expect(() => checkUpload({ name: "monarch-export.csv", type: "text/csv", bytes: new TextEncoder().encode("a,b") })).toThrow(/Finance/);
    const t = checkUpload({ name: "list.csv", type: "text/csv", bytes: new TextEncoder().encode("item,qty\nmilk,2") });
    expect(t).toMatchObject({ kind: "text", text: "item,qty\nmilk,2", textStatus: "ok" });
    const p = checkUpload({ name: "scan.pdf", type: "application/pdf", bytes: pdfWith("q /Im1 Do Q") });
    expect(p).toMatchObject({ kind: "pdf", text: null, textStatus: "none" });
  });
});
