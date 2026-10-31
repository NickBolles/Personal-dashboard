/**
 * Chat attachments (files & pictures), shared by the composer and the server.
 *
 * Images go to Hermes as `image_url` content parts. Hermes rejects file/document
 * parts, so PDFs and text files are extracted Jarvis-side and appended to the
 * message as fenced attachment blocks.
 */

export const CHAT_FILE_LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  perMessage: 6,
  /** extracted text per file that goes to the model */
  textChars: 40_000,
} as const;

/** `accept` for the composer file input (phones offer camera + photo library for image/*). */
export const CHAT_FILE_ACCEPT = "image/*,application/pdf,text/*,.md,.csv,.json";

export type ChatFileKind = "image" | "pdf" | "text";

export type ChatFileView = {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  kind: ChatFileKind;
  bytes: number;
  width: number | null;
  height: number | null;
  /** ok = text sent to the model; none = PDF without extractable text; truncated = cut at the limit */
  textStatus: "ok" | "none" | "truncated" | null;
  /** set once the file went out with a message */
  sentAt: string | null;
  createdAt: string;
  /** EXIF location was removed on upload */
  locationRemoved: boolean;
};

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|ics|vtt|srt)$/i;
/** Never accepted, whatever the browser says the type is. */
const BLOCKED_EXT =
  /\.(exe|msi|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|mjs|cjs|jar|apk|app|dmg|pkg|deb|rpm|sh|bash|zsh|bin|run|dll|so|dylib|elf|iso|img|zip|rar|7z|tar|gz|tgz|bz2|xz|zst|cab|lz|lzma|z|war|ear|whl|html?|svg|xhtml|hta|lnk|reg|wsf|cpl|msc|gadget|appimage|snap|flatpak|ipa|xapk|aab)$/i;
const BLOCKED_MIME =
  /^(application\/(x-msdownload|x-msdos-program|x-executable|x-elf|x-mach-binary|x-sh|x-bat|java-archive|vnd\.android\.package-archive|zip|x-zip-compressed|x-rar|x-rar-compressed|vnd\.rar|x-7z-compressed|x-tar|gzip|x-gzip|x-bzip2|x-xz|zstd|x-apple-diskimage|javascript|x-javascript|xhtml\+xml)|text\/(html|javascript)|image\/svg\+xml)$/i;

export type ClassifyResult = { ok: true; kind: ChatFileKind; limit: number } | { ok: false; reason: string };

/** Decide from name + declared type (the server re-checks magic bytes). */
export function classifyChatFile(name: string, type: string, bytes: number): ClassifyResult {
  const n = name || "file";
  const t = (type || "").toLowerCase().split(";")[0]!.trim();
  if (BLOCKED_EXT.test(n) || BLOCKED_MIME.test(t)) return { ok: false, reason: `${short(n)}: programs and archives can't be attached` };
  let kind: ChatFileKind | null = null;
  if (IMAGE_MIME.has(t) || (/^image\//.test(t) && /\.(png|jpe?g|webp|gif)$/i.test(n))) kind = "image";
  else if (t === "application/pdf" || /\.pdf$/i.test(n)) kind = "pdf";
  else if (t.startsWith("text/") || t === "application/json" || TEXT_EXT.test(n)) kind = "text";
  if (!kind) {
    if (/^image\//.test(t)) return { ok: false, reason: `${short(n)}: use a PNG, JPEG, WebP or GIF picture` };
    return { ok: false, reason: `${short(n)}: only pictures, PDFs and text files (txt, md, csv, json)` };
  }
  const limit = kind === "image" ? CHAT_FILE_LIMITS.imageBytes : CHAT_FILE_LIMITS.fileBytes;
  if (bytes > limit) return { ok: false, reason: `${short(n)} is over ${formatBytes(limit)}` };
  if (bytes === 0) return { ok: false, reason: `${short(n)} is empty` };
  return { ok: true, kind, limit };
}

/** Split a drop/paste/picker batch into accepted files and messages, honouring the per-message cap. */
export function validateBatch<F extends { name: string; type: string; size: number }>(
  files: F[],
  already: number,
): { accepted: { file: F; kind: ChatFileKind }[]; errors: string[] } {
  const accepted: { file: F; kind: ChatFileKind }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const c = classifyChatFile(f.name, f.type, f.size);
    if (!c.ok) {
      errors.push(c.reason);
      continue;
    }
    if (already + accepted.length >= CHAT_FILE_LIMITS.perMessage) {
      errors.push(`At most ${CHAT_FILE_LIMITS.perMessage} files per message`);
      break;
    }
    accepted.push({ file: f, kind: c.kind });
  }
  return { accepted, errors };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

const short = (n: string) => (n.length > 60 ? `${n.slice(0, 57)}…` : n);

// --- Message encoding ---

/** Hidden marker in the "Context from Jarvis" section so the bubble can show its attachments. */
export const FILE_MARK = "jarvis-file:";
const FILE_ID_RE = /jarvis-file:(cf_[A-Za-z0-9_-]{6,64})/g;

export function parseFileMarkers(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_ID_RE)].map((m) => m[1]!))];
}

/** Pick a fence longer than any backtick run inside the text, so attachments can't break out. */
export function fencedAttachment(name: string, text: string, note?: string): string {
  let fence = "```";
  const runs = text.match(/`{3,}/g) ?? [];
  for (const r of runs) if (r.length >= fence.length) fence = "`".repeat(r.length + 1);
  const safeName = name.replace(/[\r\n`]/g, " ").slice(0, 120);
  return [`Attached file: ${safeName}${note ? ` (${note})` : ""}`, `${fence}text`, text, fence].join("\n");
}

export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type TextPart = { type: "text"; text: string };
export type RunInput = string | { role: "user"; content: (TextPart | ImagePart)[] }[];

/**
 * Hermes `/v1/runs` input: a plain string unless the message carries images, then a
 * one-message list whose content is a text part followed by `image_url` parts
 * (Hermes reads `input[-1].content`).
 */
export function buildRunInput(text: string, imageUrls: string[]): RunInput {
  if (!imageUrls.length) return text;
  return [
    {
      role: "user",
      content: [{ type: "text", text: text || "(see the attached pictures)" }, ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } }))],
    },
  ];
}

/** Text of a run input, for previews and logs. */
export function runInputText(input: RunInput): string {
  if (typeof input === "string") return input;
  const last = input[input.length - 1];
  return (last?.content ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}
