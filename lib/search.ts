/** Global search (Ctrl K on the web, Search on the phone). */
export type SearchKind = "page" | "action" | "event" | "conversation" | "device" | "person" | "finance" | "setting";

export type SearchResult = {
  id: string;
  kind: SearchKind;
  /** module id (lib/modules.ts) or "jarvis" */
  module: string;
  title: string;
  /** never an amount or account detail */
  subtitle?: string;
  href: string;
};

export type SearchResponse = { query: string; results: SearchResult[]; partial: string[] };

/** All query words must appear; earlier and word-start matches rank higher. 0 = no match. */
export function matchScore(query: string, ...fields: (string | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const [title = "", ...rest] = fields.map((f) => (f ?? "").toLowerCase());
  const all = [title, ...rest].join(" \u0001 ");
  let score = 0;
  for (const w of words) {
    const i = all.indexOf(w);
    if (i === -1) return 0;
    const inTitle = title.indexOf(w);
    if (inTitle === 0) score += 6;
    else if (inTitle > 0) score += new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title) ? 4 : 2;
    else score += 1;
  }
  return score;
}
