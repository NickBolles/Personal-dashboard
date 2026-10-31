import { inflateSync } from "node:zlib";

/**
 * Small PDF text extractor (no dependency): walks content streams (raw or
 * FlateDecode) and collects strings shown by Tj / TJ / ' / ". Good enough for
 * text PDFs from word processors and browsers; returns "" for scans and for
 * fonts with custom encodings, and the chat then says "text not extracted".
 */
export function extractPdfText(buf: Uint8Array, maxChars = 200_000): string {
  const data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") return "";
  const src = data.toString("latin1");
  const out: string[] = [];
  let total = 0;
  const streamRe = /<<([\s\S]{0,2000}?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = streamRe.exec(src)) && guard++ < 5000 && total < maxChars) {
    const dict = m[1]!;
    const start = m.index + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) break;
    streamRe.lastIndex = end + 9;
    // Skip images, fonts, xref/object streams: they never hold page text.
    if (/\/Subtype\s*\/Image|\/Type\s*\/(XRef|ObjStm|XObject)|\/Length1|\/FontFile/.test(dict)) continue;
    let body: Buffer = data.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        body = inflateSync(body, { finishFlush: 2 /* Z_SYNC_FLUSH: tolerate trailing EOL */ });
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue; // other filters (DCT, LZW, …) aren't text
    const text = textFromContent(body.toString("latin1"));
    if (text) {
      out.push(text);
      total += text.length;
    }
  }
  return out
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

/** Strings from text-showing operators inside BT … ET blocks. */
export function textFromContent(content: string): string {
  if (!/\bBT\b/.test(content)) return "";
  const lines: string[] = [];
  let line = "";
  const tokenRe = /\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|-?\d*\.?\d+|\/[^\s/<>[\]()]+|[A-Za-z'"*]+/g;
  let inArray = false;
  let pending: string[] = [];
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(content))) {
    const tok = t[0];
    if (tok === "[") {
      inArray = true;
      continue;
    }
    if (tok === "]") {
      inArray = false;
      continue;
    }
    if (tok.startsWith("(")) {
      pending.push(unescapePdfString(tok.slice(1, -1)));
      continue;
    }
    if (tok.startsWith("<") && tok !== "<<") {
      pending.push(hexString(tok.slice(1, -1)));
      continue;
    }
    if (inArray) {
      // A big negative kerning inside TJ is a word gap.
      if (/^-?\d/.test(tok) && Number(tok) < -200) pending.push(" ");
      continue;
    }
    if (tok === "Tj" || tok === "TJ" || tok === "'" || tok === '"') {
      if (tok === "'" || tok === '"') {
        lines.push(line);
        line = "";
      }
      line += pending.join("");
      pending = [];
    } else if (tok === "Td" || tok === "TD" || tok === "T*" || tok === "Tm" || tok === "ET") {
      if (line.trim()) lines.push(line);
      line = "";
      pending = [];
    } else if (/^[A-Za-z]/.test(tok)) pending = [];
  }
  if (line.trim()) lines.push(line);
  return lines
    .map((l) => l.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trimEnd())
    .filter((l) => l.trim())
    .join("\n");
}

function unescapePdfString(s: string): string {
  const raw = s.replace(/\\(\d{1,3}|\r?\n|[\s\S])/g, (_, e: string) => {
    if (/^\d/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    if (e === "\n" || e === "\r\n") return ""; // line continuation
    // Known escapes; any other escaped character stands for itself (PDF 32000 7.3.4.2).
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
  });
  return decodeBytes(raw);
}

function hexString(h: string): string {
  const clean = h.replace(/\s+/g, "");
  let s = "";
  for (let i = 0; i < clean.length; i += 2) s += String.fromCharCode(parseInt((clean.slice(i, i + 2) + "0").slice(0, 2), 16));
  return decodeBytes(s);
}

/** UTF-16BE (with BOM) or PDFDocEncoding ~ latin1. */
function decodeBytes(s: string): string {
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let r = "";
    for (let i = 2; i + 1 < s.length; i += 2) r += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return r;
  }
  return s;
}
