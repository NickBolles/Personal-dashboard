/**
 * Capture file checks (pure): magic-byte MIME sniffing and image dimensions.
 * Only PNG, JPEG, WebP, GIF and plain text are accepted; SVG/HTML never.
 */
export type SniffedMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "text/plain";

export function sniffMime(buf: Uint8Array): SniffedMime | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "image/webp";
  if (buf.length >= 6 && (ascii(buf, 0, 6) === "GIF87a" || ascii(buf, 0, 6) === "GIF89a")) return "image/gif";
  if (looksLikeText(buf)) return "text/plain";
  return null;
}

function ascii(buf: Uint8Array, at: number, n: number) {
  return String.fromCharCode(...buf.subarray(at, at + n));
}

/** UTF-8 without NULs or markup that a browser could sniff as HTML/SVG. */
function looksLikeText(buf: Uint8Array) {
  if (!buf.length) return false;
  if (buf.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, 64 * 1024));
  } catch {
    return false;
  }
  return !/^\s*<(\?xml|!doctype|html|svg|script)/i.test(text);
}

/** The declared type must agree with the sniffed one (image/jpg is accepted as image/jpeg). */
export function declaredMatches(declared: string | undefined, sniffed: SniffedMime) {
  const d = (declared ?? "").toLowerCase().split(";")[0]!.trim();
  if (!d || d === "application/octet-stream") return true;
  if (d === "image/jpg") return sniffed === "image/jpeg";
  if (d.startsWith("text/")) return sniffed === "text/plain" && d === "text/plain";
  return d === sniffed;
}

export function imageSize(buf: Uint8Array, mime: SniffedMime): { width: number; height: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    if (mime === "image/png" && buf.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (mime === "image/gif" && buf.length >= 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (mime === "image/webp" && buf.length >= 30) {
      const chunk = ascii(buf, 12, 4);
      if (chunk === "VP8X") return { width: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)), height: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) };
      if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const b = dv.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1]!;
        const len = dv.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}
