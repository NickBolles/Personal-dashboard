import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { crc32, hasLocation, stripLocation } from "@/server/capture/exif";
import { imageSize, sniffMime } from "@/server/capture/sniff";
import { contains32, jpegWithGps, LAT_MARK, LON_MARK, pngChunk, pngWithGps, tiffWithGps, webpWithGps, XMP_NO_GPS, XMP_WITH_GPS } from "./fixtures/exif";

const tiffU16 = (b: Uint8Array, at: number, le = true) => new DataView(b.buffer, b.byteOffset).getUint16(at, le);

describe("stripLocation (pure)", () => {
  it("JPEG: zeroes the GPS IFD, removes its pointer, keeps Make/Orientation and the image bytes", () => {
    const src = jpegWithGps();
    expect(hasLocation(src, "image/jpeg")).toBe(true);
    const { bytes, changed } = stripLocation(src, "image/jpeg");
    expect(changed).toBe(true);
    expect(bytes.length).toBe(src.length); // scrubbed in place, no re-encode
    expect(contains32(bytes, LAT_MARK) || contains32(bytes, LON_MARK)).toBe(false);
    expect(hasLocation(bytes, "image/jpeg")).toBe(false);
    expect(sniffMime(bytes)).toBe("image/jpeg");
    const tiff = 2 + 2 + 2 + 6; // SOI, APP1 marker, length, "Exif\0\0"
    expect(tiffU16(bytes, tiff + 8)).toBe(3); // IFD0 lost exactly one entry
    const tags = [0, 1, 2].map((i) => tiffU16(bytes, tiff + 10 + i * 12));
    expect(tags).toEqual([0x010f, 0x0112, 0xc4a5]);
    expect(tiffU16(bytes, tiff + 10 + 12 + 8)).toBe(6); // Orientation intact
    expect(Buffer.from(bytes.subarray(-11)).equals(Buffer.from(src.subarray(-11)))).toBe(true); // scan data untouched
    // input not mutated
    expect(hasLocation(src, "image/jpeg")).toBe(true);
  });

  it("JPEG: drops XMP that carries GPS, keeps XMP without it; no GPS = untouched", () => {
    const withGps = stripLocation(jpegWithGps({ xmp: XMP_WITH_GPS }), "image/jpeg").bytes;
    expect(Buffer.from(withGps).includes("GPSLatitude")).toBe(false);
    const clean = stripLocation(jpegWithGps({ xmp: XMP_NO_GPS }), "image/jpeg").bytes;
    expect(Buffer.from(clean).includes("CreatorTool")).toBe(true);
    const plain = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xda, 0, 2, 1, 0xff, 0xd9]);
    const r = stripLocation(plain, "image/jpeg");
    expect(r.changed).toBe(false);
    expect(r.bytes).toBe(plain);
  });

  it("JPEG: an EXIF block that can't be walked safely is dropped whole", () => {
    const bad = tiffWithGps();
    new DataView(bad.buffer).setUint32(10 + 2 * 12 + 8, 0xfffffff0, true); // GPS pointer out of range
    const src = jpegWithGps({ tiff: bad });
    const { bytes, changed } = stripLocation(src, "image/jpeg");
    expect(changed).toBe(true);
    expect(Buffer.from(bytes).includes("Exif")).toBe(false);
    expect(contains32(bytes, LAT_MARK)).toBe(false);
    expect(sniffMime(bytes)).toBe("image/jpeg");
  });

  it("PNG: scrubs eXIf (big-endian TIFF) with a valid CRC and drops GPS XMP; dimensions stay", () => {
    const src = pngWithGps((b) => crc32(b), XMP_WITH_GPS);
    const { bytes, changed } = stripLocation(src, "image/png");
    expect(changed).toBe(true);
    expect(contains32(bytes, LAT_MARK) || contains32(bytes, LON_MARK)).toBe(false);
    expect(Buffer.from(bytes).includes("GPSLatitude")).toBe(false);
    expect(imageSize(bytes, "image/png")).toEqual({ width: 1, height: 1 });
    // every chunk CRC still checks out
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    for (let i = 8; i < bytes.length;) {
      const len = dv.getUint32(i);
      expect(dv.getUint32(i + 8 + len)).toBe(crc32(bytes, i + 4, i + 8 + len));
      i += 12 + len;
    }
  });

  it("PNG: compressed XMP (iTXt flag 1) is dropped, since it can't be checked without inflating", () => {
    const base = Buffer.from(
      stripLocation(
        pngWithGps((b) => crc32(b)),
        "image/png",
      ).bytes,
    );
    const xmp = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\x01\x00\0\0", "latin1"), zlib.deflateSync(Buffer.from(XMP_WITH_GPS))]);
    const chunk = Buffer.from(pngChunk("iTXt", Uint8Array.from(xmp), (b) => crc32(b)));
    const src = Uint8Array.from(Buffer.concat([base.subarray(0, 33), chunk, base.subarray(33)]));
    const { bytes, changed } = stripLocation(src, "image/png");
    expect(changed).toBe(true);
    expect(Buffer.from(bytes).includes("XML:com.adobe.xmp")).toBe(false);
    expect(bytes.length).toBe(src.length - chunk.length);
  });

  it("WebP: scrubs EXIF, drops GPS XMP, fixes the RIFF size and VP8X flags", () => {
    const src = webpWithGps(XMP_WITH_GPS);
    const { bytes, changed } = stripLocation(src, "image/webp");
    expect(changed).toBe(true);
    expect(contains32(bytes, LAT_MARK)).toBe(false);
    expect(Buffer.from(bytes).includes("XMP ")).toBe(false);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getUint32(4, true)).toBe(bytes.length - 8);
    expect(bytes[20]! & 0x04).toBe(0); // XMP flag cleared
    expect(bytes[20]! & 0x08).toBe(0x08); // EXIF kept (scrubbed)
    expect(sniffMime(bytes)).toBe("image/webp");
  });

  it("GIF, text and garbage are returned as is", () => {
    const gif = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
    expect(stripLocation(gif, "image/gif")).toEqual({ bytes: gif, changed: false });
    const junk = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
    expect(stripLocation(junk, "image/jpeg").changed).toBe(false);
  });
});
