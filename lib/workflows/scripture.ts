/**
 * Pure, offline Scripture reference parser (Workflows spec §12.6).
 * No passage text, no network. Book table = 66 books with chapter counts
 * (Protestant canon, English versification) and common aliases.
 */

type Book = { name: string; chapters: number; aliases: string[] };

// [name, chapters, ...aliases]; aliases are normalised (lowercase, no spaces/periods).
const RAW: [string, number, ...string[]][] = [
  ["Genesis", 50, "gen", "ge", "gn"],
  ["Exodus", 40, "exod", "exo", "ex"],
  ["Leviticus", 27, "lev", "le", "lv"],
  ["Numbers", 36, "num", "nu", "nm", "nb"],
  ["Deuteronomy", 34, "deut", "de", "dt"],
  ["Joshua", 24, "josh", "jos", "jsh"],
  ["Judges", 21, "judg", "jdg", "jg", "jdgs"],
  ["Ruth", 4, "rth", "ru"],
  ["1 Samuel", 31, "1sam", "1sa", "1sm", "isamuel", "isam", "1s"],
  ["2 Samuel", 24, "2sam", "2sa", "2sm", "iisamuel", "iisam", "2s"],
  ["1 Kings", 22, "1kgs", "1ki", "1kin", "ikings", "ikgs", "1k"],
  ["2 Kings", 25, "2kgs", "2ki", "2kin", "iikings", "iikgs", "2k"],
  ["1 Chronicles", 29, "1chr", "1ch", "1chron", "ichronicles", "ichr"],
  ["2 Chronicles", 36, "2chr", "2ch", "2chron", "iichronicles", "iichr"],
  ["Ezra", 10, "ezr", "ez"],
  ["Nehemiah", 13, "neh", "ne"],
  ["Esther", 10, "esth", "est", "es"],
  ["Job", 42, "jb"],
  ["Psalms", 150, "psalm", "ps", "psa", "pss", "psm", "pslm"],
  ["Proverbs", 31, "prov", "pro", "prv", "pr"],
  ["Ecclesiastes", 12, "eccl", "ecc", "ec", "eccles", "qoh"],
  ["Song of Songs", 8, "songofsolomon", "song", "sos", "so", "canticles", "ss"],
  ["Isaiah", 66, "isa", "is"],
  ["Jeremiah", 52, "jer", "je", "jr"],
  ["Lamentations", 5, "lam", "la"],
  ["Ezekiel", 48, "ezek", "eze", "ezk"],
  ["Daniel", 12, "dan", "da", "dn"],
  ["Hosea", 14, "hos", "ho"],
  ["Joel", 3, "jl"],
  ["Amos", 9, "am"],
  ["Obadiah", 1, "obad", "ob"],
  ["Jonah", 4, "jnh", "jon"],
  ["Micah", 7, "mic", "mc"],
  ["Nahum", 3, "nah", "na"],
  ["Habakkuk", 3, "hab", "hb"],
  ["Zephaniah", 3, "zeph", "zep", "zp"],
  ["Haggai", 2, "hag", "hg"],
  ["Zechariah", 14, "zech", "zec", "zc"],
  ["Malachi", 4, "mal", "ml"],
  ["Matthew", 28, "matt", "mt", "mat"],
  ["Mark", 16, "mrk", "mk", "mar", "mr"],
  ["Luke", 24, "luk", "lk"],
  ["John", 21, "jn", "jhn", "joh"],
  ["Acts", 28, "act", "ac"],
  ["Romans", 16, "rom", "ro", "rm"],
  ["1 Corinthians", 16, "1cor", "1co", "icorinthians", "icor", "1corinthians"],
  ["2 Corinthians", 13, "2cor", "2co", "iicorinthians", "iicor", "2corinthians"],
  ["Galatians", 6, "gal", "ga"],
  ["Ephesians", 6, "eph", "ephes"],
  ["Philippians", 4, "phil", "php", "pp"],
  ["Colossians", 4, "col", "co"],
  ["1 Thessalonians", 5, "1thess", "1th", "1thes", "ithessalonians", "ithess"],
  ["2 Thessalonians", 3, "2thess", "2th", "2thes", "iithessalonians", "iithess"],
  ["1 Timothy", 6, "1tim", "1ti", "itimothy", "itim"],
  ["2 Timothy", 4, "2tim", "2ti", "iitimothy", "iitim"],
  ["Titus", 3, "tit", "ti"],
  ["Philemon", 1, "philem", "phm", "pm"],
  ["Hebrews", 13, "heb"],
  ["James", 5, "jas", "jm"],
  ["1 Peter", 5, "1pet", "1pe", "1pt", "ipeter", "ipet", "1p"],
  ["2 Peter", 3, "2pet", "2pe", "2pt", "iipeter", "iipet", "2p"],
  ["1 John", 5, "1jn", "1jhn", "1jo", "ijohn", "ijn"],
  ["2 John", 1, "2jn", "2jhn", "2jo", "iijohn", "iijn"],
  ["3 John", 1, "3jn", "3jhn", "3jo", "iiijohn", "iiijn"],
  ["Jude", 1, "jud", "jd"],
  ["Revelation", 22, "rev", "re", "revelations", "apocalypse"],
];

export const BOOKS: Book[] = RAW.map(([name, chapters, ...aliases]) => ({ name, chapters, aliases }));

const norm = (s: string) => s.toLowerCase().replace(/[.\s]/g, "");
const EXACT = new Map<string, Book>();
for (const b of BOOKS) {
  EXACT.set(norm(b.name), b);
  for (const a of b.aliases) EXACT.set(a, b);
}

