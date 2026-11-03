/**
 * #142 Offline World English Bible pack (public domain, eBible.org `engwebp`).
 * Pure helpers: VPL text → pack JSON, and verse lookup for a parsed reference.
 * No network here; the server downloads the pinned file once (opt-in) and
 * verifies its SHA-256 before converting it.
 */
import { BOOKS, type ScriptureRef } from "@/lib/workflows/scripture";

/**
 * Pinned source. The zip is eBible.org's `engwebp_vpl.zip` of that version,
 * mirrored as a release asset of this repo (tag `bible-web-<version>`), so an
 * eBible.org republish can't break downloads (#172). The SHA-256 is still
 * checked before anything is installed. To move to a newer upload: publish a
 * new `bible-web-<version>` release with the file, then bump url/sha256/bytes.
 */
export const WEB_PACK_PIN = {
  id: "engwebp",
  translation: "WEB",
  name: "World English Bible",
  version: "2026-10-30",
  url: "https://github.com/NickBolles/Personal-dashboard/releases/download/bible-web-2026-10-30/engwebp_vpl.zip",
  /** where the mirrored file came from (attribution / provenance only; never fetched at runtime) */
  upstream: "https://ebible.org/Scriptures/engwebp_vpl.zip",
  sha256: "37a8ccecfbc765a2305ae64f3b5e88d1d01bafceb9a33e8d191f6ee551a437b9",
  entry: "engwebp_vpl.txt",
  bytes: 4283563,
} as const;

export const WEB_ATTRIBUTION = "World English Bible (WEB), public domain, from eBible.org. “World English Bible” is a trademark of eBible.org.";

/** books[bookIndex][chapter-1][verse-1] = text ("" for a verse the source omits). */
export type BiblePack = { v: 1; translation: string; source: string; version: string; books: string[][][] };

const LINE = /^([1-3]?[A-Z]{2,3}) (\d{1,3}):(\d{1,3}) (.*)$/;

/**
 * Parse eBible VPL text (`GEN 1:1 In the beginning…`). Books are in canonical
 * order, which matches the parser's BOOKS table; the result must have 66 books.
 */
export function parseVpl(text: string, meta: { source: string; version: string; translation: string }): BiblePack {
  const books: string[][][] = [];
  let code = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const [, b, c, v, t] = m;
    if (b !== code) {
      code = b;
      books.push([]);
    }
    const book = books[books.length - 1];
    const ci = Number(c) - 1;
    const vi = Number(v) - 1;
    while (book.length <= ci) book.push([]);
    const ch = book[ci];
    while (ch.length < vi) ch.push("");
    ch[vi] = t.trim();
  }
  if (books.length !== BOOKS.length) throw new Error(`Expected ${BOOKS.length} books, found ${books.length}`);
  return { v: 1, translation: meta.translation, source: meta.source, version: meta.version, books };
}

export type Verse = { chapter: number; verse: number; text: string };
export const MAX_VERSES = 200;

/** Verses for a parsed reference (whole chapter when no verse given), capped at MAX_VERSES. */
export function lookupPassage(
  pack: BiblePack,
  ref: Pick<ScriptureRef, "book" | "chapter" | "verseStart" | "verseEnd" | "chapterEnd">,
): { verses: Verse[]; truncated: boolean } {
  const bi = BOOKS.findIndex((b) => b.name === ref.book);
  const book = bi >= 0 ? pack.books[bi] : undefined;
  if (!book) return { verses: [], truncated: false };
  const lastCh = ref.chapterEnd ?? ref.chapter;
  const out: Verse[] = [];
  for (let c = ref.chapter; c <= lastCh; c++) {
    const ch = book[c - 1];
    if (!ch) break;
    const from = c === ref.chapter && ref.verseStart != null ? ref.verseStart : 1;
    let to = ch.length;
    if (c === lastCh && ref.verseStart != null) to = ref.verseEnd ?? (ref.chapterEnd ? ch.length : ref.verseStart);
    for (let v = from; v <= Math.min(to, ch.length); v++) {
      const text = ch[v - 1];
      if (text) out.push({ chapter: c, verse: v, text });
      if (out.length > MAX_VERSES) return { verses: out.slice(0, MAX_VERSES), truncated: true };
    }
  }
  return { verses: out, truncated: false };
}
