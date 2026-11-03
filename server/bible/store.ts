import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { config } from "@/server/config";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { processSingleton } from "@/server/singleton";
import { parseVpl, WEB_PACK_PIN, type BiblePack } from "@/lib/bible/web";

/**
 * #142 Offline WEB pack, stored in the data volume (`<data>/bible/`).
 * Opt-in: nothing is downloaded until the owner taps Download in Settings.
 * The download is the pinned eBible.org file; its SHA-256 must match the pin
 * BEFORE it is unzipped or parsed. The converted JSON's SHA-256 is recorded
 * in manifest.json and re-verified before the pack is loaded into memory.
 * Lookups never touch the network.
 *
 * Not in backups on purpose: the pack is public, pinned and re-downloadable.
 */

const MAX_DOWNLOAD = 12 * 1024 * 1024;

export type BibleManifest = {
  id: string;
  translation: string;
  version: string;
  sourceUrl: string;
  sourceSha256: string;
  packSha256: string;
  installedAt: string;
  verses: number;
};

export function sha256Hex(buf: Buffer | string) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Constant-format comparison of a buffer's SHA-256 against an expected hex digest. */
export function verifySha256(buf: Buffer, expected: string): boolean {
  return /^[0-9a-f]{64}$/i.test(expected) && sha256Hex(buf) === expected.toLowerCase();
}

/** The pin, with an e2e/test override that must set BOTH url and checksum. */
export function packSource() {
  const url = process.env.JARVIS_BIBLE_PACK_URL;
  const sha = process.env.JARVIS_BIBLE_PACK_SHA256;
  if (url && sha) return { ...WEB_PACK_PIN, url, sha256: sha.toLowerCase() };
  return WEB_PACK_PIN;
}

const dir = () => path.join(config.dataDir, "bible");
const files = () => ({ pack: path.join(dir(), "web.json"), manifest: path.join(dir(), "manifest.json") });

/** Minimal ZIP reader: one named entry via the central directory (stored or deflated). */
export function unzipEntry(zip: Buffer, name: string): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad zip directory");
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (entry === name) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("Bad zip entry");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 32 * 1024 * 1024 });
      throw new Error(`Unsupported zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} is missing from the download`);
}

const mem = processSingleton("bible_pack", () => ({ pack: null as BiblePack | null, sha: "" }));

function readManifest(): BibleManifest | null {
  try {
    return JSON.parse(fs.readFileSync(files().manifest, "utf8")) as BibleManifest;
  } catch {
    return null;
  }
}

export function bibleStatus() {
  const m = readManifest();
  const src = packSource();
  return {
    installed: Boolean(m),
    translation: src.translation,
    name: src.name,
    version: m?.version ?? src.version,
    pinnedSha256: src.sha256,
    sourceUrl: src.url,
    downloadBytes: src.bytes,
    installedAt: m?.installedAt ?? null,
    verses: m?.verses ?? 0,
  };
}

/** Load the installed pack, verifying the recorded checksum first. Null when not installed. */
export function loadPack(): BiblePack | null {
  const m = readManifest();
  if (!m) return null;
  if (mem.pack && mem.sha === m.packSha256) return mem.pack;
  let raw: Buffer;
  try {
    raw = fs.readFileSync(files().pack);
  } catch {
    return null;
  }
  if (!verifySha256(raw, m.packSha256))
    throw new HttpError(409, "bible_pack_corrupt", "The offline Bible pack failed its checksum. Remove it and download it again.");
  mem.pack = JSON.parse(raw.toString("utf8")) as BiblePack;
  mem.sha = m.packSha256;
  return mem.pack;
}

/** Opt-in download → checksum → unzip → convert → write atomically. */
export async function installPack(fetchImpl: typeof fetch = fetch): Promise<BibleManifest> {
  const src = packSource();
  let res: Response;
  try {
    res = await fetchImpl(src.url, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
  } catch (err) {
    throw new UpstreamError("eBible.org", "unreachable", `Couldn't download the Bible pack (${(err as Error).message})`);
  }
  if (!res.ok) throw new UpstreamError("eBible.org", "bad_response", `Couldn't download the Bible pack (HTTP ${res.status})`, res.status);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_DOWNLOAD) throw new UpstreamError("eBible.org", "bad_response", "The Bible pack download is unexpectedly large");
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_DOWNLOAD) throw new UpstreamError("eBible.org", "bad_response", "The Bible pack download is unexpectedly large");
  if (!verifySha256(zip, src.sha256))
    throw new HttpError(
      409,
      "bible_checksum_mismatch",
      `The downloaded file doesn't match the pinned checksum for ${src.name} ${src.version}. Nothing was installed.`,
    );
  const text = unzipEntry(zip, src.entry).toString("utf8");
  const pack = parseVpl(text, { source: src.id, version: src.version, translation: src.translation });
  const json = Buffer.from(JSON.stringify(pack), "utf8");
  const manifest: BibleManifest = {
    id: src.id,
    translation: src.translation,
    version: src.version,
    sourceUrl: src.url,
    sourceSha256: src.sha256,
    packSha256: sha256Hex(json),
    installedAt: new Date().toISOString(),
    verses: pack.books.reduce((n, b) => n + b.reduce((m, c) => m + c.filter(Boolean).length, 0), 0),
  };
  fs.mkdirSync(dir(), { recursive: true });
  const f = files();
  fs.writeFileSync(`${f.pack}.tmp`, json);
  fs.renameSync(`${f.pack}.tmp`, f.pack);
  fs.writeFileSync(`${f.manifest}.tmp`, JSON.stringify(manifest, null, 2));
  fs.renameSync(`${f.manifest}.tmp`, f.manifest);
  mem.pack = pack;
  mem.sha = manifest.packSha256;
  return manifest;
}

/** Tests: drop the in-memory copy so the next load re-verifies the file. */
export function __forgetLoadedPack() {
  mem.pack = null;
  mem.sha = "";
}

export function removePack() {
  fs.rmSync(dir(), { recursive: true, force: true });
  mem.pack = null;
  mem.sha = "";
}