/** Book lookup: exact name/alias, else unique prefix of a full name; ambiguous prefixes return candidates. */
export function findBook(raw: string): { book: Book } | { ambiguous: string[] } | null {
  const k = norm(raw)
    .replace(/^iii(?=[a-z])/, "3")
    .replace(/^ii(?=[a-z])/, "2")
    .replace(/^i(?=[a-z]{3,})(?!sa|s$)/, "1");
  const hit = EXACT.get(k) ?? EXACT.get(norm(raw));
  if (hit) return { book: hit };
  if (k.length < 2) return null;
  const pre = BOOKS.filter((b) => norm(b.name).startsWith(k));
  if (pre.length === 1) return { book: pre[0] };
  if (pre.length > 1) return { ambiguous: pre.map((b) => b.name) };
  return null;
}

export type ScriptureRef = { book: string; chapter: number; verseStart?: number; verseEnd?: number; chapterEnd?: number; display: string };
export type ScriptureParse =
  | { ok: true; ref: ScriptureRef }
  | { ok: false; error: "unparsed" | "unknown_book" | "chapter_out_of_range" | "bad_range"; message: string }
  | { ok: false; error: "ambiguous"; message: string; candidates: string[] };

const EN = "\u2013";

export function formatRef(r: Omit<ScriptureRef, "display">): string {
  const { book, chapter, verseStart, verseEnd, chapterEnd } = r;
  if (chapterEnd && chapterEnd !== chapter) {
    if (verseStart != null && verseEnd != null) return `${book} ${chapter}:${verseStart}${EN}${chapterEnd}:${verseEnd}`;
    return `${book} ${chapter}${EN}${chapterEnd}`;
  }
  if (verseStart == null) return `${book} ${chapter}`;
  if (verseEnd != null && verseEnd !== verseStart) return `${book} ${chapter}:${verseStart}${EN}${verseEnd}`;
  return `${book} ${chapter}:${verseStart}`;
}

// book part: optional leading 1/2/3/I/II/III, then letters/spaces/periods
const RE =
  /^\s*((?:[1-3]|i{1,3})?\s*[a-z][a-z.\s]*?)\s*\.?\s*(\d{1,3})(?:\s*[:.\s]\s*(\d{1,3}))?(?:\s*(?:[-\u2013\u2014,]|to)\s*(\d{1,3})(?:\s*:\s*(\d{1,3}))?)?\s*$/i;

/** Parse one reference: "John 15:5", "Jn 15 5", "jn15:5", "John 15:1-8", "John 15–16", "John 15:26–16:4", "Gal 5:22,23", "Ps 23". */
export function parseScriptureRef(input: string): ScriptureParse {
  const s = (input ?? "").trim().slice(0, 80);
  const m = RE.exec(s);
  if (!m) return { ok: false, error: "unparsed", message: "Couldn't read that reference" };
  const [, bookRaw, cRaw, vRaw, xRaw, yRaw] = m;
  const found = findBook(bookRaw);
  if (!found) return { ok: false, error: "unknown_book", message: `Unknown book "${bookRaw.trim()}"` };
  if ("ambiguous" in found)
    return { ok: false, error: "ambiguous", message: `"${bookRaw.trim()}" could be ${found.ambiguous.join(", ")}`, candidates: found.ambiguous };
  const book = found.book;
  const chapter = Number(cRaw);
  const chapterWord = book.chapters === 1 ? "chapter" : "chapters";
  const bound = (c: number) => c >= 1 && c <= book.chapters;
  let verseStart: number | undefined = vRaw ? Number(vRaw) : undefined;
  let verseEnd: number | undefined;
  let chapterEnd: number | undefined;
  // single-chapter books: "Jude 3" means verse 3
  if (book.chapters === 1 && verseStart == null && !xRaw && chapter > 1) return ok({ book: book.name, chapter: 1, verseStart: chapter });
  if (!bound(chapter)) return { ok: false, error: "chapter_out_of_range", message: `${book.name} has ${book.chapters} ${chapterWord}` };
  if (xRaw && yRaw) {
    chapterEnd = Number(xRaw);
    verseEnd = Number(yRaw);
    if (verseStart == null || !bound(chapterEnd) || chapterEnd < chapter) return { ok: false, error: "bad_range", message: "That range doesn't work" };
  } else if (xRaw) {
    const x = Number(xRaw);
    if (verseStart == null) {
      chapterEnd = x;
      if (!bound(x)) return { ok: false, error: "chapter_out_of_range", message: `${book.name} has ${book.chapters} ${chapterWord}` };
      if (x < chapter) return { ok: false, error: "bad_range", message: "That range doesn't work" };
    } else {
      verseEnd = x;
      if (x < verseStart) return { ok: false, error: "bad_range", message: "That range doesn't work" };
    }
  }
  if ((verseStart != null && verseStart < 1) || (verseEnd != null && verseEnd < 1))
    return { ok: false, error: "bad_range", message: "That range doesn't work" };
  return ok({ book: book.name, chapter, verseStart, verseEnd, chapterEnd });
}

function ok(r: Omit<ScriptureRef, "display">): ScriptureParse {
  const ref: ScriptureRef = { book: r.book, chapter: r.chapter, display: "" };
  if (r.verseStart != null) ref.verseStart = r.verseStart;
  if (r.verseEnd != null && r.verseEnd !== r.verseStart) ref.verseEnd = r.verseEnd;
  if (r.chapterEnd != null && r.chapterEnd !== r.chapter) ref.chapterEnd = r.chapterEnd;
  ref.display = formatRef(ref);
  return { ok: true, ref };
}
