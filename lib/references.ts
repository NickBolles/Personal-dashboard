/**
 * Composer references (phase 4): `@` for everything Jarvis knows (areas, work
 * items, conversations, people, devices, files & links), `#` for GitHub pull
 * requests and issues, `/` for commands. Client-safe and pure (unit tested).
 *
 * In a sent message a reference is a token `@[Label](type:id)` (or
 * `#[Label](gh:owner/repo#n)`); the timeline renders tokens as chips, and the
 * server resolves them into context snapshots (server/references.ts). The
 * composer shows the readable `@Label` while typing and encodes on send.
 */

export const REF_TYPES = ["area", "item", "chat", "person", "device", "file"] as const;
export type RefType = (typeof REF_TYPES)[number];
export type AnyRefType = RefType | "gh";

export const REF_TYPE_LABELS: Record<RefType, string> = {
  area: "Areas",
  item: "Work",
  chat: "Conversations",
  person: "People",
  device: "Devices",
  file: "Files & links",
};

/** `@chat:` style filters, including a few forgiving aliases. */
const FILTER_ALIASES: Record<string, RefType> = {
  area: "area",
  areas: "area",
  item: "item",
  work: "item",
  task: "item",
  chat: "chat",
  conv: "chat",
  conversation: "chat",
  person: "person",
  people: "person",
  who: "person",
  device: "device",
  dev: "device",
  entity: "device",
  file: "file",
  files: "file",
  link: "file",
  doc: "file",
};

export type RefOption = { type: AnyRefType; id: string; label: string; detail?: string };
export type RefSection = { type: AnyRefType; label: string; options: RefOption[] };
export type RefOptionsResponse = { sections: RefSection[]; partial: string[] };

export type Reference = { type: AnyRefType; id: string; label: string };

/** "chat:standup" → { type: "chat", q: "standup" }; "standup" → { q: "standup" }. */
export function parseRefQuery(raw: string): { type?: RefType; q: string } {
  const m = raw.match(/^([a-z]+):(.*)$/i);
  if (m) {
    const t = FILTER_ALIASES[m[1]!.toLowerCase()];
    if (t) return { type: t, q: m[2]!.trim() };
  }
  return { q: raw.trim() };
}

const clean = (s: string) =>
  s
    .replace(/[[\]()\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

export function encodeRef(r: Reference) {
  const label = clean(r.label) || r.id;
  return r.type === "gh" ? `#[${label}](gh:${r.id})` : `@[${label}](${r.type}:${r.id})`;
}

/** What the composer shows while typing (the token is written on send). */
export function displayRef(r: Reference) {
  return `${r.type === "gh" ? "#" : "@"}${clean(r.label) || r.id}`;
}

const TOKEN = /([@#])\[([^\]\n]{1,80})\]\((area|item|chat|person|device|file|gh):([A-Za-z0-9_.:/#@+-]{1,200})\)/g;

/** Every reference token in a message, de-duplicated, in order. */
export function parseReferences(text: string, max = 20): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const sigil = m[1]!;
    const type = m[3] as AnyRefType;
    if ((sigil === "#") !== (type === "gh")) continue;
    const key = `${type}:${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id: m[4]!, label: m[2]! });
    if (out.length >= max) break;
  }
  return out;
}

/** A message split into text and reference parts, for rendering chips. */
export function splitReferences(text: string): ({ text: string } | { ref: Reference })[] {
  const parts: ({ text: string } | { ref: Reference })[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const type = m[3] as AnyRefType;
    if ((m[1] === "#") !== (type === "gh")) continue;
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ ref: { type, id: m[4]!, label: m[2]! } });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Replace the readable `@Label` / `#Label` of each picked reference with its
 * token (first occurrence still in the text; references whose text was
 * deleted are dropped).
 */
export function encodeMessage(text: string, picked: Reference[]): { text: string; refs: Reference[] } {
  let out = text;
  const refs: Reference[] = [];
  for (const r of picked) {
    const shown = displayRef(r);
    const i = out.indexOf(shown);
    if (i < 0) continue;
    out = out.slice(0, i) + encodeRef(r) + out.slice(i + shown.length);
    refs.push(r);
  }
  return { text: out, refs };
}

export type Trigger = { sigil: "@" | "#" | "/"; query: string; start: number; end: number };

/**
 * The trigger being typed at the caret: `@…` or `#…` after a space or at the
 * start, `/…` only at the very start of the message. Null when there's none.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = before.match(/^\/([a-z]*)$/i);
  if (slash) return { sigil: "/", query: slash[1]!, start: 0, end: caret };
  const m = before.match(/(^|\s)([@#])([^\s@#]*(?::[^\s@#]*)?)$/);
  if (!m) return null;
  const start = caret - m[2]!.length - m[3]!.length;
  return { sigil: m[2] as "@" | "#", query: m[3]!, start, end: caret };
}

export const COMMANDS = [
  { id: "model", label: "/model", detail: "Choose the model for this conversation" },
  { id: "mode", label: "/mode", detail: "Switch Hermes ↔ Claude: starts a new conversation here" },
  { id: "file", label: "/file", detail: "File this conversation under an area" },
  { id: "handoff", label: "/handoff", detail: "Hand off into a new conversation" },
  { id: "fork", label: "/fork", detail: "Fork the latest state" },
  { id: "settle", label: "/settle", detail: "Settle this conversation's work" },
  { id: "share", label: "/share", detail: "Share with the household, or stop sharing" },
  { id: "new", label: "/new", detail: "New conversation in the same area" },
  { id: "context", label: "/context", detail: "Attach an action or alert as context" },
] as const;
export type CommandId = (typeof COMMANDS)[number]["id"];

/** Commands whose name starts with the query (then contains it). */
export function matchCommands(query: string) {
  const q = query.toLowerCase();
  return [...COMMANDS.filter((c) => c.id.startsWith(q)), ...COMMANDS.filter((c) => !c.id.startsWith(q) && c.id.includes(q))];
}
