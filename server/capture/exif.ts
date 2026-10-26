/**
 * Remove location from captured photos (owner decision 2026-10-25: optional, off by
 * default; Settings → AI → Captures → "Remove location from captured photos").
 *
 * Pure byte surgery, no re-encode: pixels, orientation, colour profile and the rest
 * of the metadata stay as sent. What goes:
 * - the EXIF GPS IFD (tag 0x8825) in JPEG APP1 "Exif", PNG `eXIf` and WebP `EXIF`:
 *   the IFD and its values are zeroed and its pointer is removed from IFD0. If the
 *   TIFF structure can't be walked safely, the whole EXIF block is dropped instead.
 * - XMP packets that mention GPS (JPEG APP1 XMP / extended XMP, PNG iTXt
 *   `XML:com.adobe.xmp`, PNG text "Raw profile type exif/xmp", WebP `XMP `).
 * GIF carries no location metadata. HEIC isn't an accepted capture type.
 */

export type StripResult = { bytes: Uint8Array; changed: boolean };

const GPS_TAG = 0x8825;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const XMP_GPS = /GPS(Latitude|Longitude|Altitude|Position|DestLatitude|DestLongitude|Coordinates)|exif:GPS|exifEX:GPS/i;

export function stripLocation(input: Uint8Array, mime: string): StripResult {
  try {
    if (mime === "image/jpeg") return stripJpeg(input);
    if (mime === "image/png") return stripPng(input);
    if (mime === "image/webp") return stripWebp(input);
  } catch {
    /* malformed: fall through, keep the bytes as sent */
  }
  return { bytes: input, changed: false };
}

/** True when an image still carries GPS coordinates we know how to find (tests, diagnostics). */
export function hasLocation(input: Uint8Array, mime: string): boolean {
  const copy = new Uint8Array(input);
  return stripLocation(copy, mime).changed;
}

// --- TIFF (EXIF) ---

type Tiff = { buf: Uint8Array; start: number; end: number; le: boolean };

function u16(t: Tiff, at: number) {
  if (at < t.start || at + 2 > t.end) throw new RangeError("tiff");
  return t.le ? t.buf[at]! | (t.buf[at + 1]! << 8) : (t.buf[at]! << 8) | t.buf[at + 1]!;
}
function u32(t: Tiff, at: number) {
  if (at < t.start || at + 4 > t.end) throw new RangeError("tiff");
  const b = t.buf;
  return t.le
    ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
    : ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}
function w16(t: Tiff, at: number, v: number) {
  if (t.le) {
    t.buf[at] = v & 0xff;
    t.buf[at + 1] = (v >> 8) & 0xff;
  } else {
    t.buf[at] = (v >> 8) & 0xff;
    t.buf[at + 1] = v & 0xff;
  }
}
function zero(t: Tiff, from: number, len: number) {
  if (from < t.start || from + len > t.end) throw new RangeError("tiff");
  t.buf.fill(0, from, from + len);
}

/**
 * Scrub the GPS IFD of a TIFF block in place (buf[start, end)).
 * Returns "none" (no GPS), "scrubbed", or throws when the structure can't be walked.
 */
function scrubTiffGps(buf: Uint8Array, start: number, end: number): "none" | "scrubbed" {
  if (end - start < 8) throw new RangeError("tiff");
  const order = String.fromCharCode(buf[start]!, buf[start + 1]!);
  if (order !== "II" && order !== "MM") throw new RangeError("tiff");
  const t: Tiff = { buf, start, end, le: order === "II" };
  if (u16(t, start + 2) !== 42) throw new RangeError("tiff");
  const ifd0 = start + u32(t, start + 4);
  const n = u16(t, ifd0);
  if (n > 1000) throw new RangeError("tiff");
  let gpsIndex = -1;
  for (let i = 0; i < n; i++) if (u16(t, ifd0 + 2 + i * 12) === GPS_TAG) gpsIndex = i;
  if (gpsIndex < 0) return "none";
  const entry = ifd0 + 2 + gpsIndex * 12;
  const gps = start + u32(t, entry + 8);
  // Zero the GPS IFD's out-of-line values, then the IFD itself.
  const m = u16(t, gps);
  if (m > 1000) throw new RangeError("tiff");
  for (let i = 0; i < m; i++) {
    const e = gps + 2 + i * 12;
    const size = (TYPE_SIZE[u16(t, e + 2)] ?? 1) * u32(t, e + 4);
    if (size > 4) zero(t, start + u32(t, e + 8), size);
  }
  zero(t, gps, 2 + m * 12 + 4);
  // Remove the pointer from IFD0: shift later entries up, keep the next-IFD offset right after them.
  const nextIfd = ifd0 + 2 + n * 12;
  if (nextIfd + 4 > end) throw new RangeError("tiff");
  buf.copyWithin(entry, entry + 12, nextIfd + 4);
  w16(t, ifd0, n - 1);
  // The next-IFD offset now sits at nextIfd-12; clear the 12 stale bytes after it.
  buf.fill(0, nextIfd - 8, nextIfd + 4);
  return "scrubbed";
}

/** Scrub, or report that the block must be dropped because it couldn't be walked. */
function scrubOrDrop(buf: Uint8Array, start: number, end: number): "none" | "scrubbed" | "drop" {
  const backup = buf.slice(start, end);
  try {
    return scrubTiffGps(buf, start, end);
  } catch {
    buf.set(backup, start);
    return "drop";
  }
}

// --- JPEG ---

const EXIF_HDR = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
const startsWith = (buf: Uint8Array, at: number, sig: number[] | string) => {
  const s = typeof sig === "string" ? Array.from(sig, (c) => c.charCodeAt(0)) : sig;
  if (at + s.length > buf.length) return false;
  for (let i = 0; i < s.length; i++) if (buf[at + i] !== s[i]) return false;
  return true;
};
const latin1 = (buf: Uint8Array, from: number, to: number) => Buffer.from(buf.buffer, buf.byteOffset + from, Math.max(0, to - from)).toString("latin1");

