/** Synthetic images with EXIF GPS for the location-strip tests (no real photos in the repo). */

export const LAT_MARK = 0x0badf00d; // distinctive numerators so the tests can look for leftovers
export const LON_MARK = 0x0defaced;

/** A TIFF block: IFD0 = Make "Cam", Orientation 6, GPS pointer, a trailing tag; GPS IFD = LatRef N, Lat, Lon. */
export function tiffWithGps(le = true) {
  const b = new Uint8Array(200);
  const dv = new DataView(b.buffer);
  const w16 = (o: number, v: number) => dv.setUint16(o, v, le);
  const w32 = (o: number, v: number) => dv.setUint32(o, v, le);
  b[0] = b[1] = le ? 0x49 : 0x4d;
  w16(2, 42);
  w32(4, 8);
  // IFD0 at 8: 4 entries → ends at 8+2+48 = 58, next IFD offset at 58..62
  w16(8, 4);
  const entry = (i: number, tag: number, type: number, count: number, value: number | number[]) => {
    const o = 10 + i * 12;
    w16(o, tag);
    w16(o + 2, type);
    w32(o + 4, count);
    if (Array.isArray(value)) value.forEach((v, k) => (b[o + 8 + k] = v));
    else if (type === 3) w16(o + 8, value);
    else w32(o + 8, value);
  };
  entry(0, 0x010f, 2, 4, [0x43, 0x61, 0x6d, 0]); // Make "Cam"
  entry(1, 0x0112, 3, 1, 6); // Orientation
  entry(2, 0x8825, 4, 1, 64); // GPS IFD pointer
  entry(3, 0xc4a5, 7, 4, [1, 2, 3, 4]); // PrintIM-ish, after the GPS entry
  w32(58, 0);
  // GPS IFD at 64: 3 entries → 64+2+36 = 102, next 102..106; rationals at 110 and 134
  w16(64, 3);
  const g = (i: number, tag: number, type: number, count: number, value: number | number[]) => {
    const o = 66 + i * 12;
    w16(o, tag);
    w16(o + 2, type);
    w32(o + 4, count);
    if (Array.isArray(value)) value.forEach((v, k) => (b[o + 8 + k] = v));
    else w32(o + 8, value);
  };
  g(0, 0x0001, 2, 2, [0x4e, 0]); // GPSLatitudeRef "N"
  g(1, 0x0002, 5, 3, 110); // GPSLatitude
  g(2, 0x0004, 5, 3, 134); // GPSLongitude
  w32(102, 0);
  for (let k = 0; k < 3; k++) {
    w32(110 + k * 8, LAT_MARK);
    w32(114 + k * 8, 1);
    w32(134 + k * 8, LON_MARK);
    w32(138 + k * 8, 1);
  }
  return b;
}

const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];

export function jpegWithGps(opts: { xmp?: string; tiff?: Uint8Array } = {}) {
  const tiff = opts.tiff ?? tiffWithGps();
  const exif = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  const parts: number[] = [0xff, 0xd8, 0xff, 0xe1, ...be16(exif.length + 2), ...exif];
  if (opts.xmp) {
    const x = [...Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), ...Buffer.from(opts.xmp, "utf8")];
    parts.push(0xff, 0xe1, ...be16(x.length + 2), ...x);
  }
  // DQT-ish dummy segment, then SOS + a few "entropy" bytes + EOI
  parts.push(0xff, 0xdb, 0x00, 0x04, 0x00, 0x00);
  parts.push(0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9);
  return Uint8Array.from(parts);
}

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export function pngChunk(type: string, data: Uint8Array, crc: (b: Uint8Array) => number) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, "latin1"), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

/** 1×1 PNG with an eXIf chunk (and optionally an XMP iTXt) after IHDR. */
export function pngWithGps(crc: (b: Uint8Array) => number, xmp?: string) {
  const ihdrEnd = 8 + 25;
  const extra = [pngChunk("eXIf", tiffWithGps(false), crc)];
  if (xmp) extra.push(pngChunk("iTXt", Uint8Array.from(Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${xmp}`, "latin1")), crc));
  return Uint8Array.from(Buffer.concat([PNG_1x1.subarray(0, ihdrEnd), ...extra.map((c) => Buffer.from(c)), PNG_1x1.subarray(ihdrEnd)]));
}

const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const riffChunk = (type: string, data: number[]) => [...Buffer.from(type, "latin1"), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];

/** Extended WebP: VP8X (EXIF+XMP flags) + a dummy VP8L + EXIF + XMP chunks. */
export function webpWithGps(xmp: string, tiff = tiffWithGps()) {
  const body = [
    ...Buffer.from("WEBP", "latin1"),
    ...riffChunk("VP8X", [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ...riffChunk("VP8L", [0x2f, 0, 0, 0, 0]),
    ...riffChunk("EXIF", [...tiff]),
    ...riffChunk("XMP ", [...Buffer.from(xmp, "utf8")]),
  ];
  return Uint8Array.from([...Buffer.from("RIFF", "latin1"), ...le32(body.length), ...body]);
}

export const XMP_WITH_GPS = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="41,52.5N" exif:GPSLongitude="87,37.8W"/></rdf:RDF></x:xmpmeta>`;
export const XMP_NO_GPS = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="Camera"/></rdf:RDF></x:xmpmeta>`;

export function contains32(buf: Uint8Array, v: number) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i + 4 <= buf.length; i++) if (dv.getUint32(i, true) === v || dv.getUint32(i, false) === v) return true;
  return false;
}