function stripJpeg(input: Uint8Array): StripResult {
  if (input[0] !== 0xff || input[1] !== 0xd8) return { bytes: input, changed: false };
  const buf = new Uint8Array(input); // copy: scrub in place
  const keep: [number, number][] = [];
  let changed = false;
  let i = 2;
  let from = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan: entropy-coded data follows
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    const segEnd = i + 2 + len;
    if (len < 2 || segEnd > buf.length) break;
    let drop = false;
    if (marker === 0xe1) {
      const p = i + 4;
      if (startsWith(buf, p, EXIF_HDR)) {
        const r = scrubOrDrop(buf, p + 6, segEnd);
        if (r === "scrubbed") changed = true;
        if (r === "drop") drop = true;
      } else if (startsWith(buf, p, "http://ns.adobe.com/xap/1.0/") || startsWith(buf, p, "http://ns.adobe.com/xmp/extension/")) {
        drop = XMP_GPS.test(latin1(buf, p, segEnd));
      }
    }
    if (drop) {
      keep.push([from, i]);
      from = segEnd;
      changed = true;
    }
    i = segEnd;
  }
  if (!changed) return { bytes: input, changed: false };
  keep.push([from, buf.length]);
  return { bytes: concat(buf, keep), changed: true };
}

// --- PNG ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array, from = 0, to = buf.length) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

function stripPng(input: Uint8Array): StripResult {
  const buf = new Uint8Array(input);
  const keep: [number, number][] = [];
  let changed = false;
  let i = 8;
  let from = 0;
  while (i + 12 <= buf.length) {
    const len = be32(buf, i);
    const type = latin1(buf, i + 4, i + 8);
    const dataStart = i + 8;
    const end = dataStart + len + 4;
    if (end > buf.length) break;
    let drop = false;
    if (type === "eXIf") {
      const off = startsWith(buf, dataStart, EXIF_HDR) ? 6 : 0;
      const r = scrubOrDrop(buf, dataStart + off, dataStart + len);
      if (r === "scrubbed") {
        const c = crc32(buf, i + 4, dataStart + len);
        buf[dataStart + len] = c >>> 24;
        buf[dataStart + len + 1] = (c >>> 16) & 0xff;
        buf[dataStart + len + 2] = (c >>> 8) & 0xff;
        buf[dataStart + len + 3] = c & 0xff;
        changed = true;
      }
      if (r === "drop") drop = true;
    } else if (type === "iTXt" || type === "tEXt" || type === "zTXt") {
      const nul = buf.indexOf(0, dataStart);
      const keyword = nul > dataStart && nul < dataStart + len ? latin1(buf, dataStart, nul) : "";
      // Compressed XMP (zTXt, or iTXt with compression flag 1) can't be checked cheaply: drop it.
      const compressed = type === "zTXt" || (type === "iTXt" && buf[nul + 1] === 1);
      if (keyword === "XML:com.adobe.xmp") drop = compressed || XMP_GPS.test(latin1(buf, dataStart, dataStart + len));
      else if (/^Raw profile type (exif|xmp|APP1)$/i.test(keyword)) drop = true; // ImageMagick hex dumps
    }
    if (drop) {
      keep.push([from, i]);
      from = end;
      changed = true;
    }
    if (type === "IEND") break;
    i = end;
  }
  if (!changed) return { bytes: input, changed: false };
  keep.push([from, buf.length]);
  return { bytes: concat(buf, keep), changed: true };
}

// --- WebP ---

const le32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

function stripWebp(input: Uint8Array): StripResult {
  const buf = new Uint8Array(input);
  const keep: [number, number][] = [];
  let changed = false;
  const dropped = { exif: false, xmp: false };
  let vp8x = -1;
  let i = 12;
  let from = 0;
  while (i + 8 <= buf.length) {
    const type = latin1(buf, i, i + 4);
    const len = le32(buf, i + 4);
    const dataStart = i + 8;
    const end = dataStart + len + (len & 1);
    if (dataStart + len > buf.length) break;
    let drop = false;
    if (type === "VP8X") vp8x = dataStart;
    if (type === "EXIF") {
      const off = startsWith(buf, dataStart, EXIF_HDR) ? 6 : 0;
      const r = scrubOrDrop(buf, dataStart + off, dataStart + len);
      if (r === "scrubbed") changed = true;
      if (r === "drop") drop = dropped.exif = true;
    } else if (type === "XMP ") {
      if (XMP_GPS.test(latin1(buf, dataStart, dataStart + len))) drop = dropped.xmp = true;
    }
    if (drop) {
      keep.push([from, i]);
      from = Math.min(end, buf.length);
      changed = true;
    }
    i = end;
  }
  if (!changed) return { bytes: input, changed: false };
  keep.push([from, buf.length]);
  if (vp8x >= 0) buf[vp8x] = buf[vp8x]! & ~((dropped.exif ? 0x08 : 0) | (dropped.xmp ? 0x04 : 0));
  const out = concat(buf, keep);
  const size = out.length - 8;
  out[4] = size & 0xff;
  out[5] = (size >>> 8) & 0xff;
  out[6] = (size >>> 16) & 0xff;
  out[7] = (size >>> 24) & 0xff;
  return { bytes: out, changed: true };
}

function concat(buf: Uint8Array, ranges: [number, number][]) {
  const total = ranges.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [a, b] of ranges) {
    if (b <= a) continue;
    out.set(buf.subarray(a, b), at);
    at += b - a;
  }
  return out;
}
